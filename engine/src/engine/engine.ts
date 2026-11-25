import { EventEmitter } from "node:events";
import { DROP_MAKER, DROP_TAKER, OrderBook, type Band, type BookFill, type BookOrder, type CancelReason, type Level, type RestoreOptions } from "../book/orderbook.ts";
import type { ChainReader } from "../chain/types.ts";
import { hashOrder, verifyCancelSignature, verifyOrderSignature, type Domain } from "../signing.ts";
import { BatchRevertedError, type Batch, type MatchResult, type Settler } from "../settlement/types.ts";
import { Metrics } from "../metrics.ts";
import type { Commit, DeadNonce, EngineStore, StoredMatch, StoredOrder } from "../store/types.ts";
import { errMessage, silentLogger, type Address, type Hex, type Logger, type MarketConfig, type Match, type Order } from "../types.ts";
import { attributeFromRevert, classifyFailure, priceBand, requiredCollateral, UNATTRIBUTED, type MarginMarket, type OpenExposure, type SideVerdict, type Verdict } from "./reconcile.ts";

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
  /** Matched, awaiting on-chain confirmation. */
  pending: bigint;
  /** Confirmed on-chain. */
  filled: bigint;
  reason?: string;
  /**
   * True when this exact signed order had been accepted before: nothing was done and
   * the fields show its current state (`fills` is empty then).
   */
  duplicate?: boolean;
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
  | "STORE_UNAVAILABLE"
  | "STATE_UNKNOWN"
  | "RECOVERING"
  | "RATE_LIMITED"
  | "REDUCE_ONLY_EXCEEDS_POSITION"
  | "SHUTTING_DOWN"
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
  STORE_UNAVAILABLE: 503,
  STATE_UNKNOWN: 503,
  RECOVERING: 503,
  RATE_LIMITED: 429,
  REDUCE_ONLY_EXCEEDS_POSITION: 422,
  SHUTTING_DOWN: 503,
  NOT_FOUND: 404,
};

