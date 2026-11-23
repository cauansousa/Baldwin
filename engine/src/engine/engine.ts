import { EventEmitter } from "node:events";
import { BPS } from "../../../shared/src/index.ts";
import { OrderBook, type BookFill, type BookOrder, type Level } from "../book/orderbook.ts";
import type { ChainReader } from "../chain/types.ts";
import { hashOrder, verifyCancelSignature, verifyOrderSignature, type Domain } from "../signing.ts";
import { BatchRevertedError, type Batch, type MatchResult, type Settler } from "../settlement/types.ts";
import { errMessage, silentLogger, type Address, type Hex, type Logger, type MarketConfig, type Match, type Order } from "../types.ts";
import { classifyFailure, isReducing, notionalUsdc, UNATTRIBUTED, type Verdict } from "./reconcile.ts";

export type OrderStatus =
  /** Resting, nothing matched yet. */
  | "open"
  /** Resting, part of it matched (pending and/or confirmed). */
  | "partially_filled"
  /** Fully matched; at least part is still awaiting on-chain confirmation. */
  | "pending_settlement"
  /** Fully settled on-chain. */
  | "filled"
  | "cancelled"
  | "expired"
  /** Removed by the engine because a match failed on-chain and this order was at fault. */
  | "rejected";

export interface OrderView {
  orderHash: Hex;
  order: Order;
  status: OrderStatus;
  /** Unmatched quantity resting in the book. */
  remaining: bigint;
  /** Matched, awaiting on-chain confirmation. */
  pending: bigint;
  /** Confirmed on-chain. */
  filled: bigint;
  postOnly: boolean;
  ioc: boolean;
  reason?: string;
  createdAt: number;
}

/** A match reported in the POST /orders response; provisional until it shows up as a trade. */
export interface PendingFill {
  makerOrderHash: Hex;
  takerOrderHash: Hex;
  price: bigint;
  size: bigint;
  status: "pending";
}

export interface SubmitResult {
  orderHash: Hex;
  status: OrderStatus;
  fills: PendingFill[];
  remaining: bigint;
  reason?: string;
}

/** A fill confirmed on-chain. */
export interface Trade {
  id: string;
  marketId: number;
  price: bigint;
  size: bigint;
  takerIsBuy: boolean;
  maker: Address;
  taker: Address;
  makerOrderHash: Hex;
  takerOrderHash: Hex;
  txHash: Hex;
  /** Unix milliseconds at which the engine saw the confirmation. */
  timestamp: number;
}

export type EngineErrorCode =
  | "UNKNOWN_MARKET"
  | "MARKET_INACTIVE"
  | "INVALID_ORDER"
  | "BELOW_MIN_SIZE"
  | "EXPIRED"
  | "DUPLICATE_ORDER"
  | "NONCE_CANCELLED"
  | "NONCE_REUSED"
  | "BAD_SIGNATURE"
  | "ALREADY_FILLED"
  | "REDUCE_ONLY_NO_POSITION"
  | "INSUFFICIENT_MARGIN"
  | "POST_ONLY_WOULD_CROSS"
  | "CHAIN_UNAVAILABLE"
  | "NOT_FOUND";

const HTTP_STATUS: Record<EngineErrorCode, number> = {
  UNKNOWN_MARKET: 400,
  MARKET_INACTIVE: 400,
  INVALID_ORDER: 400,
  BELOW_MIN_SIZE: 400,
  EXPIRED: 400,
  DUPLICATE_ORDER: 409,
  NONCE_CANCELLED: 409,
  NONCE_REUSED: 409,
  BAD_SIGNATURE: 401,
  ALREADY_FILLED: 409,
  REDUCE_ONLY_NO_POSITION: 422,
  INSUFFICIENT_MARGIN: 422,
  POST_ONLY_WOULD_CROSS: 422,
  CHAIN_UNAVAILABLE: 503,
  NOT_FOUND: 404,
};

