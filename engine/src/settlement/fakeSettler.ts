import type { Hex, Match } from "../types.ts";
import { type Batch, type MatchResult, type Settler } from "./types.ts";

/**
 * In-memory settler for tests and offline development.
 *
 * By default every match settles. `failWhen` makes selected matches fail (as the
 * contract would with MatchFailed); `beforeSettle` can throw to simulate submission
 * errors. Like a real chain it remembers which batch ids were applied, so retrying a
 * batch returns the original results instead of settling twice.
 */
export class FakeSettler implements Settler {
  /** Every batch as received, including retries. */
  readonly calls: Batch[] = [];
  /** Matches that settled, in order. */
  readonly settled: Match[] = [];
  /** Total settled size per order hash. */
  readonly filled = new Map<Hex, bigint>();
  /** Return a revert-data hex string to fail the match, or null/undefined to settle it. */
  failWhen: (match: Match) => Hex | null | undefined = () => null;
  /** Called before a batch is applied; throw to simulate a submission error. */
  beforeSettle: (batch: Batch, attempt: number) => void | Promise<void> = () => {};

  private readonly done = new Map<string, MatchResult[]>();
  private txSeq = 0;

  async settle(batch: Batch): Promise<MatchResult[]> {
    this.calls.push(batch);
    const attempt = this.calls.filter((b) => b.id === batch.id).length;
    await this.beforeSettle(batch, attempt);
    const prior = this.done.get(batch.id);
    if (prior) return prior;
    const txHash = `0x${(++this.txSeq).toString(16).padStart(64, "0")}` as Hex;
    // Decide every outcome first, then apply: a batch is atomic, like a transaction.
    const reasons = batch.matches.map((m) => this.failWhen(m) ?? null);
    const results = batch.matches.map((m, i): MatchResult => {
      const reason = reasons[i];
      if (reason) return { status: "failed", txHash, reason };
      for (const [hash, order] of [[m.makerHash, m.maker], [m.takerHash, m.taker]] as const) {
        const total = (this.filled.get(hash) ?? 0n) + m.fillSize;
        if (total > order.size) throw new Error(`FakeSettler: order ${hash} overfilled`);
        this.filled.set(hash, total);
      }
      this.settled.push(m);
      return { status: "settled", txHash };
    });
    this.done.set(batch.id, results);
    return results;
  }
}
