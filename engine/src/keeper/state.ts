import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "../types.ts";

export interface KeeperSnapshot {
  /** Last block whose events were completely handled. */
  cursor?: bigint | undefined;
  tracked: { trader: Address; markets: number[] }[];
}

/** Persistence for the keeper's event cursor and tracked accounts. */
export interface KeeperStateStore {
  load(): KeeperSnapshot | null;
  /** Durable when it returns. */
  save(s: KeeperSnapshot): void;
}

/**
 * One small JSON file, replaced atomically (write to a temp file, fsync, rename), so a
 * crash leaves either the old or the new state, never a torn one.
 */
export class FileKeeperState implements KeeperStateStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  load(): KeeperSnapshot | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const o = JSON.parse(text) as { cursor?: string; tracked?: { trader: Address; markets: number[] }[] };
    return { cursor: o.cursor !== undefined ? BigInt(o.cursor) : undefined, tracked: o.tracked ?? [] };
  }

  save(s: KeeperSnapshot): void {
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify({ cursor: s.cursor?.toString(), tracked: s.tracked }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