export class EngineError extends Error {
  override readonly name = "EngineError";
  readonly httpStatus: number;
  constructor(public readonly code: EngineErrorCode, message: string) {
    super(message);
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface SubmitRequest {
  order: Order;
  signature: string;
  postOnly?: boolean;
  ioc?: boolean;
}

export interface EngineOptions {
  domain: Domain;
  markets: MarketConfig[];
  settler: Settler;
  /** Enables pre-trade checks and attribution of on-chain failures. */
  chain?: ChainReader;
  /** Run the pre-trade chain checks on intake (needs `chain`). Default true. */
  preTradeChecks?: boolean;
  logger?: Logger;
  /** Unix seconds. */
  now?: () => number;
  /** Orders are treated as expired this many seconds before their expiry. Default 5. */
  expiryBufferSec?: number;
  /** Max matches per settleMatches transaction. Default 20. */
  maxBatchSize?: number;
  /** Delay before re-trying a batch whose outcome is unknown or that reverted. Default 2000. */
  retryDelayMs?: number;
  /** Whole-batch reverts tolerated before its matches are failed. Default 3. */
  maxBatchReverts?: number;
  /** Unattributed on-chain failures a resting order survives. Default 3 (removed on the 3rd). */
  maxOrderStrikes?: number;
  /** Confirmed trades kept per market. Default 200. */
  tradeHistory?: number;
}

interface OrderRecord {
  hash: Hex;
  order: Order;
  signature: Hex;
  traderKey: string;
  postOnly: boolean;
  ioc: boolean;
  seq: bigint;
  remaining: bigint;
  pending: bigint;
  filled: bigint;
  /** The trader asked for a cancel (off-chain or on-chain); never give liquidity back. */
  userCancelled: boolean;
  closed?: { status: "cancelled" | "expired" | "rejected"; reason: string };
  /** Consecutive unattributed on-chain failures. */
  strikes: number;
  createdAt: number;
}

interface BookEffects {
  fills: BookFill[];
  expired: string[];
  selfTradeCancelled?: { id: string; size: bigint }[];
}

export interface EngineEvents {
  /** The visible book of a market changed. */
  book: [marketId: number];
  /** A fill was confirmed on-chain. */
  trade: [trade: Trade];
}

export interface SettlementStatus {
  queued: number;
  inFlight: number;
  /** True while a batch is being retried after an error. */
  stalled: boolean;
  lastError: string | null;
  settled: number;
  failed: number;
}

const nonceKey = (traderKey: string, nonce: bigint) => `${traderKey}:${nonce}`;

/**
 * Matching engine: order intake, per-market books, settlement queue, reconciliation.
 * See README.md ("Consistency model") for the guarantees.
 */
export class Engine extends EventEmitter<EngineEvents> {
  private readonly domain: Domain;
  private readonly markets = new Map<number, MarketConfig>();
  private readonly books = new Map<number, OrderBook>();
  private readonly orders = new Map<Hex, OrderRecord>();
  private readonly ordersByTrader = new Map<string, Set<Hex>>();
  /** trader:nonce -> hash of the order that uses it. */
  private readonly usedNonces = new Map<string, Hex>();
  private readonly cancelledNonces = new Set<string>();
  private readonly trades = new Map<number, Trade[]>();
  private readonly lastPrice = new Map<number, bigint>();

  private readonly settler: Settler;
  private readonly chain: ChainReader | undefined;
  private readonly preTradeChecks: boolean;
  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly expiryBuffer: bigint;
  private readonly maxBatchSize: number;
  private readonly retryDelayMs: number;
  private readonly maxBatchReverts: number;
  private readonly maxOrderStrikes: number;
  private readonly tradeHistory: number;

  private readonly queue: Match[] = [];
  private current: Batch | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private wakeRetry: (() => void) | null = null;
  private matchSeq = 0;
  private batchSeq = 0;
  private tradeSeq = 0;
  private stalled = false;
  private lastError: string | null = null;
  private settledCount = 0;
  private failedCount = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(opts: EngineOptions) {
    super();
    this.domain = opts.domain;
    this.settler = opts.settler;
    this.chain = opts.chain;
    this.preTradeChecks = (opts.preTradeChecks ?? true) && opts.chain !== undefined;
    this.log = opts.logger ?? silentLogger;
    this.clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.expiryBuffer = BigInt(opts.expiryBufferSec ?? 5);
    this.maxBatchSize = opts.maxBatchSize ?? 20;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.maxBatchReverts = opts.maxBatchReverts ?? 3;
    this.maxOrderStrikes = opts.maxOrderStrikes ?? 3;
    this.tradeHistory = opts.tradeHistory ?? 200;
    for (const m of opts.markets) {
      this.markets.set(m.marketId, m);
      this.books.set(m.marketId, new OrderBook(m.minOrderSize));
      this.trades.set(m.marketId, []);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the periodic expiry sweep. */
  start(sweepIntervalMs = 1000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /** Stop timers and the settlement loop (the batch in flight, if any, is awaited). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.wakeRetry?.();
    await this.loop;
  }

  /** Resolves once every queued match has reached a final on-chain outcome. */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  // -------------------------------------------------------------------- queries

  getMarkets(): (MarketConfig & { lastPrice: bigint | null; bestBid: bigint | null; bestAsk: bigint | null })[] {
    return [...this.markets.values()].map((m) => {
      const book = this.books.get(m.marketId)!;
      return {
        ...m,
        lastPrice: this.lastPrice.get(m.marketId) ?? null,
        bestBid: book.bestBid()?.price ?? null,
        bestAsk: book.bestAsk()?.price ?? null,
      };
    });
  }

  hasMarket(marketId: number): boolean {
    return this.markets.has(marketId);
  }

  getOrderBook(marketId: number, depth: number): { marketId: number; bids: Level[]; asks: Level[] } {
    const book = this.books.get(marketId);
    if (!book) throw new EngineError("UNKNOWN_MARKET", `unknown market ${marketId}`);
    return { marketId, ...book.depth(depth) };
  }

  /** Confirmed trades, newest first. */
  getTrades(marketId: number, limit: number): Trade[] {
    const t = this.trades.get(marketId);
    if (!t) throw new EngineError("UNKNOWN_MARKET", `unknown market ${marketId}`);
    return t.slice(-limit).reverse();
  }

  getOrder(hash: Hex): OrderView | undefined {
    const rec = this.orders.get(hash.toLowerCase() as Hex);
    return rec && this.view(rec);
  }

  /** Orders of a trader that are resting or still have matches awaiting settlement. */
  getOpenOrders(trader: Address): OrderView[] {
    const hashes = this.ordersByTrader.get(trader.toLowerCase());
    if (!hashes) return [];
    const out: OrderView[] = [];
    for (const h of hashes) {
      const rec = this.orders.get(h)!;
      if (rec.remaining > 0n || rec.pending > 0n) out.push(this.view(rec));
    }
    return out;
  }

  settlementStatus(): SettlementStatus {
    return {
      queued: this.queue.length,
      inFlight: this.current?.matches.length ?? 0,
      stalled: this.stalled,
      lastError: this.lastError,
      settled: this.settledCount,
      failed: this.failedCount,
    };
  }

  // --------------------------------------------------------------------- intake

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const { order } = req;
    const postOnly = req.postOnly ?? false;
    const ioc = req.ioc ?? false;

    const market = this.markets.get(order.marketId);
    if (!market) throw new EngineError("UNKNOWN_MARKET", `unknown market ${order.marketId}`);
    if (!market.active) throw new EngineError("MARKET_INACTIVE", `market ${order.marketId} is not active`);
    if (this.stalled) {
      // Do not pile up matches while their settlement outcome cannot be determined.
      throw new EngineError("CHAIN_UNAVAILABLE", "settlement is stalled; not accepting orders");
    }
    if (postOnly && ioc) throw new EngineError("INVALID_ORDER", "postOnly and ioc are mutually exclusive");
    if (order.size <= 0n) throw new EngineError("INVALID_ORDER", "size must be positive");
    if (order.limitPrice <= 0n) throw new EngineError("INVALID_ORDER", "limitPrice must be positive");
    if (order.size < market.minOrderSize) {
      throw new EngineError("BELOW_MIN_SIZE", `size is below the market minimum ${market.minOrderSize}`);
    }
    if (this.isExpired(order)) throw new EngineError("EXPIRED", "order is expired or expires too soon");

    const hash = hashOrder(this.domain, order);
    const traderKey = order.trader.toLowerCase();
    this.checkNotSeen(hash, traderKey, order.nonce);

    if (!(await verifyOrderSignature(this.domain, order, req.signature))) {
      throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 signature by order.trader");
    }

    const priorFilled = this.preTradeChecks ? await this.preTradeCheck(order, hash, market) : 0n;

    // ---- synchronous from here: no awaits between the re-checks and the book update.
    this.checkNotSeen(hash, traderKey, order.nonce);
    const now = this.bookNow();
    const book = this.books.get(order.marketId)!;
    const bookOrder: BookOrder = { id: hash, trader: traderKey, isBuy: order.isBuy, price: order.limitPrice, expiry: order.expiry };
    const placeSize = order.size - priorFilled;
    const res = book.place(bookOrder, placeSize, { now, postOnly, ioc });
    if (!res.accepted) {
      this.applyBookEffects(order.marketId, { fills: [], expired: res.expired });
      if (res.expired.length > 0) this.emit("book", order.marketId);
      switch (res.reason) {
        case "post_only_would_cross":
          throw new EngineError("POST_ONLY_WOULD_CROSS", "post-only order would take liquidity");
        case "expired":
          throw new EngineError("EXPIRED", "order is expired or expires too soon");
        case "below_min_size":
          throw new EngineError("BELOW_MIN_SIZE", `unfilled size is below the market minimum ${market.minOrderSize}`);
        case "duplicate":
          throw new EngineError("DUPLICATE_ORDER", "order already submitted");
        default:
          throw new EngineError("INVALID_ORDER", res.reason);
      }
    }

    const rec: OrderRecord = {
      hash,
      order,
      signature: req.signature as Hex,
      traderKey,
      postOnly,
      ioc,
      seq: res.seq,
      remaining: placeSize,
      pending: 0n,
      filled: priorFilled,
      userCancelled: false,
      strikes: 0,
      createdAt: Date.now(),
    };
    this.orders.set(hash, rec);
    this.usedNonces.set(nonceKey(traderKey, order.nonce), hash);
    let set = this.ordersByTrader.get(traderKey);
    if (!set) this.ordersByTrader.set(traderKey, (set = new Set()));
    set.add(hash);

    this.applyBookEffects(order.marketId, { fills: res.fills, expired: res.expired });
    if (res.cancelled > 0n) {
      rec.remaining -= res.cancelled;
      rec.closed = {
        status: "cancelled",
        reason: res.cancelReason === "self_trade" ? "self-trade prevention: would match own resting order" : "IOC remainder cancelled",
      };
    }
    if (rec.remaining !== res.rested) throw new Error("invariant violated: record and book disagree on resting size");
    this.emit("book", order.marketId);

    return {
      orderHash: hash,
      status: this.status(rec),
      fills: res.fills.map((f) => ({
        makerOrderHash: f.makerId as Hex,
        takerOrderHash: f.takerId as Hex,
        price: f.price,
        size: f.size,
        status: "pending" as const,
      })),
      remaining: rec.remaining,
      ...(rec.closed ? { reason: rec.closed.reason } : {}),
    };
  }

  /** Cancel by order hash with a signed EIP-712 `Cancel(trader, nonce)`. Idempotent. */
  async cancel(orderHash: Hex, signature: string): Promise<OrderView> {
    const rec = this.orders.get(orderHash.toLowerCase() as Hex);
    if (!rec) throw new EngineError("NOT_FOUND", "unknown order");
    if (!(await verifyCancelSignature(this.domain, rec.order.trader, rec.order.nonce, signature))) {
      throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 Cancel signature by the order's trader");
    }
    this.cancelNonce(rec.order.trader, rec.order.nonce, "cancelled by trader");
    return this.view(rec);
  }

  /**
   * Mark (trader, nonce) as cancelled: the order using it (if any) leaves the book and
   * later orders with that nonce are rejected. Also called for on-chain OrderCancelled.
   * Matches already handed to settlement are not recalled.
   */
  cancelNonce(trader: Address, nonce: bigint, reason: string): void {
    const traderKey = trader.toLowerCase();
    const key = nonceKey(traderKey, nonce);
    this.cancelledNonces.add(key);
    const hash = this.usedNonces.get(key);
    const rec = hash && this.orders.get(hash);
    if (!rec || rec.userCancelled) return;
    rec.userCancelled = true;
    if (rec.closed) return;
    if (rec.remaining > 0n) {
      this.books.get(rec.order.marketId)!.cancel(rec.hash);
      rec.remaining = 0n;
      rec.closed = { status: "cancelled", reason };
      this.emit("book", rec.order.marketId);
    }
  }

  /** Drop expired resting orders from every book. */
  sweepExpired(): void {
    const now = this.bookNow();
    for (const [marketId, book] of this.books) {
      const expired = book.pruneExpired(now);
      if (expired.length === 0) continue;
      this.applyBookEffects(marketId, { fills: [], expired });
      this.emit("book", marketId);
    }
  }

  // ------------------------------------------------------------------ internals

  private bookNow(): bigint {
    return BigInt(this.clock()) + this.expiryBuffer;
  }

  private isExpired(order: Order): boolean {
    return order.expiry !== 0n && order.expiry <= this.bookNow();
  }

  private checkNotSeen(hash: Hex, traderKey: string, nonce: bigint): void {
    if (this.orders.has(hash)) throw new EngineError("DUPLICATE_ORDER", "order already submitted");
    const key = nonceKey(traderKey, nonce);
    if (this.cancelledNonces.has(key)) throw new EngineError("NONCE_CANCELLED", "nonce has been cancelled");
    if (this.usedNonces.has(key)) throw new EngineError("NONCE_REUSED", "nonce already used by another order of this trader");
  }

  /** Returns the size already filled on-chain. */
  private async preTradeCheck(order: Order, hash: Hex, market: MarketConfig): Promise<bigint> {
    const chain = this.chain!;
    let cancelled: boolean, filled: bigint, position: bigint, free: bigint, index: bigint;
    try {
      [cancelled, filled, position] = await Promise.all([
        chain.isCancelled(order.trader, order.nonce),
        chain.filledSize(hash),
        chain.positionSize(order.trader, order.marketId),
      ]);
      if (cancelled) {
        this.cancelledNonces.add(nonceKey(order.trader.toLowerCase(), order.nonce));
        throw new EngineError("NONCE_CANCELLED", "nonce has been cancelled on-chain");
      }
      if (filled >= order.size) throw new EngineError("ALREADY_FILLED", "order is already fully filled on-chain");
      const unfilled = order.size - filled;
      if (isReducing(position, order.isBuy, unfilled)) return filled;
      const opposite = position !== 0n && (order.isBuy ? position < 0n : position > 0n);
      if (order.reduceOnly) {
        if (!opposite) throw new EngineError("REDUCE_ONLY_NO_POSITION", "reduce-only order has no opposite position to reduce");
        return filled;
      }
      [free, index] = await Promise.all([chain.freeCollateral(order.trader), chain.indexPrice(order.marketId)]);
      const absPos = position < 0n ? -position : position;
      const added = opposite ? unfilled - absPos : unfilled;
      const required = (notionalUsdc(added, index) * market.initialMarginBps) / BPS;
      if (free < required) {
        throw new EngineError("INSUFFICIENT_MARGIN", `free collateral ${free} is below the initial margin ${required} for this order`);
      }
      return filled;
    } catch (e) {
      if (e instanceof EngineError) throw e;
      this.log.warn("pre-trade check failed", { error: errMessage(e) });
      throw new EngineError("CHAIN_UNAVAILABLE", "could not verify the order against the chain; try again");
    }
  }

  private status(rec: OrderRecord): OrderStatus {
    if (rec.closed) return rec.closed.status;
    if (rec.remaining > 0n) return rec.pending + rec.filled > 0n ? "partially_filled" : "open";
    return rec.pending > 0n ? "pending_settlement" : "filled";
  }

  private view(rec: OrderRecord): OrderView {
    return {
      orderHash: rec.hash,
      order: rec.order,
      status: this.status(rec),
      remaining: rec.remaining,
      pending: rec.pending,
      filled: rec.filled,
      postOnly: rec.postOnly,
      ioc: rec.ioc,
      ...(rec.closed ? { reason: rec.closed.reason } : {}),
      createdAt: rec.createdAt,
    };
  }

  private toBookOrder(rec: OrderRecord): BookOrder {
    return { id: rec.hash, trader: rec.traderKey, isBuy: rec.order.isBuy, price: rec.order.limitPrice, expiry: rec.order.expiry };
  }

  /** Mirror what the book did into the order records and queue the fills for settlement. */
  private applyBookEffects(marketId: number, fx: BookEffects): void {
    for (const f of fx.fills) {
      const maker = this.orders.get(f.makerId as Hex)!;
      const taker = this.orders.get(f.takerId as Hex)!;
      for (const rec of [maker, taker]) {
        rec.remaining -= f.size;
        rec.pending += f.size;
      }
      this.queue.push({
        id: `m${++this.matchSeq}`,
        marketId,
        maker: maker.order,
        makerSig: maker.signature,
        makerHash: maker.hash,
        taker: taker.order,
        takerSig: taker.signature,
        takerHash: taker.hash,
        fillSize: f.size,
        price: f.price,
      });
    }
    for (const id of fx.expired) {
      const rec = this.orders.get(id as Hex);
      if (!rec || rec.closed) continue;
      rec.remaining = 0n;
      rec.closed = { status: "expired", reason: "order expired" };
    }
    for (const { id } of fx.selfTradeCancelled ?? []) {
      const rec = this.orders.get(id as Hex);
      if (!rec || rec.closed) continue;
      rec.remaining = 0n;
      rec.closed = { status: "cancelled", reason: "self-trade prevention: would match own resting order" };
    }
    if (fx.fills.length > 0) this.kick();
  }

  // ----------------------------------------------------------------- settlement

  private kick(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.runSettlement().finally(() => {
      this.loop = null;
      // Matches may have been queued while the last batch was being finalised.
      if (this.queue.length > 0 || this.current) this.kick();
    });
  }

  private async runSettlement(): Promise<void> {
    // Yield once so that all matches of one incoming order end up in the same batch.
    await Promise.resolve();
    let reverts = 0;
    while (!this.stopped && (this.current || this.queue.length > 0)) {
      this.current ??= { id: `b${++this.batchSeq}`, matches: this.queue.splice(0, this.maxBatchSize) };
      const batch = this.current;
      let results: MatchResult[];
      try {
        results = await this.settler.settle(batch);
        if (results.length !== batch.matches.length) throw new Error("settler returned a wrong number of results");
      } catch (e) {
        this.lastError = errMessage(e);
        if (e instanceof BatchRevertedError && ++reverts >= this.maxBatchReverts) {
          // Definitively not settled, repeatedly: give up on these matches.
          this.log.error("batch reverted repeatedly; failing its matches", { batch: batch.id, error: this.lastError });
          results = batch.matches.map(() => ({ status: "failed", txHash: e.txHash, reason: "0x" }) as const);
          const verdicts = new Map(batch.matches.map((_, i) => [i, UNATTRIBUTED]));
          this.applyResults(batch, results, verdicts);
          this.current = null;
          reverts = 0;
          this.stalled = false;
          continue;
        }
        // Unknown outcome (or a revert we may retry): keep the batch and ask the settler
        // again with the same id. Nothing else is submitted meanwhile, so ordering holds.
        this.stalled = true;
        this.log.error("settlement attempt failed; will retry", { batch: batch.id, error: this.lastError });
        await this.retryPause();
        continue;
      }
      const verdicts = new Map<number, Verdict>();
      for (let i = 0; i < results.length; i++) {
        if (results[i]!.status === "failed") verdicts.set(i, await this.classify(batch.matches[i]!));
      }
      this.applyResults(batch, results, verdicts);
      this.current = null;
      reverts = 0;
      this.stalled = false;
      this.lastError = null;
    }
  }

  private retryPause(): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, this.retryDelayMs);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wakeRetry = null;
        resolve();
      }
      this.wakeRetry = done;
    });
  }

  private async classify(match: Match): Promise<Verdict> {
    if (!this.chain) return UNATTRIBUTED;
    try {
      return await classifyFailure(match, this.markets.get(match.marketId)!, this.chain);
    } catch (e) {
      this.log.warn("could not attribute on-chain failure", { match: match.id, error: errMessage(e) });
      return UNATTRIBUTED;
    }
  }

  /** Apply a batch's final outcomes in on-chain order. Synchronous. */
  private applyResults(batch: Batch, results: MatchResult[], verdicts: Map<number, Verdict>): void {
    const touched = new Set<number>();
    batch.matches.forEach((m, i) => {
      const r = results[i]!;
      if (r.status === "settled") this.applySettled(m, r.txHash);
      else {
        this.applyFailed(m, verdicts.get(i) ?? UNATTRIBUTED, r.reason);
        touched.add(m.marketId);
      }
    });
    for (const marketId of touched) this.emit("book", marketId);
  }

  private applySettled(m: Match, txHash: Hex): void {
    for (const hash of [m.makerHash, m.takerHash]) {
      const rec = this.orders.get(hash)!;
      rec.pending -= m.fillSize;
      rec.filled += m.fillSize;
      rec.strikes = 0;
    }
    this.settledCount++;
    this.lastPrice.set(m.marketId, m.price);
    const trade: Trade = {
      id: `t${++this.tradeSeq}`,
      marketId: m.marketId,
      price: m.price,
      size: m.fillSize,
      takerIsBuy: m.taker.isBuy,
      maker: m.maker.trader,
      taker: m.taker.trader,
      makerOrderHash: m.makerHash,
      takerOrderHash: m.takerHash,
      txHash,
      timestamp: Date.now(),
    };
    const list = this.trades.get(m.marketId)!;
    list.push(trade);
    if (list.length > this.tradeHistory) list.splice(0, list.length - this.tradeHistory);
    this.emit("trade", trade);
  }

  /**
   * A match failed on-chain: neither order was filled by it.
   *  - A side at fault is removed from the book for good ("rejected").
   *  - An innocent side gets the size back at its original time priority.
   *  - If no side can be blamed, the taker is dropped (it never retries) and the
   *    maker gets its size back plus a strike; `maxOrderStrikes` consecutive strikes
   *    remove it. So no order can retry a failing match forever.
   */
  private applyFailed(m: Match, verdict: Verdict, reason: Hex): void {
    this.failedCount++;
    const maker = this.orders.get(m.makerHash)!;
    const taker = this.orders.get(m.takerHash)!;
    maker.pending -= m.fillSize;
    taker.pending -= m.fillSize;
    const unattributed = !verdict.maker.atFault && !verdict.taker.atFault;
    this.log.warn("match failed on-chain", {
      match: m.id,
      makerOrderHash: m.makerHash,
      takerOrderHash: m.takerHash,
      revertData: reason,
      makerFault: verdict.maker.reason ?? null,
      takerFault: verdict.taker.reason ?? null,
    });

    if (verdict.taker.atFault) this.reject(taker, `match failed on-chain: ${verdict.taker.reason ?? "order at fault"}`);
    else if (unattributed) this.reject(taker, "match failed on-chain (cause not attributable); taker order dropped");

    if (verdict.maker.atFault) {
      this.reject(maker, `match failed on-chain: ${verdict.maker.reason ?? "order at fault"}`);
    } else if (unattributed && ++maker.strikes >= this.maxOrderStrikes) {
      this.reject(maker, "matches failed on-chain repeatedly");
    } else {
      this.giveBack(maker, m.fillSize);
    }
    // The taker is restored after the maker's fate is decided, so that it can never
    // be re-matched against a maker that is about to be removed.
    if (!verdict.taker.atFault && !unattributed) this.giveBack(taker, m.fillSize);
  }

  private reject(rec: OrderRecord, reason: string): void {
    if (rec.closed) return;
    if (rec.remaining > 0n) this.books.get(rec.order.marketId)!.cancel(rec.hash);
    rec.remaining = 0n;
    rec.closed = { status: "rejected", reason };
  }

  /** Return `size` of an undone match to an innocent order, if it is still eligible to rest. */
  private giveBack(rec: OrderRecord, size: bigint): void {
    if (rec.closed) return;
    if (rec.userCancelled) {
      rec.closed = { status: "cancelled", reason: "cancelled by trader" };
      return;
    }
    if (rec.ioc) {
      rec.closed = { status: "cancelled", reason: "IOC order: match failed on-chain, size not re-posted" };
      return;
    }
    if (this.isExpired(rec.order)) {
      if (rec.remaining > 0n) this.books.get(rec.order.marketId)!.cancel(rec.hash);
      rec.remaining = 0n;
      rec.closed = { status: "expired", reason: "order expired" };
      return;
    }
    const book = this.books.get(rec.order.marketId)!;
    rec.remaining += size;
    const fx = book.restore(this.toBookOrder(rec), rec.seq, size, this.bookNow());
    this.applyBookEffects(rec.order.marketId, fx);
  }
}
