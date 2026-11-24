import { errMessage, silentLogger, type Logger } from "../types.ts";

export interface LogPollerOptions<E> {
  /** For log lines. */
  name: string;
  /** Latest block number. */
  head(): Promise<bigint>;
  /** Events in the inclusive block range. */
  fetch(from: bigint, to: bigint): Promise<E[]>;
  /** Must be idempotent: a range can be delivered more than once. */
  handle(events: E[]): void | Promise<void>;
  /** Last block that was completely handled, if any was recorded. */
  loadCursor(): bigint | undefined;
  /** Called after each handled range; should be durable. */
  saveCursor(block: bigint): void;
  /** First block to scan when there is no cursor. Default: start after the current head. */
  startBlock?: bigint | undefined;
  /** Largest block span per query. Default 2000. */
  maxRange?: bigint;
  /** The span is never reduced below this. Default 10. */
  minRange?: bigint;
  /**
   * Blocks before the cursor that are scanned again on each pass. Covers shallow
   * reorgs and a backend that answered a query before it had the newest blocks.
   * Default 5.
   */
  overlap?: bigint;
  /**
   * Only blocks up to `head - headLag` are scanned: an RPC backend that is a block or
   * two behind the one that reported the head answers `eth_getLogs` for a range it
   * has not fully seen with fewer logs and no error. Default 2.
   */
  headLag?: bigint;
  /** At most this many ranges per `poll` (the rest follows on later passes). Default: no limit. */
  maxRangesPerPoll?: number;
  /** Longest pause between attempts after errors, ms. Default 30000. */
  maxBackoffMs?: number;
  logger?: Logger;
  onError?: (e: unknown) => void;
}

/**
 * Reads contract events by polling `eth_getLogs` over block ranges with a persisted
 * cursor. No subscriptions and no server-side filters, which public RPC providers
 * drop without notice. The block span adapts: halved when a query fails (range or
 * response-size limits, rate limits), doubled again after successes; failed passes
 * are retried with exponential backoff. Because the cursor only advances after a
 * range was handled, a restart continues where it left off and misses nothing.
 *
 * `eth_getLogs` is not trusted right up to the head: scanning stops `headLag` blocks
 * short of it and every pass re-reads the last `overlap` blocks, so the handler sees
 * some events more than once and must be idempotent.
 */
export class LogPoller<E> {
  private cursor: bigint | undefined;
  private range: bigint;
  private readonly maxRange: bigint;
  private readonly minRange: bigint;
  private readonly overlap: bigint;
  private readonly headLag: bigint;
  private readonly maxRangesPerPoll: number;
  private caughtUp = false;
  private readonly maxBackoffMs: number;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private failures = 0;

  constructor(private readonly opts: LogPollerOptions<E>) {
    this.maxRange = opts.maxRange ?? 2000n;
    this.minRange = opts.minRange ?? 10n;
    this.range = this.maxRange;
    this.overlap = opts.overlap ?? 5n;
    this.headLag = opts.headLag ?? 2n;
    this.maxRangesPerPoll = opts.maxRangesPerPoll ?? Number.MAX_SAFE_INTEGER;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.log = opts.logger ?? silentLogger;
    this.cursor = opts.loadCursor();
  }

  /** Last completely handled block. */
  get position(): bigint | undefined {
    return this.cursor;
  }

  /** True once a pass has reached the scan target (head - headLag). */
  get isCaughtUp(): boolean {
    return this.caughtUp;
  }

  /**
   * One pass up to `head - headLag` (or `maxRangesPerPoll` ranges). Rejects (after
   * shrinking the span) if a query or the handler fails.
   */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tip = await this.opts.head();
      const head = tip - this.headLag;
      if (this.cursor === undefined) {
        this.cursor = this.opts.startBlock !== undefined ? this.opts.startBlock - 1n : head < -1n ? -1n : head;
        this.opts.saveCursor(this.cursor);
      }
      if (head <= this.cursor) {
        this.caughtUp = true;
        return;
      }
      let from = this.cursor + 1n - this.overlap;
      if (from < 0n) from = 0n;
      let ranges = 0;
      while (from <= head) {
        if (ranges++ >= this.maxRangesPerPoll) {
          this.caughtUp = false;
          return;
        }
        const to = from + this.range - 1n < head ? from + this.range - 1n : head;
        let events: E[];
        try {
          events = await this.opts.fetch(from, to);
        } catch (e) {
          if (this.range > this.minRange) this.range = this.range / 2n > this.minRange ? this.range / 2n : this.minRange;
          throw e;
        }
        await this.opts.handle(events);
        if (to > this.cursor) {
          this.cursor = to;
          this.opts.saveCursor(to);
        }
        from = to + 1n;
        if (this.range < this.maxRange) this.range = this.range * 2n < this.maxRange ? this.range * 2n : this.maxRange;
      }
      this.caughtUp = true;
    } finally {
      this.running = false;
    }
  }

  /** Poll until one pass succeeds. Rejects after `attempts` failures. */
  async catchUp(attempts = 8, baseDelayMs = 500): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await this.poll();
        return;
      } catch (e) {
        this.opts.onError?.(e);
        if (i >= attempts) throw e;
        this.log.warn(`${this.opts.name}: log query failed; retrying`, { attempt: i, error: errMessage(e) });
        await new Promise((r) => setTimeout(r, Math.min(this.maxBackoffMs, baseDelayMs * 2 ** (i - 1))));
      }
    }
  }

  /** Poll every `intervalMs`; after errors, back off exponentially up to `maxBackoffMs`. */
  start(intervalMs: number): void {
    this.stopped = false;
    const tick = async () => {
      let delay = intervalMs;
      try {
        await this.poll();
        this.failures = 0;
      } catch (e) {
        this.failures++;
        this.opts.onError?.(e);
        delay = Math.min(this.maxBackoffMs, intervalMs * 2 ** Math.min(this.failures, 10));
        this.log.warn(`${this.opts.name}: log query failed`, { failures: this.failures, retryInMs: delay, error: errMessage(e) });
      }
      if (!this.stopped) {
        this.timer = setTimeout(tick, delay);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
