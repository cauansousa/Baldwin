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
  /** Blocks before the cursor that are scanned again on each pass (shallow reorgs). Default 0. */
  overlap?: bigint;
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
 */
export class LogPoller<E> {
  private cursor: bigint | undefined;
  private range: bigint;
  private readonly maxRange: bigint;
  private readonly minRange: bigint;
  private readonly overlap: bigint;
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
    this.overlap = opts.overlap ?? 0n;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.log = opts.logger ?? silentLogger;
    this.cursor = opts.loadCursor();
  }

  /** Last completely handled block. */
  get position(): bigint | undefined {
    return this.cursor;
  }

  /** One pass up to the current head. Rejects (after shrinking the span) if a query or the handler fails. */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const head = await this.opts.head();
      if (this.cursor === undefined) {
        this.cursor = this.opts.startBlock !== undefined ? this.opts.startBlock - 1n : head;
        this.opts.saveCursor(this.cursor);
      }
      if (head <= this.cursor) return;
      let from = this.cursor + 1n - this.overlap;
      if (from < 0n) from = 0n;
      while (from <= head) {
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