export class EngineError extends Error {
  override readonly name = "EngineError";
  readonly httpStatus: number;
  /**
   * What the client may conclude about the request. "not_applied": nothing was changed,
   * retrying is safe. "unknown" (only STATE_UNKNOWN): the request may or may not have
   * taken effect; resubmit the identical signed order (idempotent) or query it.
   */
  readonly outcome: "not_applied" | "unknown";
  constructor(public readonly code: EngineErrorCode, message: string) {
    super(message);
    this.httpStatus = HTTP_STATUS[code];
    this.outcome = code === "STATE_UNKNOWN" ? "unknown" : "not_applied";
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
  /** Longest a submission may spend waiting for its turn and for chain reads. Default 8000. */
  intakeTimeoutMs?: number;
  /** Accepted submissions per trader address per minute (0 = unlimited). Default 600. */
  traderOrdersPerMinute?: number;
  /** How long a trader's free collateral / positions are reused across submissions. Default 1000. */
  preTradeCacheMs?: number;
  /**
   * Durable engine state. When given, the constructor rebuilds orders, books, unsettled
   * matches and trades from it; call `recover()` before taking orders.
   */
  store?: EngineStore;
  metrics?: Metrics;
  /** At-fault on-chain failures within `faultWindowSec` after which a trader's new orders are refused. Default 3. */
  faultThreshold?: number;
  /** Default 600. */
  faultWindowSec?: number;
  /** Chain state (index, pause) older than this is refreshed before an order is taken. Default 30000. */
  maxChainStateAgeMs?: number;
  /** Market parameters are re-read at most this often. Default 30000. */
  marketRefreshMs?: number;
  /** Funding, open-interest, insurance and bad-debt figures are re-read at most this often. Default 10000. */
  statsRefreshMs?: number;
  /** The contract's funding interval, for `nextFundingTime`. Default 3600. */
  fundingIntervalSec?: number;
  /** Upper bound for one chain read during a refresh. Default 5000. */
  chainReadTimeoutMs?: number;
  /**
   * Matches of a trader (as taker) that could not settle for a reason that is nobody's
   * fault, within `globalFailureWindowSec`, after which the trader's new orders are
   * refused for the rest of the window. Default 5.
   */
  globalFailureThreshold?: number;
  /** Default 60. */
  globalFailureWindowSec?: number;
  /** Chain time further ahead of the host clock than this halts intake. Default 900. */
  maxChainTimeLeadSec?: number;
  /** Dead nonces without an order (pre-emptive cancels) one trader may have. Default 100. */
  maxOrderlessCancels?: number;
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
  /** Matches this order took part in as taker that failed through nobody's fault (not persisted). */
  noFaultFailures: number;
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
  /** Funding and open-interest figures; each null when its view could not be read. */
  stats: MarketStats;
}

/** Per-market figures read from the contract for clients (not used for matching). */
export interface MarketStats {
  /** Time-weighted average fill price of the current funding period (WAD). */
  markTwap: bigint | null;
  /** WAD per hour; positive = longs pay shorts. */
  currentFundingRate: bigint | null;
  /** Unix seconds. */
  lastFundingTime: bigint | null;
  /** lastFundingTime + the funding interval. */
  nextFundingTime: bigint | null;
  openInterestLong: bigint | null;
  openInterestShort: bigint | null;
}

const NO_STATS: MarketStats = { markTwap: null, currentFundingRate: null, lastFundingTime: null, nextFundingTime: null, openInterestLong: null, openInterestShort: null };

/** What GET /markets returns per market. */
export type MarketView = MarketConfig & MarketStats & { indexPrice: bigint | null; lastPrice: bigint | null; bestBid: bigint | null; bestAsk: bigint | null };

const CANCEL_TEXT: Record<CancelReason, string> = {
  ioc: "IOC remainder cancelled",
  self_trade: "self-trade prevention: would match own resting order",
  price_band: "price outside the oracle price band",
  halted: "exchange paused, market inactive or without an index price: this order cannot trade now",
  oi_cap: "open-interest cap reached: only fills that do not add open interest can trade",
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
  /** The operator cannot pay for the settlement transaction at current fees. */
  insufficientFunds: boolean;
  /** The fee cap stops a stuck settlement transaction from being replaced. */
  feeCapReached: boolean;
  /** Engine state could not be written to the store. */
  storeBroken: boolean;
  /** Start-up recovery has not finished. */
  recovering: boolean;
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
  /** trader:nonce -> expiry of the order that must never be accepted again. */
  private readonly dead = new Map<string, bigint>();
  private readonly intakeTimeoutMs: number;
  private readonly traderOrdersPerMinute: number;
  private readonly preTradeCacheMs: number;
  private readonly traderWindows = new Map<string, { start: number; count: number }>();
  private readonly chainCache = new Map<string, Map<string, { at: number; value: bigint }>>();
  private recovering = false;
  private readonly store: EngineStore | undefined;
  readonly metrics: Metrics;
  /** trader -> nonce below which every order is cancelled on-chain (cancelAllOrders). */
  private readonly minValidNonce = new Map<string, bigint>();
  private readonly dirty = new Set<OrderRecord>();
  private pendingWrite = emptyWrite();
  private persistedCounters = "";
  private storeBroken = false;
  private draining = false;
  private sweeps = 0;
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
  private statsAt = 0;
  /** Seconds by which the latest block's timestamp is ahead of this host's clock (>= 0), once it has persisted. */
  private chainTimeLead = 0n;
  /** The last few raw readings of that lead. */
  private readonly leadSamples: bigint[] = [];
  /** The lead exceeds `maxChainTimeLead`: clocks cannot be trusted, intake is halted. */
  private clockSkew: bigint | null = null;
  private readonly maxChainTimeLead: bigint;
  private readonly chainReadTimeoutMs: number;
  private statsRefreshing: Promise<void> | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  /** market -> long open interest as last read (plus what the engine settled since). */
  private readonly openInterest = new Map<number, bigint>();
  /** market -> size of unsettled matches that may add open interest. */
  private readonly pendingOi = new Map<number, bigint>();
  /** trader -> unix seconds of matches that failed as taker through nobody's fault. */
  private readonly globalFailures = new Map<string, number[]>();
  private readonly globalFailureThreshold: number;
  private readonly globalFailureWindowSec: number;
  /** trader:market -> position the engine expects once its own unsettled matches have settled. */
  private readonly expectedPosition = new Map<string, bigint>();
  /** trader -> number of dead nonces that belong to no order. */
  private readonly orderlessCancels = new Map<string, number>();
  private readonly maxOrderlessCancels: number;
  /** trader -> generation of the chain-read cache (bumped on invalidation). */
  private readonly cacheGeneration = new Map<string, number>();
  private readonly statsRefreshMs: number;
  private readonly fundingInterval: bigint;
  private insuranceFund: bigint | null = null;
  private totalBadDebt: bigint | null = null;
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
    this.store = opts.store;
    this.intakeTimeoutMs = opts.intakeTimeoutMs ?? 8000;
    this.traderOrdersPerMinute = opts.traderOrdersPerMinute ?? 600;
    this.preTradeCacheMs = opts.preTradeCacheMs ?? 1000;
    this.metrics = opts.metrics ?? new Metrics();
    this.metrics.counter("orders_accepted_total", "Orders accepted into the engine");
    this.metrics.counter("orders_rejected_total", "Orders refused at intake, by error code");
    this.metrics.counter("orders_duplicate_total", "Resubmissions of an order that was already accepted");
    this.metrics.gauge("settler_insufficient_funds", "1 while the operator cannot pay for the settlement transaction", () => (this.settler.status?.().insufficientFunds ? 1 : 0));
    this.metrics.gauge("settler_fee_cap_reached", "1 while the fee cap prevents replacing a stuck settlement transaction", () => (this.settler.status?.().feeCapReached ? 1 : 0));
    this.metrics.gauge("store_broken", "1 while engine state cannot be persisted", () => (this.storeBroken ? 1 : 0));
    this.metrics.gauge("recovering", "1 until start-up recovery has finished", () => (this.recovering ? 1 : 0));
    this.metrics.counter("orders_cancelled_total", "Cancels processed (signed Cancel or on-chain)");
    this.metrics.counter("matches_settled_total", "Matches confirmed on-chain");
    this.metrics.counter("matches_failed_total", "Matches that failed on-chain");
    this.metrics.counter("batches_total", "settleMatches batches with a final outcome");
    this.metrics.counter("batch_errors_total", "Settlement attempts that ended in an error and were retried");
    this.metrics.histogram("batch_latency_seconds", "Time from handing a batch to the settler to its final outcome", [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);
    this.metrics.gauge("settlement_queue_depth", "Matches waiting for or in settlement", () => this.queue.length + (this.current?.matches.length ?? 0));
    this.metrics.gauge("settlement_stalled", "1 while a batch is being retried after an error", () => (this.stalled ? 1 : 0));
    this.metrics.gauge("resting_orders", "Orders resting in all books", () => [...this.books.values()].reduce((n, b) => n + b.size, 0));
    this.metrics.gauge("exchange_paused", "1 if the engine believes the exchange is paused", () => (this.exchangePaused ? 1 : 0));
    this.faultThreshold = opts.faultThreshold ?? 3;
    this.faultWindowSec = opts.faultWindowSec ?? 600;
    this.maxChainStateAgeMs = opts.maxChainStateAgeMs ?? 30_000;
    this.marketRefreshMs = opts.marketRefreshMs ?? 30_000;
    this.statsRefreshMs = opts.statsRefreshMs ?? 10_000;
    this.chainReadTimeoutMs = opts.chainReadTimeoutMs ?? 5000;
    this.maxChainTimeLead = BigInt(opts.maxChainTimeLeadSec ?? 900);
    this.globalFailureThreshold = opts.globalFailureThreshold ?? 5;
    this.globalFailureWindowSec = opts.globalFailureWindowSec ?? 60;
    this.maxOrderlessCancels = opts.maxOrderlessCancels ?? 100;
    this.fundingInterval = BigInt(opts.fundingIntervalSec ?? 3600);
    this.metrics.gauge("insurance_fund_usdc", "Insurance fund of the exchange, USDC", () => (this.insuranceFund === null ? null : Number(this.insuranceFund) / 1e6));
    this.metrics.gauge("total_bad_debt_usdc", "Bad debt recorded by the exchange, USDC", () => (this.totalBadDebt === null ? null : Number(this.totalBadDebt) / 1e6));
    this.maxBatchSize = opts.maxBatchSize ?? 20;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.maxBatchReverts = opts.maxBatchReverts ?? 3;
    this.maxOrderStrikes = opts.maxOrderStrikes ?? 3;
    this.tradeHistory = opts.tradeHistory ?? 200;
    for (const m of opts.markets) {
      this.markets.set(m.marketId, m);
      this.books.set(m.marketId, new OrderBook(m.minOrderSize));
      this.trades.set(m.marketId, []);
      this.marketState.set(m.marketId, { index: null, band: undefined, stats: { ...NO_STATS } });
    }
    this.marketsAt = Date.now();
    if (this.store) this.loadFromStore(this.store);
  }

  // ---------------------------------------------------------------- persistence

  /** Rebuild in-memory state from the store: same orders, same time priority, same unsettled matches. */
  private loadFromStore(store: EngineStore): void {
    const snap = store.load();
    for (const d of snap.deadNonces) this.dead.set(nonceKey(d.trader.toLowerCase(), d.nonce), d.expiry);
    for (const { trader, nonce } of snap.minValidNonces) this.minValidNonce.set(trader.toLowerCase(), nonce);
    for (const o of snap.orders) {
      const market = this.markets.get(o.order.marketId);
      if (!market) {
        this.log.warn("stored order for a market that no longer exists; ignored", { orderHash: o.hash, marketId: o.order.marketId });
        continue;
      }
      const traderKey = o.order.trader.toLowerCase();
      const rec: OrderRecord = { ...o, traderKey, reduceOnly: o.order.reduceOnly, noFaultFailures: 0 };
      // Second line of defence: a resting order whose nonce is dead (or that carries a
      // cancel) must not come back, whatever sequence of writes led to this state.
      if (!rec.closed && rec.remaining > 0n) {
        const cancelled =
          rec.userCancelled || this.dead.has(nonceKey(traderKey, rec.order.nonce)) || rec.order.nonce < (this.minValidNonce.get(traderKey) ?? 0n);
        if (cancelled) {
          this.log.warn("stored order is resting although its nonce is dead; closing it", { orderHash: rec.hash });
          rec.remaining = 0n;
          rec.userCancelled = true;
          rec.closed = { status: "cancelled", reason: "cancelled by trader" };
          this.dirty.add(rec);
        }
      }
      this.orders.set(rec.hash, rec);
      this.usedNonces.set(nonceKey(traderKey, rec.order.nonce), rec.hash);
      let set = this.ordersByTrader.get(traderKey);
      if (!set) this.ordersByTrader.set(traderKey, (set = new Set()));
      set.add(rec.hash);
      const book = this.books.get(rec.order.marketId)!;
      book.reserveSeq(rec.seq);
      if (!rec.closed && rec.remaining > 0n) book.load(this.toBookOrder(rec), rec.seq, rec.remaining);
    }
    for (const m of snap.matches) {
      const maker = this.orders.get(m.makerHash);
      const taker = this.orders.get(m.takerHash);
      if (!maker || !taker) throw new Error(`store is inconsistent: match ${m.id} refers to an unknown order`);
      const match: Match = {
        id: m.id,
        marketId: m.marketId,
        maker: maker.order,
        makerSig: maker.signature,
        makerHash: maker.hash,
        taker: taker.order,
        takerSig: taker.signature,
        takerHash: taker.hash,
        fillSize: m.fillSize,
        price: m.price,
      };
      if (m.batchId === null) this.queue.push(match);
      else if (!this.current || this.current.id === m.batchId) (this.current ??= { id: m.batchId, matches: [] }).matches.push(match);
      else throw new Error(`store is inconsistent: more than one batch in flight (${this.current.id}, ${m.batchId})`);
    }
    for (const t of snap.trades) {
      const list = this.trades.get(t.marketId);
      if (!list) continue;
      list.push(t);
      if (list.length > this.tradeHistory) list.shift();
      this.lastPrice.set(t.marketId, t.price);
    }
    for (const key of this.dead.keys()) {
      if (this.usedNonces.has(key)) continue;
      const trader = key.slice(0, key.indexOf(":"));
      this.orderlessCancels.set(trader, (this.orderlessCancels.get(trader) ?? 0) + 1);
    }
    for (const m of [...this.queue, ...(this.current?.matches ?? [])]) this.trackMatch(m, 1n);
    const counters = JSON.parse(store.getMeta("engine.counters") ?? "{}") as { matchSeq?: number; batchSeq?: number; tradeSeq?: number };
    this.matchSeq = counters.matchSeq ?? 0;
    this.batchSeq = counters.batchSeq ?? 0;
    this.tradeSeq = counters.tradeSeq ?? 0;
    this.persistedCounters = this.countersJson();
    // Until recover() has reconciled this state with the chain, no orders are taken.
    this.recovering = snap.orders.length > 0 || snap.matches.length > 0;
    if (snap.orders.length > 0) {
      this.log.info("state restored from store", {
        orders: snap.orders.length,
        resting: [...this.books.values()].reduce((n, b) => n + b.size, 0),
        queuedMatches: this.queue.length,
        inFlightBatch: this.current ? `${this.current.id} (${this.current.matches.length} matches)` : null,
      });
    }
  }

  /**
   * Bring restored state in line with the chain. Call once after construction and
   * before taking orders (submissions are refused with RECOVERING until it resolves):
   *  1. cancels first: every resting order is checked against `isCancelled` (covers
   *     `cancelOrder` and `cancelAllOrders`), `replayCancels` replays the cancel
   *     events since the stored cursor, and expired orders are dropped - so nothing
   *     that was cancelled while the engine was down can be matched or re-crossed;
   *  2. the batch that was in flight when the process died, and every match that was
   *     queued, is driven to its real on-chain outcome through the settler (which
   *     looks its own transactions up by hash - nothing is assumed, nothing is sent twice);
   *  3. every resting order's fill state is corrected to on-chain `filledSize`.
   * Rejects if the chain cannot be read; the caller should not start serving then.
   * It does not time out by itself while the settler cannot reach the chain: the
   * caller bounds it.
   */
  async recover(opts: { replayCancels?: () => Promise<void> } = {}): Promise<void> {
    this.recovering = true;
    await this.refreshChainState();
    const chain = this.chain;
    const resting = () => [...this.orders.values()].filter((r) => !r.closed && r.remaining > 0n);
    const inChunks = async (fn: (r: OrderRecord) => Promise<void>) => {
      const list = resting();
      for (let i = 0; i < list.length; i += 20) await Promise.all(list.slice(i, i + 20).map(fn));
    };
    if (chain) {
      await inChunks(async (rec) => {
        if (await chain.isCancelled(rec.order.trader, rec.order.nonce)) this.cancelNonce(rec.order.trader, rec.order.nonce, "cancelled on-chain");
      });
    }
    await opts.replayCancels?.();
    this.sweepExpired();

    if (this.current || this.queue.length > 0) {
      this.kick();
      await this.idle();
    }

    if (chain) {
      await inChunks(async (rec) => {
        const filled = await chain.filledSize(rec.hash);
        if (rec.closed || rec.remaining === 0n || filled === rec.filled) return;
        this.log.warn("order fill state differs from the chain; using the chain's", { orderHash: rec.hash, engine: rec.filled, chain: filled });
        const remaining = rec.order.size - filled - rec.pending;
        rec.filled = filled;
        rec.remaining = remaining > 0n ? remaining : 0n;
        this.books.get(rec.order.marketId)!.setRemaining(rec.hash, rec.remaining);
        this.touch(rec);
      });
    }
    this.sweepExpired();
    if (!this.flush()) throw new Error("could not persist the recovered state");
    this.recovering = false;
    for (const marketId of this.books.keys()) this.emit("book", marketId);
  }

  /** True until `recover()` has finished (only after a start from a non-empty store). */
  isRecovering(): boolean {
    return this.recovering;
  }

  private touch(rec: OrderRecord): void {
    if (this.store) this.dirty.add(rec);
  }

  private countersJson(): string {
    return JSON.stringify({ matchSeq: this.matchSeq, batchSeq: this.batchSeq, tradeSeq: this.tradeSeq });
  }

  /**
   * Write everything the current operation changed in one atomic, durable commit.
   * Returns false (and halts order intake) if the store refuses; the changes are kept
   * and written by the next successful flush.
   */
  private flush(): boolean {
    const store = this.store;
    if (!store) return true;
    const w = this.pendingWrite;
    const counters = this.countersJson();
    if (this.dirty.size === 0 && w.addMatches.length === 0 && w.removeMatches.length === 0 && w.trades.length === 0 && w.minValidNonces.length === 0 && w.dead.length === 0 && !w.batched && counters === this.persistedCounters) {
      return true; // nothing is waiting to be written
    }
    try {
      store.commit({
        orders: [...this.dirty].map(toStored),
        addMatches: w.addMatches,
        batched: w.batched,
        removeMatches: w.removeMatches,
        trades: w.trades,
        minValidNonces: w.minValidNonces,
        deadNonces: w.dead,
        meta: { "engine.counters": counters },
      });
    } catch (e) {
      this.storeBroken = true;
      this.log.error("could not persist engine state; order intake halted", { error: errMessage(e) });
      return false;
    }
    this.dirty.clear();
    this.pendingWrite = emptyWrite();
    this.persistedCounters = counters;
    this.storeBroken = false;
    return true;
  }

  /** After a failed write: find out whether the store works again, and if so write what was held back. */
  private healStore(): void {
    if (!this.store || !this.storeBroken) return;
    try {
      this.store.setMeta("engine.heartbeat", String(Date.now()));
    } catch {
      return;
    }
    this.storeBroken = false;
    this.log.info("store is writable again");
    this.flush();
  }

  /**
   * Make a change durable BEFORE it is applied in memory. Used where the client is
   * told "done" (cancels): if the store refuses, nothing has changed anywhere.
   */
  private commitFirst(c: Partial<Commit>): void {
    const store = this.store;
    if (!store) return;
    // Earlier changes must be on disk first, or this commit would describe a state the store never had.
    if (this.storeBroken) this.healStore();
    if (!this.flush()) throw new EngineError("STORE_UNAVAILABLE", "engine state cannot be persisted; nothing was changed");
    try {
      store.commit({ orders: [], addMatches: [], batched: null, removeMatches: [], trades: [], minValidNonces: [], deadNonces: [], meta: {}, ...c });
      this.storeBroken = false;
    } catch (e) {
      this.storeBroken = true;
      this.log.error("could not persist a cancel; nothing was changed", { error: errMessage(e) });
      throw new EngineError("STORE_UNAVAILABLE", "engine state cannot be persisted; nothing was changed");
    }
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
      // Figures for clients have their own timer and guard: a slow view there never delays
      // the refresh that matching depends on.
      void this.refreshStats();
      this.statsTimer = setInterval(() => void this.refreshStats(), Math.max(1000, this.statsRefreshMs));
      this.statsTimer.unref();
    }
  }

