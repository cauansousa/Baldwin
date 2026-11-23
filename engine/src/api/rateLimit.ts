/** Fixed-window request counter per key (IP). */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref();
  }

  /** Counts one request. Returns false if the key is over its limit. */
  take(key: string): boolean {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || t - e.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      return true;
    }
    e.count++;
    return e.count <= this.limit;
  }

  /** Seconds until the key's window resets. */
  retryAfterSec(key: string): number {
    const e = this.hits.get(key);
    if (!e) return 0;
    return Math.max(1, Math.ceil((e.windowStart + this.windowMs - this.now()) / 1000));
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.hits) if (t - e.windowStart >= this.windowMs) this.hits.delete(k);
  }

  close(): void {
    clearInterval(this.timer);
  }
}
