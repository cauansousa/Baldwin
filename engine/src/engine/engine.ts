import { EventEmitter } from "node:events";
import { OrderBook, type Band, type BookFill, type BookOrder, type CancelReason, type Level, type RestoreOptions } from "../book/orderbook.ts";
import type { ChainReader } from "../chain/types.ts";
import { hashOrder, verifyCancelSignature, verifyOrderSignature, type Domain } from "../signing.ts";
import { BatchRevertedError, type Batch, type MatchResult, type Settler } from "../settlement/types.ts";
import { errMessage, silentLogger, type Address, type Hex, type Logger, type MarketConfig, type Match, type Order } from "../types.ts";
import { MemoryDeadNonceStore, type DeadNonceStore } from "./deadNonces.ts";
import { attributeFromRevert, classifyFailure, priceBand, requiredCollateral, UNATTRIBUTED, type MarginMarket, type OpenExposure, type Verdict } from "./reconcile.ts";

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
  | "INVALID_EXPIRY"
  | "PRICE_OUTSIDE_BAND"
  | "TRADER_SUSPENDED"
  | "EXCHANGE_PAUSED"
  | "MARKET_HALTED"
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
  INVALID_EXPIRY: 400,
  PRICE_OUTSIDE_BAND: 422,
  TRADER_SUSPENDED: 429,
  EXCHANGE_PAUSED: 503,
  MARKET_HALTED: 503,
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
  /** Resting orders are dropped this many seconds before their expiry. Default 30. */
  expiryBufferSec?: number;
  /** Minimum time to expiry at intake (never less than the buffer). Default 60. */
  minTimeToExpirySec?: number;
  /** Maximum time to expiry at intake; also bounds the dead-nonce set. Default 7 days. */
  maxTimeToExpirySec?: number;
  /** Durable set of dead (trader, nonce) pairs. Default: in memory only. */
  deadNonces?: DeadNonceStore;
  /** At-fault on-chain failures within `faultWindowSec` after which a trader's new orders are refused. Default 3. */
  faultThreshold?: number;
  /** Default 600. */
  faultWindowSec?: number;
  /** Chain state (index, pause) older than this is refreshed before an order is taken. Default 30000. */
  maxChainStateAgeMs?: number;
  /** Market parameters are re-read at most this often. Default 30000. */
  marketRefreshMs?: number;
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
  reduceOnly: boolean;
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
  cancelled?: { id: string; size: bigint; reason: CancelReason }[];
}

interface MarketState {
  /** Last index price read; null if the last read failed (market halted). */
  index: bigint | null;
  /** Band from the last successful read; kept while the index is unavailable. */
  band: Band | undefined;
}

