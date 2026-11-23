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
  /** The last broadcast was accepted but not mined in time: replace with higher fees. */
  bump: boolean;
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
 *  (b) the nonce was provably consumed by a foreign transaction (none of ours mined),
 * both of which make any earlier transaction of the batch permanently invalid.
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
      if (fl.attempts.length === 0 || fl.bump) await this.sign(fl);
      const attempt = fl.attempts[fl.attempts.length - 1]!;
      lastSendError = undefined;
      try {
        // Safe to repeat: the same raw transaction has the same hash.
        await this.rpc.sendRawTransaction(attempt.raw);
      } catch (e) {
        // The node may or may not have it ("already known", timeouts, nonce too low...).
        // Never assume: look for a receipt before doing anything else.
        lastSendError = e;
      }
      const mined = await this.waitForReceipt(fl);
      if (mined) return this.finish(batch, fl, mined.hash, mined.receipt);

      // Not mined. If the nonce is gone anyway, a foreign transaction took it and none
      // of ours can ever be mined: the batch definitively did not settle.
      const latest = await this.rpc.getNonce(this.account.address, "latest");
      if (latest > fl.nonce) {
        // Give a lagging receipt index one more poll before concluding.
        await sleep(this.pollIntervalMs);
        const late = await this.findReceipt(fl);
        if (late) return this.finish(batch, fl, late.hash, late.receipt);
        this.inflight = null;
        this.nextNonce = latest;
        throw new BatchRevertedError(`operator nonce ${fl.nonce} was consumed by a transaction this settler did not send`);
      }
      fl.bump = lastSendError === undefined;
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

  /** Bind the batch to calldata, a gas limit and a nonce. Nothing is signed yet. */
  private async prepare(batch: Batch): Promise<InFlight> {
    const data = encodeFunctionData({
      abi: exchangeAbi,
      functionName: "settleMatches",
      args: [batch.matches.map((m) => ({ maker: m.maker, makerSig: m.makerSig, taker: m.taker, takerSig: m.takerSig, fillSize: m.fillSize }))],
    });
    const estimate = await this.rpc.estimateGas({ from: this.account.address, to: this.exchange, data });
    // Generous head-room: the contract isolates each match in an inner call, and an
    // inner call starved of gas would look like a (wrongly attributed) MatchFailed.
    let gas = (estimate * 3n) / 2n + 50_000n * BigInt(batch.matches.length);
    if (gas > this.gasLimitCap) gas = estimate > this.gasLimitCap ? estimate : this.gasLimitCap;
    const pending = await this.rpc.getNonce(this.account.address, "pending");
    const nonce = Math.max(pending, this.nextNonce);
    return (this.inflight = { batchId: batch.id, nonce, data, gas, attempts: [], bump: false });
  }

  private async sign(fl: InFlight): Promise<void> {
    let fees = await this.rpc.estimateFees();
    const prev = fl.attempts[fl.attempts.length - 1];
    if (prev) {
      // Replacement transactions must raise both fee fields (>= 10% on most clients).
      const up = (x: bigint) => (x * 125n) / 100n + 1n;
      fees = {
        maxFeePerGas: fees.maxFeePerGas > up(prev.maxFeePerGas) ? fees.maxFeePerGas : up(prev.maxFeePerGas),
        maxPriorityFeePerGas:
          fees.maxPriorityFeePerGas > up(prev.maxPriorityFeePerGas) ? fees.maxPriorityFeePerGas : up(prev.maxPriorityFeePerGas),
      };
    }
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
    fl.bump = false;
  }

  private async findReceipt(fl: InFlight): Promise<{ hash: Hex; receipt: RpcReceipt } | null> {
    for (const a of fl.attempts) {
      const receipt = await this.rpc.getReceipt(a.hash);
      if (receipt) return { hash: a.hash, receipt };
    }
    return null;
  }

  private async waitForReceipt(fl: InFlight): Promise<{ hash: Hex; receipt: RpcReceipt } | null> {
    const deadline = Date.now() + this.receiptTimeoutMs;
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
export function viemSettlerRpc(client: PublicClient): SettlerRpc {
  return {
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
