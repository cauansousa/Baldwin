import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * Append-only file, one JSON object per line: {"t": trader, "n": nonce, "e": expiry}.
 * Every `add` is written and fsync'd before it returns. On load, expired entries and
 * unreadable lines (a torn last write) are dropped and the file is rewritten compactly.
 */
export class FileDeadNonceStore extends MemoryDeadNonceStore {
  private fd: number;

  constructor(private readonly path: string, now: bigint) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const { t, n, e } = JSON.parse(line) as { t: string; n: string; e: string };
        if (typeof t !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t)) continue;
        const expiry = BigInt(e);
        if (expiry > now) this.entries.set(key(t, BigInt(n)), expiry);
      } catch {
        // torn or corrupt line: ignore
      }
    }
    // Compact: write the live entries to a new file and atomically replace the old one.
    const tmp = `${path}.tmp`;
    const lines = [...this.entries].map(([k, e]) => {
      const [t, n] = k.split(":");
      return JSON.stringify({ t, n, e: e.toString() }) + "\n";
    });
    writeFileSync(tmp, lines.join(""));
    const tfd = openSync(tmp, "r+");
    fsyncSync(tfd);
    closeSync(tfd);
    renameSync(tmp, path);
    this.fd = openSync(path, "a");
  }

  override add(trader: Address, nonce: bigint, expiry: bigint): void {
    if (this.entries.get(key(trader, nonce)) === expiry) return;
    super.add(trader, nonce, expiry);
    writeSync(this.fd, JSON.stringify({ t: trader.toLowerCase(), n: nonce.toString(), e: expiry.toString() }) + "\n");
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }
}