const CANCEL_TEXT: Record<CancelReason, string> = {
  ioc: "IOC remainder cancelled",
  self_trade: "self-trade prevention: would match own resting order",
  price_band: "price outside the oracle price band",
  halted: "exchange paused or market inactive: only reduce-only orders can trade",
  post_only: "post-only order would have taken liquidity",
};

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
  private readonly dead: DeadNonceStore;
  /** Orders currently between validation and the book (hash -> order as submitted). */
  private readonly intake = new Map<Hex, Order>();
  private readonly traderLocks = new Map<string, Promise<unknown>>();
  /** trader -> unix seconds of recent at-fault on-chain failures. */
  private readonly faults = new Map<string, number[]>();
  private readonly marketState = new Map<number, MarketState>();
  private exchangePaused = false;
  private bandBps: bigint | null = null;
  private chainStateAt = 0;
  private marketsAt = 0;
  private refreshing: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly trades = new Map<number, Trade[]>();
  private readonly lastPrice = new Map<number, bigint>();

  private readonly settler: Settler;
  private readonly chain: ChainReader | undefined;
  private readonly preTradeChecks: boolean;
  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly expiryBuffer: bigint;
  private readonly minTimeToExpiry: bigint;
  private readonly maxTimeToExpiry: bigint;
  private readonly faultThreshold: number;
  private readonly faultWindowSec: number;
  private readonly maxChainStateAgeMs: number;
  private readonly marketRefreshMs: number;
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
    this.expiryBuffer = BigInt(opts.expiryBufferSec ?? 30);
    const minTtl = BigInt(opts.minTimeToExpirySec ?? 60);
    this.minTimeToExpiry = minTtl > this.expiryBuffer ? minTtl : this.expiryBuffer;
    this.maxTimeToExpiry = BigInt(opts.maxTimeToExpirySec ?? 7 * 24 * 3600);
    this.dead = opts.deadNonces ?? new MemoryDeadNonceStore();
    this.faultThreshold = opts.faultThreshold ?? 3;
    this.faultWindowSec = opts.faultWindowSec ?? 600;
    this.maxChainStateAgeMs = opts.maxChainStateAgeMs ?? 30_000;
    this.marketRefreshMs = opts.marketRefreshMs ?? 30_000;
    this.maxBatchSize = opts.maxBatchSize ?? 20;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.maxBatchReverts = opts.maxBatchReverts ?? 3;
    this.maxOrderStrikes = opts.maxOrderStrikes ?? 3;
    this.tradeHistory = opts.tradeHistory ?? 200;
    for (const m of opts.markets) {
      this.markets.set(m.marketId, m);
      this.books.set(m.marketId, new OrderBook(m.minOrderSize));
      this.trades.set(m.marketId, []);
      this.marketState.set(m.marketId, { index: null, band: undefined });
    }
    this.marketsAt = Date.now();
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the periodic expiry sweep and, with a chain reader, the chain-state refresh. */
  start(sweepIntervalMs = 1000, chainRefreshMs = 2000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), sweepIntervalMs);
    this.sweepTimer.unref();
    if (this.chain) {
      void this.refreshChainState();
      this.refreshTimer = setInterval(() => void this.refreshChainState(), chainRefreshMs);
      this.refreshTimer.unref();
    }
  }

  /** Stop timers and the settlement loop (the batch in flight, if any, is awaited). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.sweepTimer = this.refreshTimer = null;
    this.wakeRetry?.();
    await this.loop;
  }

  /**
   * Re-read pause flag, index prices (hence price bands) and, now and then, market
   * parameters. Resting orders that are now on the wrong side of their band are
   * cancelled. A market whose index cannot be read is halted for new orders until it
   * can. Never rejects.
   */
  refreshChainState(): Promise<void> {
    if (!this.chain) return Promise.resolve();
    this.refreshing ??= this.doRefresh(this.chain).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(chain: ChainReader): Promise<void> {
    try {
      this.bandBps ??= await chain.maxPriceDeviationBps();
      this.exchangePaused = await chain.paused();
      if (Date.now() - this.marketsAt >= this.marketRefreshMs) {
        for (const [marketId, old] of this.markets) {
          const fresh = await chain.getMarket(marketId);
          this.markets.set(marketId, { ...fresh, symbol: fresh.symbol || old.symbol });
          this.books.get(marketId)!.minOrderSize = fresh.minOrderSize;
        }
        this.marketsAt = Date.now();
      }
      for (const [marketId, st] of this.marketState) {
        try {
          st.index = await chain.indexPrice(marketId);
          st.band = priceBand(st.index, this.bandBps);
        } catch (e) {
          if (st.index !== null) this.log.warn("index price unavailable; market halted", { marketId, error: errMessage(e) });
          st.index = null;
        }
      }
      this.chainStateAt = Date.now();
    } catch (e) {
      for (const st of this.marketState.values()) st.index = null;
      this.log.warn("chain state refresh failed; markets halted", { error: errMessage(e) });
    }
    try {
      for (const [marketId, st] of this.marketState) {
        if (!st.band) continue;
        const pruned = this.books.get(marketId)!.pruneOutOfBand(st.band);
        if (pruned.length === 0) continue;
        this.applyBookEffects(marketId, { fills: [], expired: [], cancelled: pruned.map((o) => ({ ...o, reason: "price_band" as const })) });
        this.emit("book", marketId);
      }
    } catch (e) {
      this.log.error("error while enforcing price bands", { error: errMessage(e) });
    }
  }

  private async ensureChainState(): Promise<void> {
    if (!this.chain) return;
    if (this.chainStateAt === 0 || Date.now() - this.chainStateAt > this.maxChainStateAgeMs) await this.refreshChainState();
  }

  /** Current exchange-level view the engine matches under (for /health). */
  chainStatus(): { paused: boolean; markets: { marketId: number; indexPrice: bigint | null; band: Band | null }[] } | null {
    if (!this.chain) return null;
    return {
      paused: this.exchangePaused,
      markets: [...this.marketState].map(([marketId, st]) => ({ marketId, indexPrice: st.index, band: st.band ?? null })),
    };
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
    return this.liveOrders(trader.toLowerCase()).map((rec) => this.view(rec));
  }

  /**
   * Live records of a trader. Orders that are neither resting nor awaiting settlement
   * can never become live again, so they are dropped from the per-trader index here.
   */
  private liveOrders(traderKey: string): OrderRecord[] {
    const hashes = this.ordersByTrader.get(traderKey);
    if (!hashes) return [];
    const out: OrderRecord[] = [];
    for (const h of hashes) {
      const rec = this.orders.get(h)!;
      if (rec.remaining > 0n || rec.pending > 0n) out.push(rec);
      else hashes.delete(h);
    }
    if (hashes.size === 0) this.ordersByTrader.delete(traderKey);
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
    const now = BigInt(this.clock());
    if (order.expiry === 0n) throw new EngineError("INVALID_EXPIRY", "orders must have an expiry");
    if (order.expiry <= now + this.minTimeToExpiry) {
      throw new EngineError("EXPIRED", `order is expired or expires in less than ${this.minTimeToExpiry} seconds`);
    }
    if (order.expiry > now + this.maxTimeToExpiry) {
      throw new EngineError("INVALID_EXPIRY", `expiry must be at most ${this.maxTimeToExpiry} seconds from now`);
    }

    const hash = hashOrder(this.domain, order);
    const traderKey = order.trader.toLowerCase();
    this.checkNotSeen(hash, order);
    if (this.isSuspended(traderKey)) {
      throw new EngineError("TRADER_SUSPENDED", "too many of this trader's orders failed on-chain recently; try again later");
    }

    // From here on a signed Cancel for this hash is honoured even though the order is
    // not in the book yet (the Cancel signature is checked on its own, so it does not
    // matter that this order's signature has not been verified at this point).
    this.intake.set(hash, order);
    try {
      if (!(await verifyOrderSignature(this.domain, order, req.signature))) {
        throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 signature by order.trader");
      }
      // One submission per trader at a time, so that the aggregate margin check sees
      // every earlier order of the trader.
      return await this.withTraderLock(traderKey, async () => {
        await this.ensureChainState();
        const state = this.marketState.get(order.marketId)!;
        if (this.chain && state.index === null) {
          throw new EngineError("MARKET_HALTED", "no fresh index price for this market; not accepting orders");
        }
        if (this.exchangePaused && !order.reduceOnly) {
          throw new EngineError("EXCHANGE_PAUSED", "exchange is paused: only reduce-only orders are accepted");
        }
        const priorFilled = this.preTradeChecks ? await this.preTradeCheck(order, hash) : 0n;
        return this.insert(req, hash, priorFilled);
      });
    } finally {
      this.intake.delete(hash);
    }
  }

  /** Final checks and the book update. Synchronous: nothing can interleave. */
  private insert(req: SubmitRequest, hash: Hex, priorFilled: bigint): SubmitResult {
    const { order } = req;
    const postOnly = req.postOnly ?? false;
    const ioc = req.ioc ?? false;
    const traderKey = order.trader.toLowerCase();
    const market = this.markets.get(order.marketId)!;
    this.checkNotSeen(hash, order);
    const book = this.books.get(order.marketId)!;
    const bookOrder: BookOrder = {
      id: hash,
      trader: traderKey,
      isBuy: order.isBuy,
      price: order.limitPrice,
      expiry: order.expiry,
      postOnly,
      reduceOnly: order.reduceOnly,
    };
    const placeSize = order.size - priorFilled;
    // The remainder of an order that is already partly filled on-chain may be below the minimum.
    const res = book.place(bookOrder, placeSize, { ...this.matchOptions(order.marketId), postOnly, ioc, allowBelowMin: priorFilled > 0n });
    if (!res.accepted) {
      this.applyBookEffects(order.marketId, { fills: [], expired: res.expired });
      if (res.expired.length > 0) this.emit("book", order.marketId);
      switch (res.reason) {
        case "post_only_would_cross":
          throw new EngineError("POST_ONLY_WOULD_CROSS", "post-only order would take liquidity");
        case "post_only_outside_band":
          throw new EngineError("PRICE_OUTSIDE_BAND", "post-only order is priced on the wrong side of the oracle price band");
        case "expired":
          throw new EngineError("EXPIRED", "order is expired or expires too soon");
        case "below_min_size":
          throw new EngineError("BELOW_MIN_SIZE", `size is below the market minimum ${market.minOrderSize}`);
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
      reduceOnly: order.reduceOnly,
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
    // An IOC order must never come back as a resting order, whatever happens to it.
    if (ioc) this.markDead(order);

    this.applyBookEffects(order.marketId, { fills: res.fills, expired: res.expired });
    if (res.cancelled > 0n) {
      rec.remaining -= res.cancelled;
      this.close(rec, "cancelled", CANCEL_TEXT[res.cancelReason ?? "ioc"]);
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

  /**
   * Cancel by order hash with a signed EIP-712 `Cancel(trader, nonce)`. Idempotent.
   * The (trader, nonce) pair is durably recorded as dead before this resolves. Works
   * for an order that is still in its intake checks: it will then not enter the book.
   */
  async cancel(orderHash: Hex, signature: string): Promise<OrderView> {
    const hash = orderHash.toLowerCase() as Hex;
    const order = this.orders.get(hash)?.order ?? this.intake.get(hash);
    if (!order) throw new EngineError("NOT_FOUND", "unknown order");
    if (!(await verifyCancelSignature(this.domain, order.trader, order.nonce, signature))) {
      throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 Cancel signature by the order's trader");
    }
    this.cancelNonce(order.trader, order.nonce, "cancelled by trader", order.expiry);
    const rec = this.orders.get(hash);
    if (rec) return this.view(rec);
    // Cancelled before it reached the book.
    return {
      orderHash: hash,
      order,
      status: "cancelled",
      remaining: 0n,
      pending: 0n,
      filled: 0n,
      postOnly: false,
      ioc: false,
      reason: "cancelled by trader",
      createdAt: Date.now(),
    };
  }

  /**
   * Mark (trader, nonce) as cancelled: the order using it (if any) leaves the book and
   * later orders with that nonce are rejected. Also called for on-chain OrderCancelled.
   * Matches already handed to settlement are not recalled. Throws if the cancel cannot
   * be made durable (nothing is changed then).
   */
  cancelNonce(trader: Address, nonce: bigint, reason: string, expiry?: bigint): void {
    const traderKey = trader.toLowerCase();
    const hash = this.usedNonces.get(nonceKey(traderKey, nonce));
    const rec = hash && this.orders.get(hash);
    // Without a known expiry keep the entry for as long as any acceptable order could live.
    const until = expiry ?? rec?.order.expiry ?? BigInt(this.clock()) + this.maxTimeToExpiry + 1n;
    this.dead.add(trader, nonce, until);
    if (!rec || rec.userCancelled) return;
    rec.userCancelled = true;
    if (rec.closed) return;
    if (rec.remaining > 0n) {
      this.books.get(rec.order.marketId)!.cancel(rec.hash);
      rec.remaining = 0n;
      this.close(rec, "cancelled", reason);
      this.emit("book", rec.order.marketId);
    }
  }

  /** Drop expired resting orders from every book. */
  sweepExpired(): void {
    const now = this.bookNow();
    this.dead.prune(BigInt(this.clock()));
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

  private checkNotSeen(hash: Hex, order: Order): void {
    if (this.orders.has(hash)) throw new EngineError("DUPLICATE_ORDER", "order already submitted");
    if (this.dead.has(order.trader, order.nonce)) {
      throw new EngineError("NONCE_CANCELLED", "this nonce was cancelled or its order was closed; sign a new order");
    }
    if (this.usedNonces.has(nonceKey(order.trader.toLowerCase(), order.nonce))) {
      throw new EngineError("NONCE_REUSED", "nonce already used by another order of this trader");
    }
  }

  private matchOptions(marketId: number): RestoreOptions {
    return {
      now: this.bookNow(),
      band: this.marketState.get(marketId)?.band,
      reduceOnlyMakersOnly: this.exchangePaused || !this.markets.get(marketId)!.active,
    };
  }

  private async withTraderLock<T>(traderKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.traderLocks.get(traderKey) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.traderLocks.set(traderKey, tail);
    try {
      return await run;
    } finally {
      if (this.traderLocks.get(traderKey) === tail) this.traderLocks.delete(traderKey);
    }
  }

  private isSuspended(traderKey: string): boolean {
    const list = this.faults.get(traderKey);
    if (!list) return false;
    const cutoff = this.clock() - this.faultWindowSec;
    while (list.length > 0 && list[0]! <= cutoff) list.shift();
    if (list.length === 0) this.faults.delete(traderKey);
    return list.length >= this.faultThreshold;
  }

  private markDead(order: Order): void {
    try {
      this.dead.add(order.trader, order.nonce, order.expiry);
    } catch (e) {
      // The in-memory set already holds it; only durability across a restart is lost.
      this.log.error("could not persist dead nonce", { trader: order.trader, nonce: order.nonce, error: errMessage(e) });
    }
  }

  /** Close an order for good. Everything but plain expiry also kills its nonce. */
  private close(rec: OrderRecord, status: "cancelled" | "expired" | "rejected", reason: string): void {
    if (rec.closed) return;
    rec.closed = { status, reason };
    if (status !== "expired") this.markDead(rec.order);
  }

  /**
   * On-chain checks before an order enters the book: nonce not cancelled, not already
   * filled, reduce-only has something to reduce, and free collateral covers this order
   * together with all of the trader's other open orders (see `requiredCollateral`).
   * Returns the size already filled on-chain.
   */
  private async preTradeCheck(order: Order, hash: Hex): Promise<bigint> {
    const chain = this.chain!;
    const traderKey = order.trader.toLowerCase();
    try {
      const [cancelled, filled] = await Promise.all([chain.isCancelled(order.trader, order.nonce), chain.filledSize(hash)]);
      if (cancelled) {
        this.markDead(order);
        throw new EngineError("NONCE_CANCELLED", "nonce has been cancelled on-chain");
      }
      if (filled >= order.size) throw new EngineError("ALREADY_FILLED", "order is already fully filled on-chain");

      if (order.reduceOnly) {
        // Enforced per fill by the contract; here only the obvious dead-on-arrival case.
        const position = await chain.positionSize(order.trader, order.marketId);
        const opposite = position !== 0n && (order.isBuy ? position < 0n : position > 0n);
        if (!opposite) throw new EngineError("REDUCE_ONLY_NO_POSITION", "reduce-only order has no opposite position to reduce");
        return filled;
      }

      const exposures: OpenExposure[] = this.liveOrders(traderKey)
        .filter((r) => !r.reduceOnly)
        .map((r) => ({ marketId: r.order.marketId, isBuy: r.order.isBuy, size: r.remaining + r.pending, limitPrice: r.order.limitPrice }));
      exposures.push({ marketId: order.marketId, isBuy: order.isBuy, size: order.size - filled, limitPrice: order.limitPrice });
      const marketIds = [...new Set(exposures.map((e) => e.marketId))];
      const [free, ...positions] = await Promise.all([
        chain.freeCollateral(order.trader),
        ...marketIds.map((id) => chain.positionSize(order.trader, id)),
      ]);
      const marginMarkets = new Map<number, MarginMarket>();
      marketIds.forEach((id, i) => {
        const st = this.marketState.get(id)!;
        const cfg = this.markets.get(id)!;
        // A halted market's orders cannot be valued (and cannot trade); skip them.
        if (st.index === null) return;
        marginMarkets.set(id, { index: st.index, band: st.band, position: positions[i]!, initialMarginBps: cfg.initialMarginBps, takerFeeBps: cfg.takerFeeBps });
      });
      const required = requiredCollateral(exposures, marginMarkets);
      if (free < required) {
        throw new EngineError(
          "INSUFFICIENT_MARGIN",
          `free collateral ${free} is below the ${required} needed for this order together with the trader's other open orders`,
        );
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
    return {
      id: rec.hash,
      trader: rec.traderKey,
      isBuy: rec.order.isBuy,
      price: rec.order.limitPrice,
      expiry: rec.order.expiry,
      postOnly: rec.postOnly,
      reduceOnly: rec.reduceOnly,
    };
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
      this.close(rec, "expired", "order expired");
    }
    for (const { id, reason } of fx.cancelled ?? []) {
      const rec = this.orders.get(id as Hex);
      if (!rec || rec.closed) continue;
      rec.remaining = 0n;
      this.close(rec, "cancelled", CANCEL_TEXT[reason]);
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
          this.current = null;
          this.applyResults(batch, results, new Map());
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
      // Failures are judged, and liquidity is given back, under the current pause flag and bands.
      if (results.some((r) => r.status === "failed")) await this.refreshChainState();
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "failed") verdicts.set(i, await this.classify(batch.matches[i]!, r.reason));
      }
      // The outcome is final from here on: the batch must never be handed to the settler again.
      this.current = null;
      this.applyResults(batch, results, verdicts);
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

  private async classify(match: Match, reason: Hex): Promise<Verdict> {
    const exact = attributeFromRevert(match, reason);
    if (exact) return exact;
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
      try {
        if (r.status === "settled") this.applySettled(m, r.txHash);
        else {
          touched.add(m.marketId);
          this.applyFailed(m, verdicts.get(i) ?? UNATTRIBUTED, r.reason);
        }
      } catch (e) {
        // A listener or an internal invariant threw. The on-chain outcome stands; keep going.
        this.log.error("error while applying a settlement result", { batch: batch.id, match: m.id, error: errMessage(e) });
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
   *  - A side at fault is removed from the book for good ("rejected") and the failure
   *    is counted against its trader.
   *  - An innocent side gets the size back: a resting order at its original time
   *    priority, an IOC order by being matched again against the remaining book.
   *  - Global condition (pause, stale oracle, price band, OI cap): nobody is at fault.
   *    The taker is cancelled, the maker gets its size back, no strike.
   *  - Cause unknown: the taker is dropped and the maker gets its size back plus a
   *    strike; `maxOrderStrikes` consecutive strikes remove it.
   * In every case the pair cannot be re-matched, so nothing retries forever.
   */
  private applyFailed(m: Match, verdict: Verdict, reason: Hex): void {
    this.failedCount++;
    const maker = this.orders.get(m.makerHash)!;
    const taker = this.orders.get(m.takerHash)!;
    maker.pending -= m.fillSize;
    taker.pending -= m.fillSize;
    this.log.warn("match failed on-chain", {
      match: m.id,
      makerOrderHash: m.makerHash,
      takerOrderHash: m.takerHash,
      revertData: reason,
      makerFault: verdict.maker.reason ?? null,
      takerFault: verdict.taker.reason ?? null,
      global: verdict.global ?? null,
    });

    if (verdict.global) {
      this.remove(taker, "cancelled", `match could not settle on-chain: ${verdict.global}`);
      this.giveBack(maker, m.fillSize);
      return;
    }
    const unattributed = !verdict.maker.atFault && !verdict.taker.atFault;

    if (verdict.taker.atFault) this.rejectAtFault(taker, verdict.taker.reason);
    else if (unattributed) this.remove(taker, "rejected", "match failed on-chain (cause not attributable); taker order dropped");

    if (verdict.maker.atFault) {
      this.rejectAtFault(maker, verdict.maker.reason);
    } else if (unattributed && ++maker.strikes >= this.maxOrderStrikes) {
      this.remove(maker, "rejected", "matches failed on-chain repeatedly");
    } else {
      this.giveBack(maker, m.fillSize);
    }
    // The taker is restored after the maker's fate is decided, so that it can never
    // be re-matched against a maker that is about to be removed.
    if (!verdict.taker.atFault && !unattributed) this.giveBack(taker, m.fillSize);
  }

  private rejectAtFault(rec: OrderRecord, why: string | undefined): void {
    let list = this.faults.get(rec.traderKey);
    if (!list) this.faults.set(rec.traderKey, (list = []));
    list.push(this.clock());
    this.remove(rec, "rejected", `match failed on-chain: ${why ?? "order at fault"}`);
  }

  /** Take an order out of the book for good. */
  private remove(rec: OrderRecord, status: "cancelled" | "rejected", reason: string): void {
    if (rec.closed) return;
    if (rec.remaining > 0n) this.books.get(rec.order.marketId)!.cancel(rec.hash);
    rec.remaining = 0n;
    this.close(rec, status, reason);
  }

  /** Return `size` of an undone match to an innocent order, if it is still eligible. */
  private giveBack(rec: OrderRecord, size: bigint): void {
    if (rec.closed) return;
    if (rec.userCancelled) {
      this.close(rec, "cancelled", "cancelled by trader");
      return;
    }
    const marketId = rec.order.marketId;
    const book = this.books.get(marketId)!;
    if (this.isExpired(rec.order)) {
      if (rec.remaining > 0n) book.cancel(rec.hash);
      rec.remaining = 0n;
      this.close(rec, "expired", "order expired");
      return;
    }
    const opts = this.matchOptions(marketId);
    if (rec.ioc) {
      // An IOC order never rests: run the returned size against the book once more.
      const res = book.place(this.toBookOrder(rec), size, { ...opts, ioc: true, allowBelowMin: true });
      if (!res.accepted) {
        this.applyBookEffects(marketId, { fills: [], expired: res.expired });
        this.close(rec, "cancelled", "IOC order: match failed on-chain and the size could not be matched again");
        return;
      }
      rec.remaining += size;
      this.applyBookEffects(marketId, { fills: res.fills, expired: res.expired });
      if (res.cancelled > 0n) {
        rec.remaining -= res.cancelled;
        this.close(rec, "cancelled", res.fills.length > 0 ? CANCEL_TEXT.ioc : "IOC order: match failed on-chain, nothing else to match");
      }
      return;
    }
    rec.remaining += size;
    this.applyBookEffects(marketId, book.restore(this.toBookOrder(rec), rec.seq, size, opts));
  }
}