  /**
   * Shut down: refuse new orders at once, give matches already queued or in flight
   * up to `drainTimeoutMs` to reach their on-chain outcome, then stop. Whatever is
   * still unresolved stays in the store and is resolved by `recover()` on the next start.
   */
  async stop(drainTimeoutMs = 0): Promise<void> {
    this.draining = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.sweepTimer = this.refreshTimer = this.statsTimer = null;
    if (drainTimeoutMs > 0 && this.loop) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        this.idle().then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), drainTimeoutMs))),
      ]);
      clearTimeout(timer);
      if (timedOut) this.log.warn("shutdown: settlement did not finish in time; it will be resolved on the next start", this.settlementStatus() as never);
    }
    this.stopped = true;
    this.wakeRetry?.();
    if (drainTimeoutMs > 0) {
      // Do not hang on a settler that is still waiting for a receipt.
      await Promise.race([this.loop, new Promise((r) => setTimeout(r, 1000).unref())]);
    } else {
      await this.loop;
    }
    this.flush();
  }

  /**
   * Re-read pause flag, index prices (hence price bands) and, now and then, market
   * parameters. Resting orders that are now on the wrong side of their band are
   * cancelled. A market whose index cannot be read is halted for new orders until it
   * can. Never rejects.
   */
  refreshChainState(opts: { fresh?: boolean } = {}): Promise<void> {
    const chain = this.chain;
    if (!chain) return Promise.resolve();
    if (this.refreshing && opts.fresh) {
      // A refresh already under way may have read the chain before the event the caller
      // is reacting to: let it finish, then read again.
      return this.refreshing.then(() => this.refreshChainState());
    }
    this.refreshing ??= this.doRefresh(chain).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** `p`, or a rejection after `chainReadTimeoutMs`. */
  private timed<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("chain read timed out")), this.chainReadTimeoutMs);
    });
    p.catch(() => {});
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private async doRefresh(chain: ChainReader): Promise<void> {
    try {
      this.bandBps ??= await this.timed(chain.maxPriceDeviationBps());
      this.exchangePaused = await this.timed(chain.paused());
      if (Date.now() - this.marketsAt >= this.marketRefreshMs) {
        for (const [marketId, old] of this.markets) {
          const fresh = await this.timed(chain.getMarket(marketId));
          this.markets.set(marketId, { ...fresh, symbol: fresh.symbol || old.symbol });
          this.books.get(marketId)!.minOrderSize = fresh.minOrderSize;
        }
        this.marketsAt = Date.now();
      }
      for (const [marketId, st] of this.marketState) {
        try {
          st.index = await this.timed(chain.indexPrice(marketId));
          st.band = priceBand(st.index, this.bandBps);
        } catch (e) {
          if (st.index !== null) this.log.warn("index price unavailable; market halted", { marketId, error: errMessage(e) });
          st.index = null;
        }
        // Open interest gates matching (see matchOptions), so it is read here and not with
        // the figures for clients. An unreadable value keeps the last one.
        try {
          this.openInterest.set(marketId, (await this.timed(chain.openInterest(marketId))).longs);
        } catch {
          // keep the last known value
        }
      }
      await this.readChainTime(chain);
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
      this.flush();
    } catch (e) {
      this.log.error("error while enforcing price bands", { error: errMessage(e) });
    }
  }

  /**
   * Expiry is judged by block.timestamp. If the chain's clock is ahead of this host's
   * (clock skew; a local node that advances a second per block), orders must be treated
   * as expiring that much earlier, or they would reach the chain too late.
   *
   * One reading proves nothing (a lagging or misconfigured backend, a test chain that
   * travelled in time): the lead that is applied is the smallest of the last three
   * readings, so it must persist before it expires anything and vanishes at once when
   * it is gone. A lead beyond `maxChainTimeLead` is not applied at all: then the clocks
   * cannot be trusted, intake is halted and /health says so.
   */
  private async readChainTime(chain: ChainReader): Promise<void> {
    let raw: bigint;
    try {
      raw = (await this.timed(chain.blockTimestamp())) - BigInt(this.clock());
    } catch {
      return; // keep what we had
    }
    this.leadSamples.push(raw < 0n ? 0n : raw);
    if (this.leadSamples.length > 3) this.leadSamples.shift();
    if (this.leadSamples.length < 3) return;
    const persistent = this.leadSamples.reduce((a, b) => (a < b ? a : b));
    if (persistent > this.maxChainTimeLead) {
      if (this.clockSkew === null) {
        this.log.error("chain time is far ahead of the host clock; order intake halted until the clocks agree", { leadSeconds: persistent });
      }
      this.clockSkew = persistent;
      this.chainTimeLead = 0n;
    } else {
      if (this.clockSkew !== null) this.log.info("chain time and host clock agree again", { leadSeconds: persistent });
      this.clockSkew = null;
      this.chainTimeLead = persistent;
    }
  }

  /**
   * Figures for clients (funding, open interest, insurance fund, bad debt). Runs on
   * its own guard, apart from the refresh matching depends on. Every view is read on
   * its own and with a timeout: one that reverts or hangs (stale oracle, sequencer
   * down, slow node) leaves its field null and disturbs nothing else. Never rejects.
   */
  refreshStats(): Promise<void> {
    const chain = this.chain;
    if (!chain) return Promise.resolve();
    this.statsRefreshing ??= this.doRefreshStats(chain)
      .catch((e) => this.log.warn("stats refresh failed", { error: errMessage(e) }))
      .finally(() => (this.statsRefreshing = null));
    return this.statsRefreshing;
  }

  private async doRefreshStats(chain: ChainReader): Promise<void> {
    const read = <T>(p: Promise<T>): Promise<T | null> => this.timed(p).catch(() => null);
    [this.insuranceFund, this.totalBadDebt] = await Promise.all([read(chain.insuranceFund()), read(chain.totalBadDebt())]);
    for (const [marketId, st] of this.marketState) {
      const [index, twap, rate, lastFundingTime, oi] = await Promise.all([
        read(chain.indexPrice(marketId)),
        read(chain.markTwap(marketId)),
        read(chain.currentFundingRate(marketId)),
        read(chain.lastFundingTime(marketId)),
        read(chain.openInterest(marketId)),
      ]);
      // markTwap and currentFundingRate return 0 instead of reverting while the index is
      // unavailable: 0 is then "unknown", not a price, and the rate derived from it is
      // not a rate anyone should display.
      const markTwap = twap === null || twap === 0n || index === null ? null : twap;
      st.stats = {
        markTwap,
        currentFundingRate: markTwap === null ? null : rate,
        lastFundingTime,
        nextFundingTime: lastFundingTime === null ? null : lastFundingTime + this.fundingInterval,
        openInterestLong: oi?.longs ?? null,
        openInterestShort: oi?.shorts ?? null,
      };
    }
    this.statsAt = Date.now();
  }

  /** Exchange-wide figures (USDC units); null when unknown. */
  exchangeStats(): { insuranceFund: bigint | null; totalBadDebt: bigint | null } {
    return { insuranceFund: this.insuranceFund, totalBadDebt: this.totalBadDebt };
  }

  private async ensureChainState(): Promise<void> {
    if (!this.chain) return;
    if (this.chainStateAt === 0 || Date.now() - this.chainStateAt > this.maxChainStateAgeMs) await this.refreshChainState();
  }

  /** Current exchange-level view the engine matches under (for /health). */
  chainStatus(): {
    paused: boolean;
    /** Seconds the chain's clock is (persistently) ahead of the host's and applied to expiry. */
    chainTimeLeadSec: bigint;
    /** Set (to the lead in seconds) when the clocks disagree too much: intake is halted. */
    clockSkewSec: bigint | null;
    markets: { marketId: number; indexPrice: bigint | null; band: Band | null; openInterestCapReached: boolean }[];
  } | null {
    if (!this.chain) return null;
    return {
      paused: this.exchangePaused,
      chainTimeLeadSec: this.chainTimeLead,
      clockSkewSec: this.clockSkew,
      markets: [...this.marketState].map(([marketId, st]) => ({
        marketId,
        indexPrice: st.index,
        band: st.band ?? null,
        openInterestCapReached: this.oiHeadroom(marketId) === 0n,
      })),
    };
  }

  /** The engine's "now" for order expiry (unix seconds): host time plus the applied chain-time lead. */
  engineTime(): bigint {
    return this.timeNow();
  }

  /**
   * Size that may still be matched in fills that can add open interest, or null if
   * open interest is not known. Counts what the chain last reported plus every match
   * of that kind the engine has made and not yet seen settle.
   */
  private oiHeadroom(marketId: number): bigint | null {
    const oi = this.openInterest.get(marketId);
    if (oi === undefined) return null;
    const room = this.markets.get(marketId)!.maxOpenInterest - oi - (this.pendingOi.get(marketId) ?? 0n);
    return room > 0n ? room : 0n;
  }

  /** Resolves once every queued match has reached a final on-chain outcome. */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  // -------------------------------------------------------------------- queries

  getMarkets(): MarketView[] {
    return [...this.markets.values()].map((m) => {
      const book = this.books.get(m.marketId)!;
      const st = this.marketState.get(m.marketId)!;
      return {
        ...m,
        indexPrice: st.index,
        ...st.stats,
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
      insufficientFunds: this.settler.status?.().insufficientFunds ?? false,
      feeCapReached: this.settler.status?.().feeCapReached ?? false,
      storeBroken: this.storeBroken,
      recovering: this.recovering,
    };
  }

  // --------------------------------------------------------------------- intake

  /**
   * Accept a signed order. Idempotent by order hash: submitting the identical signed
   * order again returns its current state (`duplicate: true`) and changes nothing, so
   * a client may simply retry after a timeout or a STATE_UNKNOWN answer.
   */
  async submit(req: SubmitRequest): Promise<SubmitResult> {
    try {
      const res = await this.submitInner(req);
      this.metrics.inc(res.duplicate ? "orders_duplicate_total" : "orders_accepted_total");
      return res;
    } catch (e) {
      this.metrics.inc("orders_rejected_total", { code: e instanceof EngineError ? e.code : "INTERNAL" });
      throw e;
    }
  }

  private existing(rec: OrderRecord): SubmitResult {
    return {
      orderHash: rec.hash,
      status: this.status(rec),
      fills: [],
      remaining: rec.remaining,
      pending: rec.pending,
      filled: rec.filled,
      ...(rec.closed ? { reason: rec.closed.reason } : {}),
      duplicate: true,
    };
  }

  /** Reject with CHAIN_UNAVAILABLE if `p` is not done by `deadline` (its late result is discarded). */
  private async within<T>(p: Promise<T>, deadline: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EngineError("CHAIN_UNAVAILABLE", "chain checks took too long; the order was not accepted")),
        Math.max(0, deadline - Date.now()),
      );
    });
    p.catch(() => {}); // a late rejection is nobody's business
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private takeTraderSlot(traderKey: string): boolean {
    if (this.traderOrdersPerMinute <= 0) return true;
    const now = Date.now();
    const w = this.traderWindows.get(traderKey);
    if (!w || now - w.start >= 60_000) {
      this.traderWindows.set(traderKey, { start: now, count: 1 });
      if (this.traderWindows.size > 50_000) for (const [k, v] of this.traderWindows) if (now - v.start >= 60_000) this.traderWindows.delete(k);
      return true;
    }
    return ++w.count <= this.traderOrdersPerMinute;
  }

  private async submitInner(req: SubmitRequest): Promise<SubmitResult> {
    const { order } = req;
    const postOnly = req.postOnly ?? false;
    const ioc = req.ioc ?? false;

    // An order the engine already has is answered with its state before anything else:
    // whatever the engine is doing (draining, recovering, store trouble, a stalled
    // settlement) and however close the order is to its expiry, a retry of a known
    // order must never be told "not applied". The signature is still checked, so that
    // only someone holding the signed order gets this answer.
    const hash = hashOrder(this.domain, order);
    const known = this.orders.get(hash);
    if (known) {
      if (!(await verifyOrderSignature(this.domain, order, req.signature))) {
        throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 signature by order.trader");
      }
      return this.existing(known);
    }

    const market = this.markets.get(order.marketId);
    if (!market) throw new EngineError("UNKNOWN_MARKET", `unknown market ${order.marketId}`);
    if (!market.active) throw new EngineError("MARKET_INACTIVE", `market ${order.marketId} is not active`);
    if (this.draining) throw new EngineError("SHUTTING_DOWN", "engine is shutting down; not accepting orders");
    if (this.recovering) throw new EngineError("RECOVERING", "engine is reconciling its state with the chain after a restart; try again shortly");
    if (this.storeBroken) throw new EngineError("STORE_UNAVAILABLE", "engine state cannot be persisted; not accepting orders");
    if (this.clockSkew !== null) {
      throw new EngineError(
        "CHAIN_UNAVAILABLE",
        `chain time is ${this.clockSkew} s ahead of the engine's clock: order expiry cannot be judged; not accepting orders`,
      );
    }
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
    const now = this.timeNow();
    // Nonces are a millisecond timestamp in the high bits. The contract refuses to
    // bulk-cancel beyond ((now + 1 day) * 1000) << 64, so an order above that bound
    // could never be covered by cancelAllOrders.
    if (order.nonce > ((now + 86_400n) * 1000n) << 64n) {
      throw new EngineError("INVALID_ORDER", "nonce is too far in the future: it must not exceed ((now + 1 day) in ms) << 64");
    }
    if (order.expiry === 0n) throw new EngineError("INVALID_EXPIRY", "orders must have an expiry");
    if (order.expiry <= now + this.minTimeToExpiry) {
      throw new EngineError("EXPIRED", `order is expired or expires in less than ${this.minTimeToExpiry} seconds`);
    }
    if (order.expiry > now + this.maxTimeToExpiry) {
      throw new EngineError("INVALID_EXPIRY", `expiry must be at most ${this.maxTimeToExpiry} seconds from now`);
    }

    const traderKey = order.trader.toLowerCase();
    this.checkNotSeen(hash, order);
    if (this.isSuspended(traderKey)) {
      throw new EngineError("TRADER_SUSPENDED", "too many of this trader's orders failed on-chain recently; try again later");
    }
    if (this.recentCount(this.globalFailures, traderKey, this.globalFailureWindowSec) >= this.globalFailureThreshold) {
      throw new EngineError("RATE_LIMITED", "too many of this trader's matches could not settle in the last minute; try again shortly");
    }

    // From here on a signed Cancel for this hash is honoured even though the order is
    // not in the book yet (the Cancel signature is checked on its own, so it does not
    // matter that this order's signature has not been verified at this point).
    this.intake.set(hash, order);
    try {
      if (!(await verifyOrderSignature(this.domain, order, req.signature))) {
        throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 signature by order.trader");
      }
      // Counted per trader only once the signature is known to be theirs.
      if (!this.takeTraderSlot(traderKey)) throw new EngineError("RATE_LIMITED", "too many orders from this trader; slow down");
      const deadline = Date.now() + this.intakeTimeoutMs;
      // One submission per trader at a time, so that the aggregate margin check sees
      // every earlier order of the trader.
      return await this.withTraderLock(traderKey, async () => {
        if (Date.now() >= deadline) throw new EngineError("CHAIN_UNAVAILABLE", "timed out waiting for the trader's earlier submissions; the order was not accepted");
        await this.within(this.ensureChainState(), deadline);
        const state = this.marketState.get(order.marketId)!;
        if (this.chain && state.index === null) {
          throw new EngineError("MARKET_HALTED", "no fresh index price for this market; not accepting orders");
        }
        if (this.exchangePaused && !order.reduceOnly) {
          throw new EngineError("EXCHANGE_PAUSED", "exchange is paused: only reduce-only orders are accepted");
        }
        const priorFilled = this.preTradeChecks ? await this.within(this.preTradeCheck(order, hash), deadline) : 0n;
        // The identical order may have been accepted while this one waited (a client retry).
        const twin = this.orders.get(hash);
        if (twin) return this.existing(twin);
        return this.insert(req, hash, priorFilled);
      });
    } finally {
      this.intake.delete(hash);
    }
  }

  /**
   * Final checks and the book update. Synchronous: nothing can interleave. The result
   * is durable in the store before it is returned.
   */
  private insert(req: SubmitRequest, hash: Hex, priorFilled: bigint): SubmitResult {
    let ok = false;
    try {
      const res = this.insertInner(req, hash, priorFilled);
      ok = true;
      if (!this.flush()) {
        throw new EngineError("STATE_UNKNOWN", "the order was processed but could not be persisted; resubmit the identical order or query it to learn its state");
      }
      return res;
    } finally {
      if (!ok) this.flush();
    }
  }

  private insertInner(req: SubmitRequest, hash: Hex, priorFilled: bigint): SubmitResult {
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
      noFaultFailures: 0,
      createdAt: Date.now(),
    };
    this.orders.set(hash, rec);
    this.touch(rec);
    this.usedNonces.set(nonceKey(traderKey, order.nonce), hash);
    let set = this.ordersByTrader.get(traderKey);
    if (!set) this.ordersByTrader.set(traderKey, (set = new Set()));
    set.add(hash);
    // An IOC order must never come back as a resting order, whatever happens to it.
    if (ioc) this.markDead(order.trader, order.nonce, order.expiry);

    this.applyBookEffects(order.marketId, { fills: res.fills, expired: res.expired });
    this.closeDropped(res.dropped);
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
      pending: rec.pending,
      filled: rec.filled,
      ...(rec.closed ? { reason: rec.closed.reason } : {}),
    };
  }

  /**
   * Cancel by order hash with a signed EIP-712 `Cancel(trader, nonce)`. Idempotent.
   * The (trader, nonce) pair is durably recorded as dead before this resolves. Works
   * for an order that is still in its intake checks: it will then not enter the book.
   */
  async cancel(orderHash: Hex, signature: string, hint?: { trader: Address; nonce: bigint }): Promise<OrderView | { orderHash: Hex; status: "cancelled"; known: false }> {
    const hash = orderHash.toLowerCase() as Hex;
    const order = this.orders.get(hash)?.order ?? this.intake.get(hash);
    if (!order) {
      // The engine has never seen this order (it may still be on its way here). With
      // the trader and nonce the Cancel signature can be checked on its own, and the
      // nonce is made dead - durably, before answering - so the order cannot land later.
      if (!hint) throw new EngineError("NOT_FOUND", "unknown order; send trader and nonce with the signature to cancel an order the engine has not received");
      // Only nonces an order could be accepted with can need a pre-emptive cancel.
      if (hint.nonce > ((this.timeNow() + 86_400n) * 1000n) << 64n) {
        throw new EngineError("INVALID_ORDER", "nonce is too far in the future: no order with it would be accepted");
      }
      if (!(await verifyCancelSignature(this.domain, hint.trader, hint.nonce, signature))) {
        throw new EngineError("BAD_SIGNATURE", "signature is not a canonical EIP-712 Cancel signature by the given trader for the given nonce");
      }
      const tk = hint.trader.toLowerCase();
      const key = nonceKey(tk, hint.nonce);
      // Each of these is a durable row that belongs to no order: bounded per trader,
      // and rate-limited like orders (counted only now that the signature is known good).
      if (!this.dead.has(key) && !this.usedNonces.has(key)) {
        if (!this.takeTraderSlot(tk)) throw new EngineError("RATE_LIMITED", "too many requests from this trader; slow down");
        if ((this.orderlessCancels.get(tk) ?? 0) >= this.maxOrderlessCancels) {
          throw new EngineError("RATE_LIMITED", "too many cancels for orders the engine has never received; use cancelAllOrders on-chain to cancel in bulk");
        }
      }
      this.cancelNonce(hint.trader, hint.nonce, "cancelled by trader");
      // The nonce may belong to an order known under another hash than the one in the URL.
      const other = this.usedNonces.get(nonceKey(hint.trader.toLowerCase(), hint.nonce));
      const rec = other && this.orders.get(other);
      return rec ? this.view(rec) : { orderHash: hash, status: "cancelled", known: false };
    }
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
   * Matches already handed to settlement are not recalled.
   *
   * The dead nonce and the order's new state are written in ONE store transaction
   * before anything changes in memory. If that fails this throws STORE_UNAVAILABLE and
   * the order is exactly as it was, in memory and on disk.
   */
  cancelNonce(trader: Address, nonce: bigint, reason: string, expiry?: bigint): void {
    const traderKey = trader.toLowerCase();
    const key = nonceKey(traderKey, nonce);
    const hash = this.usedNonces.get(key);
    const rec = hash ? this.orders.get(hash) : undefined;
    // Without a known order, keep the entry for as long as any acceptable order could live, plus a day.
    const until = expiry ?? rec?.order.expiry ?? BigInt(this.clock()) + this.maxTimeToExpiry + 86_400n;
    // Already dead and nothing left to cancel: a repeat (a client retry, or an on-chain
    // event read again in the rescan window) writes nothing and counts nothing.
    const known = this.dead.has(key);
    const target = rec && !rec.userCancelled ? rec : undefined;
    if (known && !target) return;
    const closes = target !== undefined && !target.closed && target.remaining > 0n;
    const after = target && this.cancelledState(target, closes, reason);
    this.commitFirst({ orders: after ? [after] : [], deadNonces: [{ trader, nonce, expiry: until }] });
    // Durable. Now the same change in memory.
    if (!known && !rec) this.orderlessCancels.set(traderKey, (this.orderlessCancels.get(traderKey) ?? 0) + 1);
    this.dead.set(key, until > (this.dead.get(key) ?? 0n) ? until : this.dead.get(key)!);
    if (!known) this.metrics.inc("orders_cancelled_total");
    if (target) this.applyCancel(target, closes, reason);
  }

  /**
   * On-chain `cancelAllOrders`: every order of the trader with nonce < `minValid` is
   * dead. Resting ones leave the book now; later submissions are refused. Durable
   * before it takes effect, like `cancelNonce`.
   */
  cancelBelow(trader: Address, minValid: bigint, reason = "cancelled on-chain (cancelAllOrders)"): void {
    const traderKey = trader.toLowerCase();
    if ((this.minValidNonce.get(traderKey) ?? 0n) >= minValid) return;
    const targets: [OrderRecord, boolean][] = [];
    for (const hash of this.ordersByTrader.get(traderKey) ?? []) {
      const rec = this.orders.get(hash)!;
      if (rec.order.nonce < minValid && !rec.userCancelled) targets.push([rec, !rec.closed && rec.remaining > 0n]);
    }
    this.commitFirst({
      orders: targets.map(([rec, closes]) => this.cancelledState(rec, closes, reason)),
      minValidNonces: [{ trader, nonce: minValid }],
    });
    this.minValidNonce.set(traderKey, minValid);
    this.metrics.inc("orders_cancelled_total");
    for (const [rec, closes] of targets) this.applyCancel(rec, closes, reason);
  }

  /** The stored form of `rec` once it is cancelled. */
  private cancelledState(rec: OrderRecord, closes: boolean, reason: string): StoredOrder {
    return {
      ...toStored(rec),
      userCancelled: true,
      ...(closes ? { remaining: 0n, closed: { status: "cancelled" as const, reason } } : {}),
    };
  }

  private applyCancel(rec: OrderRecord, closes: boolean, reason: string): void {
    rec.userCancelled = true;
    if (!closes) return;
    this.books.get(rec.order.marketId)!.cancel(rec.hash);
    rec.remaining = 0n;
    rec.closed = { status: "cancelled", reason };
    this.emit("book", rec.order.marketId);
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
    this.healStore();
    this.flush();
    if (++this.sweeps % 60 === 0) this.pruneFinished();
  }

  /**
   * Forget orders that are finished and past their expiry (they can no longer be
   * submitted or settled), in memory and in the store, and expired dead nonces.
   */
  pruneFinished(): void {
    const now = BigInt(this.clock());
    for (const [hash, rec] of this.orders) {
      if (rec.order.expiry > now || rec.pending > 0n || (rec.remaining > 0n && !rec.closed) || this.dirty.has(rec)) continue;
      this.orders.delete(hash);
      this.usedNonces.delete(nonceKey(rec.traderKey, rec.order.nonce));
      this.ordersByTrader.get(rec.traderKey)?.delete(hash);
    }
    this.orderlessCancels.clear();
    for (const [key, expiry] of this.dead) {
      if (expiry <= now) this.dead.delete(key);
      else if (!this.usedNonces.has(key)) {
        const trader = key.slice(0, key.indexOf(":"));
        this.orderlessCancels.set(trader, (this.orderlessCancels.get(trader) ?? 0) + 1);
      }
    }
    if (this.expectedPosition.size > 50_000) this.expectedPosition.clear();
    if (this.chainCache.size > 10_000) this.chainCache.clear();
    if (this.cacheGeneration.size > 100_000) this.cacheGeneration.clear();
    try {
      this.store?.pruneFinished(now, this.tradeHistory);
    } catch (e) {
      this.log.warn("store pruning failed", { error: errMessage(e) });
    }
  }

  /** "Now" for expiry purposes: the later of host time and chain time. */
  private timeNow(): bigint {
    return BigInt(this.clock()) + this.chainTimeLead;
  }

  private bookNow(): bigint {
    return this.timeNow() + this.expiryBuffer;
  }

  private isExpired(order: Order): boolean {
    return order.expiry !== 0n && order.expiry <= this.bookNow();
  }

  private checkNotSeen(hash: Hex, order: Order): void {
    if (this.orders.has(hash)) throw new EngineError("DUPLICATE_ORDER", "order already submitted");
    if (order.nonce < (this.minValidNonce.get(order.trader.toLowerCase()) ?? 0n)) {
      throw new EngineError("NONCE_CANCELLED", "nonce is below the trader's on-chain minValidNonce (cancelAllOrders)");
    }
    if (this.dead.has(nonceKey(order.trader.toLowerCase(), order.nonce))) {
      throw new EngineError("NONCE_CANCELLED", "this nonce was cancelled or its order was closed; sign a new order");
    }
    if (this.usedNonces.has(nonceKey(order.trader.toLowerCase(), order.nonce))) {
      throw new EngineError("NONCE_REUSED", "nonce already used by another order of this trader");
    }
  }

  /**
   * The conditions matching runs under right now. Besides band and pause:
   *  - a market without an index price trades nothing (the contract needs a fresh price
   *    for every fill);
   *  - open-interest cap. The contract refuses a fill only if it ADDS open interest
   *    beyond `maxOpenInterest`. A fill in which either order is reduce-only cannot add
   *    any (the contract makes that side reduce its position), so those always pass.
   *    Every other fill is assumed to add its full size, and is allowed only while
   *    chain open interest + unsettled fills of that kind + this pass stay within the
   *    cap. (Like the pause gate, `reduceOnly` stands for "reducing": reducing flow
   *    without the flag waits when the cap is reached.)
   */
  private matchOptions(marketId: number): RestoreOptions {
    const st = this.marketState.get(marketId);
    const base = {
      now: this.bookNow(),
      band: st?.band,
      reduceOnlyMakersOnly: this.exchangePaused || !this.markets.get(marketId)!.active,
    };
    if (this.chain && st?.index === null && this.chainStateAt !== 0) {
      return { ...base, limit: () => 0n, limitReason: "halted" };
    }
    let room = this.oiHeadroom(marketId);
    const minSize = this.markets.get(marketId)!.minOrderSize;
    // Positions as they will be after the fills of THIS pass (on top of expectedPosition).
    const moved = new Map<string, bigint>();
    /** How much of `size` a reduce-only order may still trade, given where its trader's position is heading. */
    const covered = (o: { trader: string; isBuy: boolean; reduceOnly?: boolean }, size: bigint): bigint => {
      if (!o.reduceOnly) return size;
      const expected = this.expectedPosition.get(`${o.trader}:${marketId}`);
      if (expected === undefined) return size;
      const position = expected + (moved.get(o.trader) ?? 0n);
      const reducible = o.isBuy ? (position < 0n ? -position : 0n) : position > 0n ? position : 0n;
      return size < reducible ? size : reducible;
    };
    return {
      ...base,
      limitReason: "oi_cap",
      limit: (maker, taker, size) => {
        // A reduce-only order whose position has been (or is being, in this very pass)
        // traded away by its trader's other orders must not trade: it would only fail
        // on-chain. It is dropped and matching goes on with the next order.
        const cm = covered(maker, size);
        if (cm === 0n || (cm < size && cm < minSize)) return DROP_MAKER;
        const ct = covered(taker, size);
        if (ct === 0n || (ct < size && ct < minSize)) return DROP_TAKER;
        let allowed = cm < ct ? cm : ct;
        if (room !== null && !maker.reduceOnly && !taker.reduceOnly) {
          if (room < allowed) allowed = room;
          if (allowed < size && allowed < minSize) allowed = 0n;
          room -= allowed;
        }
        if (allowed > 0n) {
          moved.set(maker.trader, (moved.get(maker.trader) ?? 0n) + (maker.isBuy ? allowed : -allowed));
          moved.set(taker.trader, (moved.get(taker.trader) ?? 0n) + (taker.isBuy ? allowed : -allowed));
        }
        return allowed;
      },
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

  /** Entries of `traderKey` in `log` within the last `windowSec` (older ones are dropped). */
  private recentCount(log: Map<string, number[]>, traderKey: string, windowSec: number): number {
    const list = log.get(traderKey);
    if (!list) return 0;
    const cutoff = this.clock() - windowSec;
    while (list.length > 0 && list[0]! <= cutoff) list.shift();
    if (list.length === 0) log.delete(traderKey);
    return list.length;
  }

  private isSuspended(traderKey: string): boolean {
    return this.recentCount(this.faults, traderKey, this.faultWindowSec) >= this.faultThreshold;
  }

  /** Record a dead nonce; it is written with the next commit, together with the order it belongs to. */
  private markDead(trader: Address, nonce: bigint, expiry: bigint): void {
    const key = nonceKey(trader.toLowerCase(), nonce);
    if ((this.dead.get(key) ?? 0n) >= expiry) return;
    this.dead.set(key, expiry);
    if (this.store) this.pendingWrite.dead.push({ trader, nonce, expiry });
  }

  /** Close an order for good. Everything but plain expiry also kills its nonce. */
  private close(rec: OrderRecord, status: "cancelled" | "expired" | "rejected", reason: string): void {
    if (rec.closed) return;
    rec.closed = { status, reason };
    this.touch(rec);
    if (status !== "expired") this.markDead(rec.order.trader, rec.order.nonce, rec.order.expiry);
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
        this.markDead(order.trader, order.nonce, order.expiry);
        throw new EngineError("NONCE_CANCELLED", "nonce has been cancelled on-chain");
      }
      if (filled >= order.size) throw new EngineError("ALREADY_FILLED", "order is already fully filled on-chain");

      if (order.reduceOnly) {
        // Enforced per fill by the contract. Here: there must be a position to reduce, and
        // all of the trader's reduce-only orders on this side together must fit into it -
        // every one beyond that could only ever fail on-chain, at a taker's expense.
        const position = await this.cachedRead(traderKey, `pos:${order.marketId}`, () => chain.positionSize(order.trader, order.marketId));
        // What the position will be once the engine's own unsettled matches for this
        // trader have settled: that, not the on-chain figure, is what is left to reduce.
        let expected = position;
        let resting = 0n;
        for (const r of this.liveOrders(traderKey)) {
          if (r.order.marketId !== order.marketId) continue;
          expected += r.order.isBuy ? r.pending : -r.pending;
          if (r.reduceOnly && r.order.isBuy === order.isBuy) resting += r.remaining;
        }
        this.expectedPosition.set(`${traderKey}:${order.marketId}`, expected);
        const reducible = order.isBuy ? (expected < 0n ? -expected : 0n) : expected > 0n ? expected : 0n;
        if (reducible === 0n) throw new EngineError("REDUCE_ONLY_NO_POSITION", "reduce-only order has no opposite position to reduce");
        if (resting + (order.size - filled) > reducible) {
          throw new EngineError("REDUCE_ONLY_EXCEEDS_POSITION", "the trader's reduce-only orders on this side would exceed the position they reduce");
        }
        return filled;
      }

      const exposures: OpenExposure[] = this.liveOrders(traderKey)
        .filter((r) => !r.reduceOnly)
        .map((r) => ({ marketId: r.order.marketId, isBuy: r.order.isBuy, size: r.remaining + r.pending, limitPrice: r.order.limitPrice }));
      exposures.push({ marketId: order.marketId, isBuy: order.isBuy, size: order.size - filled, limitPrice: order.limitPrice });
      const marketIds = [...new Set(exposures.map((e) => e.marketId))];
      const [free, ...positions] = await Promise.all([
        this.cachedRead(traderKey, "free", () => chain.freeCollateral(order.trader)),
        ...marketIds.map((id) => this.cachedRead(traderKey, `pos:${id}`, () => chain.positionSize(order.trader, id))),
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

  /**
   * A per-trader chain read, reused for `preTradeCacheMs`: a burst of orders from one
   * trader costs a handful of RPC calls, not a handful per order. Dropped as soon as a
   * match of the trader reaches an outcome.
   */
  private async cachedRead(traderKey: string, key: string, read: () => Promise<bigint>): Promise<bigint> {
    const hit = this.preTradeCacheMs > 0 ? this.chainCache.get(traderKey)?.get(key) : undefined;
    if (hit && Date.now() - hit.at < this.preTradeCacheMs) return hit.value;
    // A read that was started before the cache was invalidated (a match of the trader
    // settled meanwhile) may carry the old value: it is neither stored nor used. The
    // caller combines the value with the engine's own unsettled matches, so a value
    // from before a settlement would count that match twice or not at all.
    for (let attempt = 0; ; attempt++) {
      const generation = this.cacheGeneration.get(traderKey) ?? 0;
      const value = await read();
      if ((this.cacheGeneration.get(traderKey) ?? 0) === generation) {
        let cache = this.chainCache.get(traderKey);
        if (!cache) this.chainCache.set(traderKey, (cache = new Map()));
        cache.set(key, { at: Date.now(), value });
        return value;
      }
      if (attempt >= 3) return value; // the trader's matches settle faster than we can read: best effort
    }
  }

  private invalidateReads(traderKey: string): void {
    this.chainCache.delete(traderKey);
    this.cacheGeneration.set(traderKey, (this.cacheGeneration.get(traderKey) ?? 0) + 1);
  }

  private status(rec: OrderRecord): OrderStatus {
    if (rec.closed) return rec.closed.status;
    if (rec.remaining > 0n) return rec.pending + rec.filled > 0n ? "partially_filled" : "open";
    if (rec.pending > 0n) return "pending_settlement";
    // Nothing resting, nothing pending, yet not completely filled: part of it was dropped
    // after a match could not settle through nobody's fault.
    return rec.filled >= rec.order.size ? "filled" : "cancelled";
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
        this.touch(rec);
      }
      const id = `m${++this.matchSeq}`;
      this.pendingWrite.addMatches.push({ id, marketId, makerHash: maker.hash, takerHash: taker.hash, fillSize: f.size, price: f.price, batchId: null });
      const match: Match = {
        id,
        marketId,
        maker: maker.order,
        makerSig: maker.signature,
        makerHash: maker.hash,
        taker: taker.order,
        takerSig: taker.signature,
        takerHash: taker.hash,
        fillSize: f.size,
        price: f.price,
      };
      this.queue.push(match);
      this.trackMatch(match, 1n);
    }
    if (fx.fills.length > 0) {
      for (const trader of new Set(fx.fills.flatMap((f) => [this.orders.get(f.makerId as Hex)!.traderKey, this.orders.get(f.takerId as Hex)!.traderKey]))) {
        this.pullUncoveredReduceOnly(trader, marketId);
      }
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

  /**
   * Account for a match that was made (`sign` 1) or that failed and is undone (`sign` -1):
   * the open interest it may add while unsettled, and the position each trader is
   * expected to have once it settles.
   */
  private trackMatch(m: Match, sign: 1n | -1n): void {
    if (!m.maker.reduceOnly && !m.taker.reduceOnly) {
      this.pendingOi.set(m.marketId, (this.pendingOi.get(m.marketId) ?? 0n) + sign * m.fillSize);
    }
    for (const o of [m.maker, m.taker]) {
      const key = `${o.trader.toLowerCase()}:${m.marketId}`;
      const expected = this.expectedPosition.get(key);
      if (expected !== undefined) this.expectedPosition.set(key, expected + sign * (o.isBuy ? m.fillSize : -m.fillSize));
    }
  }

  /** Reduce-only makers the book dropped because their position is gone. */
  private closeDropped(dropped: { id: string }[]): void {
    for (const { id } of dropped) {
      const rec = this.orders.get(id as Hex);
      if (!rec || rec.closed) continue;
      rec.remaining = 0n;
      this.close(rec, "cancelled", UNCOVERED);
    }
  }

  /**
   * A reduce-only order is only good for as long as the position it reduces is there.
   * When the engine itself matches the trader's position away (with the trader's other
   * orders, reduce-only or not), reduce-only orders that are no longer covered are
   * pulled, newest first, so that they never reach the chain to fail there.
   * Works from the position read when the trader last placed a reduce-only order,
   * adjusted by every match the engine has made for the trader since.
   */
  private pullUncoveredReduceOnly(traderKey: string, marketId: number): void {
    const expected = this.expectedPosition.get(`${traderKey}:${marketId}`);
    if (expected === undefined) return;
    for (const isBuy of [true, false]) {
      // a reduce-only buy reduces a short, a reduce-only sell a long
      let covered = isBuy ? (expected < 0n ? -expected : 0n) : expected > 0n ? expected : 0n;
      const resting = this.liveOrders(traderKey)
        .filter((r) => r.reduceOnly && !r.closed && r.remaining > 0n && r.order.marketId === marketId && r.order.isBuy === isBuy)
        .sort((a, b) => (a.seq < b.seq ? -1 : 1));
      for (const rec of resting) {
        if (rec.remaining <= covered) {
          covered -= rec.remaining;
          continue;
        }
        covered = 0n;
        this.remove(rec, "cancelled", UNCOVERED);
        this.emit("book", marketId);
      }
    }
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
      if (!this.current) {
        this.current = { id: `b${++this.batchSeq}`, matches: this.queue.splice(0, this.maxBatchSize) };
        // Durable before anything is broadcast: after a crash these matches are known
        // to belong to this batch, whose fate the settler can establish.
        this.pendingWrite.batched = { batchId: this.current.id, ids: this.current.matches.map((m) => m.id) };
        if (!this.flush()) {
          this.queue.unshift(...this.current.matches);
          this.current = null;
          this.pendingWrite.batched = null;
          this.batchSeq--;
          this.stalled = true;
          this.lastError = "engine state cannot be persisted";
          await this.retryPause();
          continue;
        }
      }
      const batch = this.current;
      const startedAt = Date.now();
      let results: MatchResult[];
      try {
        results = await this.settler.settle(batch);
        if (results.length !== batch.matches.length) throw new Error("settler returned a wrong number of results");
      } catch (e) {
        this.lastError = errMessage(e);
        this.metrics.inc("batch_errors_total");
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
      if (results.some((r) => r.status === "failed")) await this.refreshChainState({ fresh: true });
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "failed") verdicts.set(i, await this.classify(batch.matches[i]!, r.reason));
      }
      // The outcome is final from here on: the batch must never be handed to the settler again.
      this.current = null;
      this.applyResults(batch, results, verdicts);
      this.metrics.observe("batch_latency_seconds", (Date.now() - startedAt) / 1000);
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
    this.pendingWrite.removeMatches.push(...batch.matches.map((m) => m.id));
    this.metrics.inc("batches_total");
    this.flush();
    for (const marketId of touched) this.emit("book", marketId);
  }

  private applySettled(m: Match, txHash: Hex): void {
    for (const hash of [m.makerHash, m.takerHash]) {
      const rec = this.orders.get(hash)!;
      rec.pending -= m.fillSize;
      rec.filled += m.fillSize;
      rec.strikes = 0;
      this.touch(rec);
      this.invalidateReads(rec.traderKey);
    }
    this.settledCount++;
    this.metrics.inc("matches_settled_total");
    if (!m.maker.reduceOnly && !m.taker.reduceOnly) {
      // No longer pending. Until the next read of the chain, assume it added its full
      // size to open interest (it added that or less).
      this.pendingOi.set(m.marketId, (this.pendingOi.get(m.marketId) ?? 0n) - m.fillSize);
      const oi = this.openInterest.get(m.marketId);
      if (oi !== undefined) this.openInterest.set(m.marketId, oi + m.fillSize);
    }
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
    this.pendingWrite.trades.push(trade);
    if (list.length > this.tradeHistory) list.splice(0, list.length - this.tradeHistory);
    this.emit("trade", trade);
  }

  /**
   * A match failed on-chain: neither order was filled by it.
   *  - A side at fault is removed from the book for good ("rejected"). If the cause is
   *    the trader's own doing (margin, reduce-only) it counts against the trader, and
   *    the trader's other resting orders that would fail the same way are pulled; a
   *    trader who reaches the suspension threshold loses all resting orders. An order
   *    that was merely cancelled, filled or expired on-chain is removed without blame.
   *  - An innocent side gets the size back: a resting order at its original time
   *    priority, an IOC order by being matched again against the remaining book.
   *  - Global condition (pause, stale oracle, price band, OI cap): nobody is at fault
   *    and no strike is given. Only the failed fill is undone. If the taker no longer
   *    rests (fully matched, or IOC) the maker gets the size back. If the taker still
   *    rests, re-posting the slice would re-match the same pair immediately, so the
   *    slice is dropped on both sides and both keep whatever else they have resting.
   *  - FillTooSmall (an earlier fill of the same dust order failed): both sides get
   *    the size back and are matched again, now for the maker's whole remainder; the
   *    maker gets a strike so that this cannot repeat forever.
   *  - Cause unknown: the taker is dropped and the maker gets its size back plus a
   *    strike; `maxOrderStrikes` consecutive strikes remove it.
   */
  private applyFailed(m: Match, verdict: Verdict, reason: Hex): void {
    this.failedCount++;
    const maker = this.orders.get(m.makerHash)!;
    const taker = this.orders.get(m.takerHash)!;
    maker.pending -= m.fillSize;
    taker.pending -= m.fillSize;
    this.touch(maker);
    this.touch(taker);
    this.trackMatch(m, -1n);
    this.invalidateReads(maker.traderKey);
    this.invalidateReads(taker.traderKey);
    this.metrics.inc("matches_failed_total");
    this.log.warn("match failed on-chain", {
      match: m.id,
      makerOrderHash: m.makerHash,
      takerOrderHash: m.takerHash,
      revertData: reason,
      makerFault: verdict.maker.reason ?? null,
      takerFault: verdict.taker.reason ?? null,
      global: verdict.global ?? null,
    });

    if (verdict.global && verdict.rematch) {
      if (++maker.strikes >= this.maxOrderStrikes) this.remove(maker, "rejected", "matches failed on-chain repeatedly");
      else this.giveBack(maker, m.fillSize);
      this.giveBack(taker, m.fillSize);
      return;
    }
    if (verdict.global) {
      const why = `match could not settle on-chain: ${verdict.global}`;
      // Nobody's fault and no strike for the maker - but a taker (order or trader) that
      // keeps producing matches which cannot settle is costing the operator a
      // transaction each time, so both are counted.
      let list = this.globalFailures.get(taker.traderKey);
      if (!list) this.globalFailures.set(taker.traderKey, (list = []));
      list.push(this.clock());
      taker.noFaultFailures++;
      // Only the failed fill is undone, and it is the TAKER's slice that is dropped:
      // the maker gets its size back at its place in the queue. What the taker still
      // has resting stays - unless this keeps happening to it.
      if (taker.ioc) this.remove(taker, "cancelled", why);
      else if (taker.noFaultFailures >= this.maxOrderStrikes) this.remove(taker, "cancelled", `${why} (repeatedly)`);
      else if (!taker.closed && taker.remaining === 0n && taker.pending === 0n) this.close(taker, "cancelled", why);
      // Restoring the maker re-crosses a taker that still rests. Matching then runs under
      // the conditions as they are NOW (the chain was re-read before this): a pause, a
      // halted market or a reached open-interest cap make the newer order give way
      // instead of matching again; if the condition is gone, matching again is right.
      this.giveBack(maker, m.fillSize);
      return;
    }
    const unattributed = !verdict.maker.atFault && !verdict.taker.atFault;

    if (verdict.taker.atFault) this.rejectAtFault(taker, verdict.taker);
    else if (unattributed) this.remove(taker, "rejected", "match failed on-chain (cause not attributable); taker order dropped");

    if (verdict.maker.atFault) {
      this.rejectAtFault(maker, verdict.maker);
    } else if (unattributed && ++maker.strikes >= this.maxOrderStrikes) {
      this.remove(maker, "rejected", "matches failed on-chain repeatedly");
    } else {
      this.giveBack(maker, m.fillSize);
    }
    // The taker is restored after the maker's fate is decided, so that it can never
    // be re-matched against a maker that is about to be removed.
    if (!verdict.taker.atFault && !unattributed) this.giveBack(taker, m.fillSize);
  }

  private rejectAtFault(rec: OrderRecord, side: SideVerdict): void {
    const why = side.reason ?? "order at fault";
    this.remove(rec, "rejected", `match failed on-chain: ${why}`);
    if (!side.kind) return; // cancelled / filled / expired on-chain: not something to hold against the trader
    // Margin failures count towards suspension. Reduce-only failures do not: ordinary
    // counterparty flow can cause them (the trader's other order closed the position
    // first), so anyone could get a trader suspended by trading with them.
    if (side.kind === "margin") {
      let list = this.faults.get(rec.traderKey);
      if (!list) this.faults.set(rec.traderKey, (list = []));
      list.push(this.clock());
    }
    // Orders of the same trader that would fail for the same reason must not stay in
    // the book waiting to cost the next taker a failed round.
    const suspended = this.isSuspended(rec.traderKey);
    for (const other of this.liveOrders(rec.traderKey)) {
      if (other === rec || other.closed || other.remaining === 0n) continue;
      const same =
        side.kind === "margin"
          ? !other.reduceOnly
          : other.reduceOnly && other.order.marketId === rec.order.marketId && other.order.isBuy === rec.order.isBuy;
      if (!suspended && !same) continue;
      this.remove(other, "cancelled", suspended ? "trader suspended after repeated on-chain failures" : `another order of this trader failed on-chain: ${why}`);
      this.emit("book", other.order.marketId);
    }
  }

  /** Take an order out of the book for good. */
  private remove(rec: OrderRecord, status: "cancelled" | "rejected", reason: string): void {
    if (rec.closed) return;
    if (rec.remaining > 0n) this.books.get(rec.order.marketId)!.cancel(rec.hash);
    rec.remaining = 0n;
    this.touch(rec);
    this.close(rec, status, reason);
  }

  /** Return `size` of an undone match to an innocent order, if it is still eligible. */
  private giveBack(rec: OrderRecord, size: bigint): void {
    this.touch(rec);
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
      this.closeDropped(res.dropped);
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

const UNCOVERED = "the position this reduce-only order would reduce is being closed by the trader's other orders";

function emptyWrite() {
  return {
    addMatches: [] as StoredMatch[],
    removeMatches: [] as string[],
    trades: [] as Trade[],
    minValidNonces: [] as { trader: Address; nonce: bigint }[],
    dead: [] as DeadNonce[],
    batched: null as { batchId: string; ids: string[] } | null,
  };
}

function toStored(rec: OrderRecord): StoredOrder {
  return {
    hash: rec.hash,
    order: rec.order,
    signature: rec.signature,
    postOnly: rec.postOnly,
    ioc: rec.ioc,
    seq: rec.seq,
    createdAt: rec.createdAt,
    remaining: rec.remaining,
    pending: rec.pending,
    filled: rec.filled,
    userCancelled: rec.userCancelled,
    strikes: rec.strikes,
    ...(rec.closed ? { closed: rec.closed } : {}),
  };
}
