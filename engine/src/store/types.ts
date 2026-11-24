import type { DeadNonceStore } from "../engine/deadNonces.ts";
import type { Address, Hex, Order } from "../types.ts";

export interface StoredOrder {
  hash: Hex;
  order: Order;
  signature: Hex;
  postOnly: boolean;
  ioc: boolean;
  /** Time priority in its book. */
  seq: bigint;
  createdAt: number;
  remaining: bigint;
  pending: bigint;
  filled: bigint;
  userCancelled: boolean;
  strikes: number;
  closed?: { status: "cancelled" | "expired" | "rejected"; reason: string };
}

/** A match that has not reached a final on-chain outcome yet. */
export interface StoredMatch {
  id: string;
  marketId: number;
  makerHash: Hex;
  takerHash: Hex;
  fillSize: bigint;
  price: bigint;
  /** Set once the match has been assigned to a settlement batch. */
  batchId: string | null;
}

export interface StoredTrade {
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
  timestamp: number;
}

export interface Snapshot {
  orders: StoredOrder[];
  /** In creation order. */
  matches: StoredMatch[];
  /** Oldest first. */
  trades: StoredTrade[];
  minValidNonces: { trader: Address; nonce: bigint }[];
}

/** Everything one engine operation changed. Applied atomically. */
export interface Commit {
  /** Orders to insert or overwrite. */
  orders: StoredOrder[];
  addMatches: StoredMatch[];
  /** Matches that got their batch id. */
  batched: { batchId: string; ids: string[] } | null;
  /** Matches that reached a final outcome. */
  removeMatches: string[];
  trades: StoredTrade[];
  minValidNonces: { trader: Address; nonce: bigint }[];
  /** Small key/value facts (counters). */
  meta: Record<string, string>;
}

/** Minimal key/value persistence (cursors, the settler's in-flight batch). */
export interface KeyValueStore {
  getMeta(key: string): string | undefined;
  /** Durable when it returns. */
  setMeta(key: string, value: string): void;
}

/**
 * Durable engine state. `commit`, `setMeta` and `add` must be atomic and on stable
 * storage when they return; they throw if that cannot be guaranteed.
 */
export interface EngineStore extends DeadNonceStore, KeyValueStore {
  load(): Snapshot;
  commit(c: Commit): void;
  /** Delete finished orders whose expiry is <= now, and trades beyond `keepTrades` per market. */
  pruneFinished(now: bigint, keepTrades: number): void;
  close(): void;
}
