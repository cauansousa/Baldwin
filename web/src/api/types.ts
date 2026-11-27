// Normalized shapes used by the UI. docs/SPEC.md fixes the engine routes but
// not every response field, so `normalize.ts` accepts a few reasonable
// spellings and maps them onto these types.

import type { Order } from "@shared";
import type { EngineMarketStats } from "../lib/marketData";
import type { OrderJson } from "../lib/order";

export interface MarketInfo {
  marketId: number;
  symbol: string;
  /** Contract figures mirrored by the engine (refreshed every ~10 s); absent fields are read from the chain. */
  stats?: EngineMarketStats;
}

export interface BookLevel {
  price: bigint; // WAD
  size: bigint; // WAD, aggregate at this price
}

export interface OrderBook {
  bids: BookLevel[]; // best (highest) first
  asks: BookLevel[]; // best (lowest) first
}

export interface Trade {
  id: string;
  price: bigint; // WAD
  size: bigint; // WAD
  takerIsBuy: boolean;
  timestampMs: number;
}

export interface OpenOrder {
  orderHash: `0x${string}`;
  order: Order;
  /** Engine status: open, partially_filled, pending_settlement, filled, cancelled, expired, rejected. */
  status: string;
  /** Confirmed on-chain, WAD. */
  filledSize: bigint;
  /** Matched, awaiting on-chain confirmation, WAD. */
  pendingSize: bigint;
  /** Still resting in the book, WAD. Zero means there is nothing left to cancel. */
  remainingSize: bigint;
  postOnly: boolean;
  ioc: boolean;
}

export interface PostOrderRequest {
  order: OrderJson;
  signature: `0x${string}`;
  /** EIP-712 hash of `order`, computed locally. Not sent to the engine (it derives it); used by the mock. */
  orderHash?: `0x${string}`;
  /** Engine-side execution flags; not part of the signed order. */
  postOnly?: boolean;
  ioc?: boolean;
}

export interface PostOrderResult {
  orderHash: string;
  status: string;
  /** Why the engine closed the order, when it did. */
  reason?: string;
  fills: { price: bigint; size: bigint }[];
  /** True when this exact signed order had already been accepted: the fields show its current state. */
  duplicate: boolean;
  /** Resting / matched awaiting settlement / confirmed on-chain, WAD. Undefined if the engine did not say. */
  remaining?: bigint;
  pending?: bigint;
  filled?: bigint;
}

export interface CancelResult {
  status: string;
  /** False when the engine had never seen the order and only recorded its nonce as dead. */
  known: boolean;
}

/** What GET /health says the engine currently believes. */
export interface EngineHealth {
  ok: boolean;
  /** The engine's clock, unix seconds (the later of its host clock and chain time). */
  time?: number;
  /** Set while chain time is too far ahead of the engine's clock: order intake is halted. */
  clockSkewSec?: number;
  /** Reconciling with the chain after a restart: orders are refused for the moment. */
  recovering: boolean;
  /** On-chain settlement is stalled. */
  stalled: boolean;
  /** Undefined when the engine runs without a chain reader. */
  paused?: boolean;
  /** The engine's last read of the contract's insurance fund / bad debt, USDC units. */
  insuranceFund?: bigint;
  totalBadDebt?: bigint;
  markets: {
    marketId: number;
    /** Null when the engine has no fresh index price: the market is halted. */
    indexPrice: bigint | null;
    /** Fill-price band the engine enforces, WAD. */
    band: { lower: bigint; upper: bigint } | null;
    /** Only fills that do not add open interest are matched in this market. */
    openInterestCapReached: boolean;
  }[];
}

export interface FeedHandlers {
  onStatus(connected: boolean): void;
  /** Full book snapshot, or null meaning "the book changed, re-fetch it". */
  onBook(book: OrderBook | null): void;
  onTrades(trades: Trade[]): void;
}

export interface EngineApi {
  getHealth(): Promise<EngineHealth>;
  getMarkets(): Promise<MarketInfo[]>;
  getOrderBook(marketId: number, depth: number): Promise<OrderBook>;
  getTrades(marketId: number): Promise<Trade[]>;
  getOpenOrders(trader: `0x${string}`): Promise<OpenOrder[]>;
  postOrder(req: PostOrderRequest): Promise<PostOrderResult>;
  /**
   * Off-chain cancel. `trader` and `nonce` let the engine verify the signature
   * and kill the nonce even for an order it has never seen.
   */
  cancelOrder(orderHash: string, signature: `0x${string}`, trader: `0x${string}`, nonce: bigint): Promise<CancelResult>;
  /** Opens the live feed for one market; returns a function that closes it. */
  openFeed(marketId: number, handlers: FeedHandlers): () => void;
}
