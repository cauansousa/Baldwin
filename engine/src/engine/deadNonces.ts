import type { Address } from "../types.ts";

/**
 * (trader, nonce) pairs whose order must never be accepted again: cancelled by the
 * trader, closed by the engine (IOC / self-trade / band remainder), or rejected after
 * an on-chain failure. An entry is only needed until the order's expiry has passed.
 */
export interface DeadNonceStore {
  has(trader: Address, nonce: bigint): boolean;
  /** Must be durable when it returns; throws if it cannot be made so. */
  add(trader: Address, nonce: bigint, expiry: bigint): void;
  /** Forget entries whose expiry is <= now (unix seconds). */
  prune(now: bigint): void;
}

const key = (trader: string, nonce: bigint) => `${trader.toLowerCase()}:${nonce}`;

export class MemoryDeadNonceStore implements DeadNonceStore {
  protected readonly entries = new Map<string, bigint>();

  has(trader: Address, nonce: bigint): boolean {
    return this.entries.has(key(trader, nonce));
  }

  add(trader: Address, nonce: bigint, expiry: bigint): void {
    this.entries.set(key(trader, nonce), expiry);
  }

  prune(now: bigint): void {
    for (const [k, expiry] of this.entries) if (expiry <= now) this.entries.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }
}
