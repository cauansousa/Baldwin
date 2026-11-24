import {
  decodeEventLog,
  encodeFunctionData,
  ExecutionRevertedError,
  isAddressEqual,
  keccak256,
  TransactionReceiptNotFoundError,
  BaseError,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { exchangeAbi } from "../abi.ts";
import { errMessage, silentLogger, type Address, type Hex, type Logger, type Match } from "../types.ts";
import { BatchRevertedError, type Batch, type MatchResult, type Settler } from "./types.ts";

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface RpcReceipt {
  status: "success" | "reverted";
  logs: RpcLog[];
}

/** The few RPC calls the settler needs; narrow so the retry logic can be tested with a fake. */
export interface SettlerRpc {
  /** Transaction count of `address`: "pending" includes the mempool, "latest" only mined ones. */
  getNonce(address: Address, tag: "pending" | "latest"): Promise<number>;
  /** Must reject with BatchRevertedError if the call would revert. */
  estimateGas(tx: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(raw: Hex): Promise<void>;
  /** null while the transaction is not mined. */
  getReceipt(hash: Hex): Promise<RpcReceipt | null>;
  /** `Exchange.filledSize(orderHash)` at the latest block. */
  filledSize(orderHash: Hex): Promise<bigint>;
}

export interface ViemSettlerOptions {
  rpc: SettlerRpc;
  /** Operator account; signs locally so the transaction hash is known before broadcast. */
  account: LocalAccount;
  chainId: number;
  exchange: Address;
  logger?: Logger;
  /** How long to wait for a receipt before re-broadcasting. Default 30000. */
  receiptTimeoutMs?: number;
  /** Receipt poll interval. Default 500. */
  pollIntervalMs?: number;
  /** Broadcast/wait rounds per `settle` call before giving up (state is kept). Default 4. */
  maxRounds?: number;
  /** Upper bound for the gas limit. Default 25,000,000. */
  gasLimitCap?: bigint;
  /**
   * Gas the contract insists on having left before each match
   * (300,000 + 100,000 x marketCount); added on top of the estimate. Default 500,000.
   */
  gasFloorPerMatch?: bigint;
  /** Unmined broadcast rounds after which the transaction is replaced with higher fees. Default 2. */
  bumpAfterRounds?: number;
  /** Never sign with a maxFeePerGas above this (wei). Default: no cap. */
  maxFeePerGasCap?: bigint;
  /** Extra receipt polls before a batch is declared lost to a foreign transaction. Default 5. */
  releasePolls?: number;
}

interface Attempt {
  hash: Hex;
  raw: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface InFlight {
  batchId: string;
  nonce: number;
  data: Hex;
  gas: bigint;
  /** Every transaction signed for this batch. All share one nonce, so at most one can be mined. */
  attempts: Attempt[];
  /** Consecutive rounds in which the latest attempt was broadcast (or known to the node) but not mined. */
  unminedRounds: number;
  /** On-chain filledSize of every order in the batch, read before the first broadcast. */
  baseline: Map<Hex, bigint>;
}

/** Broadcast errors that mean the node has (or had) the transaction. */
const ACCEPTED_SEND_ERROR = /already known|known transaction|already imported|nonce too low|nonce has already been used|replacement transaction underpriced/i;

function isAcceptedSendError(e: unknown): boolean {
  const e2 = e as { message?: string; details?: string; shortMessage?: string };
  return ACCEPTED_SEND_ERROR.test(`${e2?.message ?? ""} ${e2?.details ?? ""} ${e2?.shortMessage ?? ""} ${String(e)}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Settles batches through `Exchange.settleMatches`.
 *
 * No double settlement: a batch is bound to one operator nonce when it is first
 * signed. Re-broadcasts and fee bumps reuse that nonce, so at most one of them can
 * ever be mined, and the outcome is looked up by the locally computed hashes. The
 * binding survives a failed `settle` call and is only released when
 *  (a) one of the batch's transactions is mined (success or revert), or
 *  (b) the nonce is gone on-chain, none of our transactions shows a receipt after
 *      several polls, AND `filledSize` of every order in the batch still equals the
 *      value read before the first broadcast - i.e. the chain itself shows that no
 *      match of the batch was applied. If any `filledSize` moved, the batch did land
 *      and the settler keeps waiting for its receipt instead of releasing.
 *
 * Fees: a transaction that stays unmined for `bumpAfterRounds` rounds is replaced
 * (same nonce) with fees raised by 25%, up to `maxFeePerGasCap`. Broadcast errors do
 * not prevent that: with a shared nonce a replacement is always safe.
 *
 * Nonces: transactions are strictly sequential; the next nonce is
 * max(local counter, chain "pending" count). The operator key must not be used by
 * any other process (run the keeper with its own key).
 */
export class ViemSettler implements Settler {
  private readonly rpc: SettlerRpc;
  private readonly account: LocalAccount;
  private readonly chainId: number;
  private readonly exchange: Address;
  private readonly log: Logger;
  private readonly receiptTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRounds: number;
  private readonly gasLimitCap: bigint;
  private readonly gasFloorPerMatch: bigint;
  private readonly bumpAfterRounds: number;
  private readonly maxFeePerGasCap: bigint | undefined;
  private readonly releasePolls: number;

  private inflight: InFlight | null = null;
  private nextNonce = 0;
  private busy = false;
  private last: { batchId: string; results: MatchResult[] } | null = null;

  constructor(opts: ViemSettlerOptions) {
    this.rpc = opts.rpc;
    this.account = opts.account;
    this.chainId = opts.chainId;
    this.exchange = opts.exchange;
    this.log = opts.logger ?? silentLogger;
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.maxRounds = opts.maxRounds ?? 4;
    this.gasLimitCap = opts.gasLimitCap ?? 25_000_000n;
    this.gasFloorPerMatch = opts.gasFloorPerMatch ?? 500_000n;
    this.bumpAfterRounds = Math.max(1, opts.bumpAfterRounds ?? 2);
    this.maxFeePerGasCap = opts.maxFeePerGasCap;
    this.releasePolls = opts.releasePolls ?? 5;
  }

  async settle(batch: Batch): Promise<MatchResult[]> {
    if (this.busy) throw new Error("ViemSettler.settle called concurrently");
    this.busy = true;
    try {
      return await this.settleInner(batch);
    } finally {
      this.busy = false;
    }
  }

  private async settleInner(batch: Batch): Promise<MatchResult[]> {
    if (this.last?.batchId === batch.id) return this.last.results;
    if (batch.matches.length === 0) return [];
    if (this.inflight && this.inflight.batchId !== batch.id) {
      throw new Error(`batch ${this.inflight.batchId} is still unresolved; refusing to submit ${batch.id}`);
    }
    const fl = this.inflight ?? (await this.prepare(batch));

    let lastSendError: unknown;
    for (let round = 0; round < this.maxRounds; round++) {
      if (fl.attempts.length === 0 || fl.unminedRounds >= this.bumpAfterRounds) await this.sign(fl);
      const attempt = fl.attempts[fl.attempts.length - 1]!;
      lastSendError = undefined;
      try {
        // Safe to repeat: the same raw transaction has the same hash.
        await this.rpc.sendRawTransaction(attempt.raw);
      } catch (e) {
        // The node may or may not have it. Never assume: look for a receipt first.
        if (!isAcceptedSendError(e)) lastSendError = e;
      }
      const mined = await this.waitForReceipt(fl, this.receiptTimeoutMs);
      if (mined) return this.finish(batch, fl, mined.hash, mined.receipt);
      // Counted whether or not the broadcast call succeeded: the first call may have
      // delivered the transaction and only its response got lost.
      fl.unminedRounds++;

      // Not mined. If the nonce is gone anyway, find out what happened before deciding.
      const latest = await this.rpc.getNonce(this.account.address, "latest");
      if (latest > fl.nonce) {
        const late = await this.waitForReceipt(fl, this.pollIntervalMs * this.releasePolls);
        if (late) return this.finish(batch, fl, late.hash, late.receipt);
        if (await this.batchLeftNoTrace(batch, fl)) {
          this.inflight = null;
          this.nextNonce = latest;
          throw new BatchRevertedError(
            `operator nonce ${fl.nonce} was consumed, no transaction of batch ${batch.id} has a receipt and no order of the batch was filled`,
          );
        }
        // Some order of the batch was filled: our transaction was mined, only its
        // receipt is not being served. Keep the binding and keep looking.
        throw new Error(`batch ${batch.id} (nonce ${fl.nonce}) appears mined but its receipt is not available yet`);
      }
      this.log.warn("settlement transaction not mined yet", {
        batch: batch.id,
        nonce: fl.nonce,
        txHash: attempt.hash,
        sendError: lastSendError === undefined ? null : errMessage(lastSendError),
      });
    }
    throw new Error(
      `batch ${batch.id} (nonce ${fl.nonce}) not mined after ${this.maxRounds} rounds` +
        (lastSendError === undefined ? "" : `: ${errMessage(lastSendError)}`),
    );
  }

  /** True iff on-chain filledSize of every order in the batch is still at its pre-broadcast value. */
  private async batchLeftNoTrace(batch: Batch, fl: InFlight): Promise<boolean> {
    for (const [hash, before] of fl.baseline) {
      if ((await this.rpc.filledSize(hash)) !== before) return false;
    }
    return true;
  }

  /** Bind the batch to calldata, a gas limit and a nonce. Nothing is signed yet. */
  private async prepare(batch: Batch): Promise<InFlight> {
    const data = encodeFunctionData({
      abi: exchangeAbi,
      functionName: "settleMatches",
      args: [batch.matches.map((m) => ({ maker: m.maker, makerSig: m.makerSig, taker: m.taker, takerSig: m.takerSig, fillSize: m.fillSize }))],
    });
    const estimate = await this.rpc.estimateGas({ from: this.account.address, to: this.exchange, data });
    // Head-room on top of the estimate: the contract reverts the whole batch with
    // InsufficientGas when less than its per-match floor is left before a match.
    let gas = (estimate * 3n) / 2n + this.gasFloorPerMatch;
    if (gas > this.gasLimitCap) gas = estimate > this.gasLimitCap ? estimate : this.gasLimitCap;
    const baseline = new Map<Hex, bigint>();
    for (const m of batch.matches) {
      for (const hash of [m.makerHash, m.takerHash]) {
        if (!baseline.has(hash)) baseline.set(hash, await this.rpc.filledSize(hash));
      }
    }
    const pending = await this.rpc.getNonce(this.account.address, "pending");
    const nonce = Math.max(pending, this.nextNonce);
    return (this.inflight = { batchId: batch.id, nonce, data, gas, attempts: [], unminedRounds: 0, baseline });
  }

  /** Sign the first attempt, or a replacement with higher fees (if the cap leaves room for one). */
  private async sign(fl: InFlight): Promise<void> {
    let fees = await this.rpc.estimateFees();
    const cap = this.maxFeePerGasCap;
    const prev = fl.attempts[fl.attempts.length - 1];
    if (prev) {
      // Replacement transactions must raise both fee fields (>= 10% on most clients).
      const up = (x: bigint) => (x * 125n) / 100n + 1n;
      fees = {
        maxFeePerGas: fees.maxFeePerGas > up(prev.maxFeePerGas) ? fees.maxFeePerGas : up(prev.maxFeePerGas),
        maxPriorityFeePerGas:
          fees.maxPriorityFeePerGas > up(prev.maxPriorityFeePerGas) ? fees.maxPriorityFeePerGas : up(prev.maxPriorityFeePerGas),
      };
      if (cap !== undefined && fees.maxFeePerGas > cap) {
        // No room for a valid replacement: keep re-broadcasting the last attempt.
        this.log.warn("fee cap reached; not replacing the settlement transaction", { nonce: fl.nonce, cap });
        fl.unminedRounds = 0;
        return;
      }
    } else if (cap !== undefined && fees.maxFeePerGas > cap) {
      fees = { maxFeePerGas: cap, maxPriorityFeePerGas: fees.maxPriorityFeePerGas > cap ? cap : fees.maxPriorityFeePerGas };
    }
    if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) fees.maxPriorityFeePerGas = fees.maxFeePerGas;
    const raw = await this.account.signTransaction({
      type: "eip1559",
      chainId: this.chainId,
      nonce: fl.nonce,
      to: this.exchange,
      data: fl.data,
      gas: fl.gas,
      value: 0n,
      ...fees,
    });
    fl.attempts.push({ hash: keccak256(raw), raw, ...fees });
    fl.unminedRounds = 0;
  }

  private async findReceipt(fl: InFlight): Promise<{ hash: Hex; receipt: RpcReceipt } | null> {
    for (const a of fl.attempts) {
      const receipt = await this.rpc.getReceipt(a.hash);
      if (receipt) return { hash: a.hash, receipt };
    }
    return null;
  }

  private async waitForReceipt(fl: InFlight, timeoutMs: number): Promise<{ hash: Hex; receipt: RpcReceipt } | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const found = await this.findReceipt(fl);
        if (found) return found;
      } catch (e) {
        this.log.warn("receipt lookup failed", { error: errMessage(e) });
      }
      if (Date.now() >= deadline) return null;
      await sleep(this.pollIntervalMs);
    }
  }

  /** One of the batch's transactions was mined: the outcome is final. */
  private finish(batch: Batch, fl: InFlight, txHash: Hex, receipt: RpcReceipt): MatchResult[] {
    this.inflight = null;
    this.nextNonce = fl.nonce + 1;
    if (receipt.status !== "success") {
      throw new BatchRevertedError(`settleMatches transaction ${txHash} reverted`, txHash);
    }
    const results = parseSettlementLogs(batch.matches, receipt.logs, this.exchange, txHash, this.log);
    this.last = { batchId: batch.id, results };
    return results;
  }
}

/**
 * Map a mined settleMatches receipt to one result per match. A match failed iff the
 * contract emitted MatchFailed with its batch index; every other match settled (that
 * is the IExchange guarantee). Fill logs are cross-checked and any disagreement is
 * logged as an error, but never turned into an exception: the transaction is mined,
 * and reporting "unknown" would invite a retry that could settle twice.
 */
export function parseSettlementLogs(matches: Match[], logs: RpcLog[], exchange: Address, txHash: Hex, log: Logger = silentLogger): MatchResult[] {
  const failed = new Map<number, Hex>();
  const fills: { makerOrderHash: Hex; takerOrderHash: Hex; size: bigint; price: bigint }[] = [];
  for (const l of logs) {
    if (!isAddressEqual(l.address, exchange)) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: exchangeAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
    } catch {
      continue; // an event this ABI does not know
    }
    if (ev.eventName === "MatchFailed") {
      const index = Number(ev.args.index);
      const m = matches[index];
      if (!m || m.makerHash.toLowerCase() !== ev.args.makerOrderHash.toLowerCase() || m.takerHash.toLowerCase() !== ev.args.takerOrderHash.toLowerCase()) {
        log.error("MatchFailed event does not correspond to the submitted batch", { txHash, index: ev.args.index });
        if (!m) continue;
      }
      failed.set(index, ev.args.reason);
    } else if (ev.eventName === "Fill") {
      fills.push(ev.args);
    }
  }
  const results = matches.map((_, i): MatchResult => {
    const reason = failed.get(i);
    return reason === undefined ? { status: "settled", txHash } : { status: "failed", txHash, reason };
  });
  const expected = matches.filter((_, i) => !failed.has(i));
  const consistent =
    expected.length === fills.length &&
    expected.every((m, i) => {
      const f = fills[i]!;
      return (
        f.makerOrderHash.toLowerCase() === m.makerHash.toLowerCase() &&
        f.takerOrderHash.toLowerCase() === m.takerHash.toLowerCase() &&
        f.size === m.fillSize &&
        f.price === m.price
      );
    });
  if (!consistent) {
    log.error("Fill events do not match the batch; engine state may diverge from the chain", {
      txHash,
      expectedFills: expected.length,
      fillEvents: fills.length,
    });
  }
  return results;
}

/** SettlerRpc backed by a viem public client. */
export function viemSettlerRpc(client: PublicClient, exchange: Address): SettlerRpc {
  return {
    filledSize: (orderHash) => client.readContract({ address: exchange, abi: exchangeAbi, functionName: "filledSize", args: [orderHash] }),
    getNonce: (address, tag) => client.getTransactionCount({ address, blockTag: tag }),
    async estimateGas({ from, to, data }) {
      try {
        return await client.estimateGas({ account: from, to, data });
      } catch (e) {
        if (e instanceof BaseError && e.walk((x) => x instanceof ExecutionRevertedError)) {
          throw new BatchRevertedError(`settleMatches would revert: ${e.shortMessage}`);
        }
        throw e;
      }
    },
    async estimateFees() {
      const f = await client.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    },
    async sendRawTransaction(raw) {
      await client.sendRawTransaction({ serializedTransaction: raw });
    },
    async getReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
  };
}
