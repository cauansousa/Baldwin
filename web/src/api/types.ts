// Normalized shapes used by the UI. docs/SPEC.md fixes the engine routes but
// not every response field, so `normalize.ts` accepts a few reasonable
// spellings and maps them onto these types.

import type { Order } from "@shared";
import type { OrderJson } from "../lib/order";

export interface MarketInfo {
  marketId: number;
  symbol: string;
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
}

/** What GET /health says the engine currently believes. */
export interface EngineHealth {
  /** False when on-chain settlement is stalled. */
  ok: boolean;
  /** Undefined when the engine runs without a chain reader. */
  paused?: boolean;
  markets: {
    marketId: number;
    /** Null when the engine has no fresh index price: the market is halted. */
    indexPrice: bigint | null;
    /** Fill-price band the engine enforces, WAD. */
    band: { lower: bigint; upper: bigint } | null;
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
  cancelOrder(orderHash: string, signature: `0x${string}`): Promise<void>;
  /** Opens the live feed for one market; returns a function that closes it. */
  openFeed(marketId: number, handlers: FeedHandlers): () => void;
}
