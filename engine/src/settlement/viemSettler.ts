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
import type { KeyValueStore } from "../store/types.ts";
import { errMessage, jsonReplacer, silentLogger, type Address, type Hex, type Logger, type Match } from "../types.ts";
import { BatchRevertedError, type Batch, type MatchResult, type Settler } from "./types.ts";

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface RpcReceipt {
  status: "success" | "reverted";
  logs: RpcLog[];
  blockNumber: bigint;
  blockHash: Hex;
}

/** The few RPC calls the settler needs; narrow so the retry logic can be tested with a fake. */
export interface SettlerRpc {
  /**
   * Transaction count of `address`: "pending" includes the mempool, "latest" only
   * mined ones, a block number is the count as of that block.
   */
  getNonce(address: Address, at: "pending" | "latest" | bigint): Promise<number>;
  /** Must reject with BatchRevertedError if the call would revert. */
  estimateGas(tx: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  /** eth_call with an explicit gas limit. Must reject with BatchRevertedError if it reverts. */
  call(tx: { from: Address; to: Address; data: Hex; gas: bigint }): Promise<void>;
  estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(raw: Hex): Promise<void>;
  /** null while the transaction is not mined. */
  getReceipt(hash: Hex): Promise<RpcReceipt | null>;
  /** `Exchange.filledSize(orderHash)` at the latest block, or as of `block`. */
  filledSize(orderHash: Hex, block?: bigint): Promise<bigint>;
  /** Latest block number. */
  blockNumber(): Promise<bigint>;
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
  /** Upper bound for the gas limit. Default 16,000,000 (below the 2^24 per-transaction cap of EIP-7825). */
  gasLimitCap?: bigint;
  /**
   * Gas the contract insists on having left before each match (currently
   * 400,000 + 150,000 x marketCount; configurable because it is re-measured when the
   * contract changes). Every match is budgeted at this. Default 700,000.
   */
  gasFloorPerMatch?: bigint;
  /** Fixed part of the gas budget (intrinsic gas, calldata, loop overhead). Default 300,000. */
  gasOverhead?: bigint;
  /** Unmined broadcast rounds after which the transaction is replaced with higher fees. Default 2. */
  bumpAfterRounds?: number;
  /** Never sign with a maxFeePerGas above this (wei). Default: no cap. */
  maxFeePerGasCap?: bigint;
  /** Extra receipt polls before a batch is declared lost to a foreign transaction. Default 5. */
  releasePolls?: number;
  /**
   * Blocks a settlement transaction must be buried under (1 = just mined) before its
   * outcome is reported. Default 1.
   */
  confirmations?: number;
  /** How long one `settle` call waits for the confirmations. Default 600000. */
  confirmationTimeoutMs?: number;
  /**
   * Where the batch in flight is recorded (nonce and signed transactions, written
   * before the first broadcast), so that a restarted process can establish what
   * happened to it instead of signing it again.
   */
  store?: KeyValueStore;
}

interface Attempt {
  /** The node took it (or already had it). false: refused for lack of funds. */
  accepted?: boolean;
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
  /**
   * Hash of the transaction whose (successful) receipt gave the batch its outcome.
   * Kept until the next batch arrives, so that the same results can be re-derived if
   * the caller crashed before recording them.
   */
  minedHash?: Hex;
}

/** Broadcast errors that mean the operator cannot pay for this transaction at these fees. */
const INSUFFICIENT_FUNDS = /insufficient funds|insufficient balance|exceeds balance|not enough funds/i;

const STORE_KEY = "settler.inflight";

function serialize(fl: InFlight): string {
  return JSON.stringify({ ...fl, baseline: [...fl.baseline] }, jsonReplacer);
}

function deserialize(raw: string): InFlight {
  const o = JSON.parse(raw) as Omit<InFlight, "gas" | "attempts" | "baseline"> & {
    gas: string;
    attempts: { hash: Hex; raw: Hex; maxFeePerGas: string; maxPriorityFeePerGas: string }[];
    baseline: [Hex, string][];
  };
  return {
    ...o,
    gas: BigInt(o.gas),
    attempts: o.attempts.map((a) => ({ ...a, maxFeePerGas: BigInt(a.maxFeePerGas), maxPriorityFeePerGas: BigInt(a.maxPriorityFeePerGas) })),
    baseline: new Map(o.baseline.map(([h, v]) => [h, BigInt(v)])),
  };
}

/** Broadcast errors that mean the node has (or had) the transaction. */
const ACCEPTED_SEND_ERROR = /already known|known transaction|already imported|nonce too low|nonce has already been used|replacement transaction underpriced/i;

function sendErrorText(e: unknown): string {
  const e2 = e as { message?: string; details?: string; shortMessage?: string };
  return `${e2?.message ?? ""} ${e2?.details ?? ""} ${e2?.shortMessage ?? ""} ${String(e)}`;
}

function isAcceptedSendError(e: unknown): boolean {
  return ACCEPTED_SEND_ERROR.test(sendErrorText(e));
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
 *  (b) as of one pinned block that is `confirmations` deep, the nonce is consumed,
 *      none of our transactions shows a receipt after several polls, AND `filledSize`
 *      of every order in the batch (read at that same block) still equals the value
 *      read before the first broadcast - i.e. the chain itself shows that no match
 *      of the batch was applied. If any `filledSize` moved, the batch did land and
 *      the settler keeps waiting for its receipt instead of releasing.
 *
 * Fees: a transaction that stays unmined for `bumpAfterRounds` rounds is replaced
 * (same nonce) with fees raised by 25%, up to `maxFeePerGasCap`. Broadcast errors do
 * not prevent that: with a shared nonce a replacement is always safe. If a node
 * refuses a replacement because the operator cannot pay for it, bumping stops and
 * the highest-fee transaction a node did accept keeps being re-broadcast; `status()`
 * reports it until the batch is mined.
 *
 * Restarts: with a `store`, the binding (nonce, every signed transaction, the
 * `filledSize` baseline) is written durably before the first broadcast and after
 * every re-signing. A new process picks it up and continues exactly as above: it
 * finds the receipt of a transaction it already sent, or re-broadcasts the very same
 * signed transaction. Once a batch has an outcome its record is kept (with the hash
 * of the mined transaction) until the next batch arrives, so the outcome can be
 * re-derived from the receipt if the caller died before recording it.
 *
 * Confirmations: the outcome is only reported once the transaction is `confirmations`
 * blocks deep and its receipt is still there, in the same block.
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
  private readonly gasOverhead: bigint;
  private readonly bumpAfterRounds: number;
  private readonly maxFeePerGasCap: bigint | undefined;
  private readonly releasePolls: number;
  private readonly confirmations: number;
  private readonly confirmationTimeoutMs: number;
  private readonly store: KeyValueStore | undefined;
  private loaded = false;
  /** The record in `inflight` came from the store (a previous process), not from this one. */
  private restored = false;
  private insufficientFunds = false;
  private feeCapReached = false;

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
    this.gasLimitCap = opts.gasLimitCap ?? 16_000_000n;
    this.gasFloorPerMatch = opts.gasFloorPerMatch ?? 700_000n;
    this.gasOverhead = opts.gasOverhead ?? 300_000n;
    this.bumpAfterRounds = Math.max(1, opts.bumpAfterRounds ?? 2);
    this.maxFeePerGasCap = opts.maxFeePerGasCap;
    this.releasePolls = opts.releasePolls ?? 5;
    this.confirmations = Math.max(1, opts.confirmations ?? 1);
    this.confirmationTimeoutMs = opts.confirmationTimeoutMs ?? 600_000;
    this.store = opts.store;
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
    if (!this.loaded) {
      this.loaded = true;
      const raw = this.store?.getMeta(STORE_KEY);
      if (raw) {
        this.inflight = deserialize(raw);
        this.restored = true;
        if (this.inflight.minedHash === undefined) {
          this.log.info("found a settlement batch that was in flight; resolving it from the chain", {
            batch: this.inflight.batchId,
            nonce: this.inflight.nonce,
            transactions: this.inflight.attempts.map((a) => a.hash),
          });
        }
      }
    }
    if (this.last?.batchId === batch.id) return this.last.results;
    if (batch.matches.length === 0) return [];
    if (this.inflight && this.inflight.batchId !== batch.id) {
      if (this.inflight.minedHash === undefined) {
        throw new Error(`batch ${this.inflight.batchId} is still unresolved; refusing to submit ${batch.id}`);
      }
      // The previous batch had its outcome and the caller has moved on. Within one
      // process the local counter guards against a node that lags behind; a record
      // inherited from an earlier process says nothing about now, so after a restart
      // the next nonce comes from the chain alone.
      if (!this.restored) this.nextNonce = Math.max(this.nextNonce, this.inflight.nonce + 1);
      this.inflight = null;
      this.restored = false;
    }
    if (this.inflight && this.inflight.data !== encodeBatch(batch)) {
      throw new Error(`recorded in-flight batch ${batch.id} does not match the batch being settled; refusing to continue`);
    }
    if (this.inflight?.minedHash !== undefined) {
      // Outcome known before a restart: derive the same results from the same receipt.
      const fl = this.inflight;
      const receipt = await this.rpc.getReceipt(fl.minedHash!);
      const again = receipt && (await this.confirmed({ hash: fl.minedHash!, receipt }));
      if (again) return this.finish(batch, fl, again.hash, again.receipt);
      delete fl.minedHash; // not there (any more): fall through and look for it / re-broadcast
    }
    const fl = this.inflight ?? (await this.prepare(batch));

    let lastSendError: unknown;
    for (let round = 0; round < this.maxRounds; round++) {
      // Replace with higher fees after `bumpAfterRounds` unmined rounds - unless the
      // operator could not even pay for the last replacement.
      if (fl.attempts.length === 0 || (fl.unminedRounds >= this.bumpAfterRounds && !this.insufficientFunds)) await this.sign(fl);
      // Durable before the broadcast: a restarted process must know this transaction exists.
      this.persist();
      const attempt = this.attemptToSend(fl);
      lastSendError = undefined;
      try {
        // Safe to repeat: the same raw transaction has the same hash.
        await this.rpc.sendRawTransaction(attempt.raw);
        attempt.accepted = true;
      } catch (e) {
        if (isAcceptedSendError(e)) {
          attempt.accepted = true;
        } else if (INSUFFICIENT_FUNDS.test(sendErrorText(e))) {
          // The node refused it: the operator cannot pay gas x fee. Bumping further only
          // makes that worse. Stop bumping and go back to the best transaction a node took.
          attempt.accepted = false;
          if (!this.insufficientFunds) {
            this.log.error("operator cannot pay for the settlement transaction; fee bumping stopped", {
              batch: batch.id,
              nonce: fl.nonce,
              maxFeePerGas: attempt.maxFeePerGas,
              gas: fl.gas,
            });
          }
          this.insufficientFunds = true;
          lastSendError = e;
        } else {
          // The node may or may not have it. Never assume: look for a receipt first.
          lastSendError = e;
        }
      }
      const seen = await this.waitForReceipt(fl, this.receiptTimeoutMs);
      const mined = seen && (await this.confirmed(seen));
      if (mined) return this.finish(batch, fl, mined.hash, mined.receipt);
      // Counted whether or not the broadcast call succeeded: the first call may have
      // delivered the transaction and only its response got lost.
      fl.unminedRounds++;

      // Not mined. If the nonce is gone anyway, find out what happened before deciding.
      // Everything below is read as of one block, so that answers from backends at
      // different heights cannot be combined into a wrong conclusion.
      const pin = await this.rpc.blockNumber();
      if ((await this.rpc.getNonce(this.account.address, pin)) > fl.nonce) {
        await this.waitUntilBuried(pin);
        const lateSeen = await this.waitForReceipt(fl, this.pollIntervalMs * this.releasePolls);
        const late = lateSeen && (await this.confirmed(lateSeen));
        if (late) return this.finish(batch, fl, late.hash, late.receipt);
        // Still consumed as of that (now confirmed) block? A reorg may have undone it.
        if ((await this.rpc.getNonce(this.account.address, pin)) > fl.nonce) {
          if (await this.batchLeftNoTrace(fl, pin)) {
            this.inflight = null;
            this.restored = false;
            this.persist();
            this.nextNonce = Math.max(this.nextNonce, fl.nonce + 1);
            throw new BatchRevertedError(
              `operator nonce ${fl.nonce} was consumed as of block ${pin}, no transaction of batch ${batch.id} has a receipt and no order of the batch was filled`,
            );
          }
          // Some order of the batch was filled: our transaction was mined, only its
          // receipt is not being served. Keep the binding and keep looking.
          throw new Error(`batch ${batch.id} (nonce ${fl.nonce}) appears mined but its receipt is not available yet`);
        }
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

  /**
   * Which signed transaction to broadcast this round: normally the newest. Once a
   * replacement was refused for lack of funds, the highest-fee one a node accepted
   * (it is the one that can still be mined); if none was accepted yet, the cheapest.
   */
  private attemptToSend(fl: InFlight): Attempt {
    const newest = fl.attempts[fl.attempts.length - 1]!;
    if (!this.insufficientFunds) return newest;
    for (let i = fl.attempts.length - 1; i >= 0; i--) if (fl.attempts[i]!.accepted) return fl.attempts[i]!;
    return fl.attempts[0]!;
  }

  /** Wait until block `n` has `confirmations - 1` blocks on top of it. */
  private async waitUntilBuried(n: bigint): Promise<void> {
    if (this.confirmations <= 1) return;
    const deadline = Date.now() + this.confirmationTimeoutMs;
    while ((await this.rpc.blockNumber()) < n + BigInt(this.confirmations - 1)) {
      if (Date.now() >= deadline) throw new Error(`block ${n} is not yet ${this.confirmations} blocks deep`);
      await sleep(this.pollIntervalMs);
    }
  }

  /** What an operator should know about the settler right now. */
  status(): { insufficientFunds: boolean; feeCapReached: boolean } {
    return { insufficientFunds: this.insufficientFunds, feeCapReached: this.feeCapReached };
  }

  /**
   * True iff, as of block `pin`, on-chain filledSize of every order in the batch is
   * still at its pre-broadcast value.
   */
  private async batchLeftNoTrace(fl: InFlight, pin: bigint): Promise<boolean> {
    for (const [hash, before] of fl.baseline) {
      if ((await this.rpc.filledSize(hash, pin)) !== before) return false;
    }
    return true;
  }

  /** Bind the batch to calldata, a gas limit and a nonce. Nothing is signed yet. */
  private async prepare(batch: Batch): Promise<InFlight> {
    const data = encodeBatch(batch);
    const gas = await this.gasLimit(data, batch.matches.length);
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

  /**
   * Gas limit for the batch: max(estimate x 1.5, matches x per-match floor + overhead).
   *
   * The estimate alone is not enough. The contract reverts the whole batch with
   * InsufficientGas when less than its per-match floor is left before a match, and a
   * match that fails cheaply during estimation (oracle about to refresh, price just
   * outside the band) can run in full at inclusion. So every match is budgeted at the
   * floor regardless of what the estimate saw. The estimate still matters on an L2,
   * where it includes the L1 data cost.
   *
   * Some nodes cannot estimate this call at all (their search does not cope with the
   * floor); then the computed budget is used after an eth_call check with it.
   */
  private async gasLimit(data: Hex, matches: number): Promise<bigint> {
    const tx = { from: this.account.address, to: this.exchange, data };
    const budget = BigInt(matches) * this.gasFloorPerMatch + this.gasOverhead;
    const clamp = (g: bigint) => (g > this.gasLimitCap ? this.gasLimitCap : g);
    let estimate: bigint;
    try {
      estimate = await this.rpc.estimateGas(tx);
    } catch (e) {
      if (e instanceof BatchRevertedError) throw e;
      const gas = clamp(budget);
      this.log.warn("gas estimation failed; using the computed gas budget", { gas, error: errMessage(e) });
      await this.rpc.call({ ...tx, gas }); // BatchRevertedError if it would revert; other errors: nothing was sent
      return gas;
    }
    const padded = (estimate * 3n) / 2n;
    const gas = padded > budget ? padded : budget;
    // Never below the plain estimate, even if that exceeds the cap.
    return gas > this.gasLimitCap ? (estimate > this.gasLimitCap ? estimate : this.gasLimitCap) : gas;
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
        if (!this.feeCapReached) this.log.warn("fee cap reached; not replacing the settlement transaction", { nonce: fl.nonce, cap });
        this.feeCapReached = true;
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

  /**
   * Wait until the transaction is `confirmations` blocks deep. Returns null if its
   * receipt disappeared meanwhile (reorg): the caller goes back to looking for it.
   */
  private async confirmed(found: { hash: Hex; receipt: RpcReceipt }): Promise<{ hash: Hex; receipt: RpcReceipt } | null> {
    if (this.confirmations <= 1) return found;
    const deadline = Date.now() + this.confirmationTimeoutMs;
    for (;;) {
      const head = await this.rpc.blockNumber();
      if (head >= found.receipt.blockNumber + BigInt(this.confirmations - 1)) {
        const again = await this.rpc.getReceipt(found.hash);
        if (!again) {
          this.log.warn("settlement transaction disappeared before it was confirmed (reorg)", { txHash: found.hash });
          return null;
        }
        if (again.blockHash === found.receipt.blockHash) return { hash: found.hash, receipt: again };
        found = { hash: found.hash, receipt: again }; // re-mined in another block: count from there
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`transaction ${found.hash} is mined but not yet ${this.confirmations} blocks deep`);
      await sleep(this.pollIntervalMs);
    }
  }

  private persist(): void {
    this.store?.setMeta(STORE_KEY, this.inflight ? serialize(this.inflight) : "");
  }

  /** One of the batch's transactions was mined (and confirmed): the outcome is final. */
  private finish(batch: Batch, fl: InFlight, txHash: Hex, receipt: RpcReceipt): MatchResult[] {
    this.nextNonce = Math.max(this.nextNonce, fl.nonce + 1);
    this.insufficientFunds = false;
    this.feeCapReached = false;
    this.restored = false;
    if (receipt.status !== "success") {
      // Nothing was applied; a retry gets a fresh nonce and a fresh transaction.
      this.inflight = null;
      this.persist();
      throw new BatchRevertedError(`settleMatches transaction ${txHash} reverted`, txHash);
    }
    fl.minedHash = txHash;
    this.inflight = fl;
    this.persist();
    const results = parseSettlementLogs(batch.matches, receipt.logs, this.exchange, txHash, this.log);
    this.last = { batchId: batch.id, results };
    return results;
  }
}

function encodeBatch(batch: Batch): Hex {
  return encodeFunctionData({
    abi: exchangeAbi,
    functionName: "settleMatches",
    args: [batch.matches.map((m) => ({ maker: m.maker, makerSig: m.makerSig, taker: m.taker, takerSig: m.takerSig, fillSize: m.fillSize }))],
  });
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
    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    filledSize: (orderHash, block) =>
      client.readContract({ address: exchange, abi: exchangeAbi, functionName: "filledSize", args: [orderHash], ...(block !== undefined ? { blockNumber: block } : {}) }),
    getNonce: (address, at) => client.getTransactionCount(typeof at === "bigint" ? { address, blockNumber: at } : { address, blockTag: at }),
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
    async call({ from, to, data, gas }) {
      try {
        await client.call({ account: from, to, data, gas });
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
        return {
          status: r.status,
          logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
        };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
  };
}
