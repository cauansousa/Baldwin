/**
 * Pure limit order book for one market. No I/O, no clocks, bigint math only.
 *
 * - Price-time priority: best price first; within a price, lowest `seq` first.
 * - The fill price is always the resting (maker) order's limit price.
 * - Self-trade prevention ("cancel newest"): if the next order an incoming order
 *   would trade with belongs to the same trader, matching stops and the unfilled
 *   remainder of the incoming order is cancelled (it never rests). Fills made
 *   before that point stand. Resting orders are never touched by STP.
 * - Expired resting orders are dropped lazily when reached and by `pruneExpired`.
 *   An order is expired when `expiry !== 0n && expiry <= now` (the caller may pass
 *   `now` with a safety margin added).
 * - The book is never left crossed.
 */

export interface BookOrder {
  /** Unique id (the EIP-712 order hash). */
  id: string;
  /** Trader identity used for self-trade prevention (caller normalises case). */
  trader: string;
  isBuy: boolean;
  /** Limit price (WAD). */
  price: bigint;
  /** Unix seconds; 0n = never expires. */
  expiry: bigint;
}

export interface RestingOrder extends BookOrder {
  remaining: bigint;
  /** Time priority: lower = earlier. */
  seq: bigint;
}

export interface BookFill {
  makerId: string;
  takerId: string;
  /** Always the maker's limit price. */
  price: bigint;
  size: bigint;
  takerIsBuy: boolean;
}

export type RejectReason = "below_min_size" | "invalid_price" | "expired" | "duplicate" | "post_only_would_cross" | "conflicting_flags";
export type CancelReason = "ioc" | "self_trade";

export interface PlaceOptions {
  /** Current time, unix seconds. */
  now: bigint;
  /** Reject instead of taking liquidity. */
  postOnly?: boolean;
  /** Immediate-or-cancel: never rest. */
  ioc?: boolean;
}

export type PlaceResult =
  | { accepted: false; reason: RejectReason; expired: string[] }
  | {
      accepted: true;
      /** Time priority assigned to the order. */
      seq: bigint;
      fills: BookFill[];
      /** Quantity now resting in the book. */
      rested: bigint;
      /** Unfilled quantity that was dropped (IOC remainder or self-trade prevention). */
      cancelled: bigint;
      cancelReason?: CancelReason;
      /** Ids of resting orders removed because they had expired. */
      expired: string[];
    };

export interface UncrossResult {
  fills: BookFill[];
  expired: string[];
  /** Orders whose remainder was cancelled by self-trade prevention. */
  selfTradeCancelled: { id: string; size: bigint }[];
}

export interface Level {
  price: bigint;
  size: bigint;
}

const isExpired = (o: { expiry: bigint }, now: bigint) => o.expiry !== 0n && o.expiry <= now;

export class OrderBook {
  /** Best first: highest price, then lowest seq. */
  private readonly bids: RestingOrder[] = [];
  /** Best first: lowest price, then lowest seq. */
  private readonly asks: RestingOrder[] = [];
  private readonly byId = new Map<string, RestingOrder>();
  private nextSeq = 1n;

  constructor(public readonly minOrderSize: bigint = 1n) {}

  get(id: string): Readonly<RestingOrder> | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  bestBid(): Readonly<RestingOrder> | undefined {
    return this.bids[0];
  }

  bestAsk(): Readonly<RestingOrder> | undefined {
    return this.asks[0];
  }

  /**
   * Place `size` of `order`. Matches against the opposite side while prices cross,
   * then rests any remainder (unless IOC / self-trade prevention cancels it).
   */
  place(order: BookOrder, size: bigint, opts: PlaceOptions): PlaceResult {
    const { now } = opts;
    if (opts.postOnly && opts.ioc) return { accepted: false, reason: "conflicting_flags", expired: [] };
    if (size <= 0n || size < this.minOrderSize) return { accepted: false, reason: "below_min_size", expired: [] };
    if (order.price <= 0n) return { accepted: false, reason: "invalid_price", expired: [] };
    if (isExpired(order, now)) return { accepted: false, reason: "expired", expired: [] };
    if (this.byId.has(order.id)) return { accepted: false, reason: "duplicate", expired: [] };

    const opposite = order.isBuy ? this.asks : this.bids;
    const expired: string[] = [];

    if (opts.postOnly) {
      this.dropExpiredHead(opposite, now, expired);
      const best = opposite[0];
      if (best && this.crosses(order.isBuy, order.price, best.price)) {
        return { accepted: false, reason: "post_only_would_cross", expired };
      }
    }

    const seq = this.nextSeq++;
    const fills: BookFill[] = [];
    let remaining = size;
    let cancelReason: CancelReason | undefined;

    while (remaining > 0n) {
      this.dropExpiredHead(opposite, now, expired);
      const maker = opposite[0];
      if (!maker || !this.crosses(order.isBuy, order.price, maker.price)) break;
      if (maker.trader === order.trader) {
        cancelReason = "self_trade";
        break;
      }
      const fillSize = remaining < maker.remaining ? remaining : maker.remaining;
      fills.push({ makerId: maker.id, takerId: order.id, price: maker.price, size: fillSize, takerIsBuy: order.isBuy });
      remaining -= fillSize;
      maker.remaining -= fillSize;
      if (maker.remaining === 0n) {
        opposite.shift();
        this.byId.delete(maker.id);
      }
    }

    let rested = 0n;
    let cancelled = 0n;
    if (remaining > 0n) {
      if (cancelReason === undefined && opts.ioc) cancelReason = "ioc";
      if (cancelReason !== undefined) {
        cancelled = remaining;
      } else {
        this.insert({ ...order, remaining, seq });
        rested = remaining;
      }
    } else {
      cancelReason = undefined;
    }

    return { accepted: true, seq, fills, rested, cancelled, ...(cancelled > 0n ? { cancelReason } : {}), expired };
  }

  /** Remove an order. Returns the quantity that was resting, or null if unknown. */
  cancel(id: string): bigint | null {
    const o = this.byId.get(id);
    if (!o) return null;
    this.remove(o);
    return o.remaining;
  }

  /**
   * Give `size` back to an order whose earlier match was undone, keeping its original
   * time priority (`seq`). If the order is still resting its quantity is increased;
   * otherwise it is re-inserted. Re-insertion can cross the book (orders that arrived
   * in the meantime may rest at crossing prices), so the book is then uncrossed: the
   * order with the lower `seq` is the maker and its limit price is the fill price.
   */
  restore(order: BookOrder, seq: bigint, size: bigint, now: bigint): UncrossResult {
    if (size <= 0n) throw new Error("restore size must be positive");
    const existing = this.byId.get(order.id);
    if (existing) {
      existing.remaining += size;
    } else if (!isExpired(order, now)) {
      this.insert({ ...order, remaining: size, seq });
      if (seq >= this.nextSeq) this.nextSeq = seq + 1n;
    } else {
      return { fills: [], expired: [order.id], selfTradeCancelled: [] };
    }
    return this.uncross(now);
  }

  /** Match resting orders against each other while best bid >= best ask. */
  private uncross(now: bigint): UncrossResult {
    const res: UncrossResult = { fills: [], expired: [], selfTradeCancelled: [] };
    for (;;) {
      this.dropExpiredHead(this.bids, now, res.expired);
      this.dropExpiredHead(this.asks, now, res.expired);
      const bid = this.bids[0];
      const ask = this.asks[0];
      if (!bid || !ask || bid.price < ask.price) break;
      const [maker, taker] = bid.seq < ask.seq ? [bid, ask] : [ask, bid];
      if (bid.trader === ask.trader) {
        // Same policy as for incoming orders: the newer order is cancelled.
        this.remove(taker);
        res.selfTradeCancelled.push({ id: taker.id, size: taker.remaining });
        continue;
      }
      const size = bid.remaining < ask.remaining ? bid.remaining : ask.remaining;
      res.fills.push({ makerId: maker.id, takerId: taker.id, price: maker.price, size, takerIsBuy: taker.isBuy });
      bid.remaining -= size;
      ask.remaining -= size;
      if (bid.remaining === 0n) this.remove(bid);
      if (ask.remaining === 0n) this.remove(ask);
    }
    return res;
  }

  /** Remove every expired resting order. Returns their ids. */
  pruneExpired(now: bigint): string[] {
    const out: string[] = [];
    for (const side of [this.bids, this.asks]) {
      for (let i = side.length - 1; i >= 0; i--) {
        const o = side[i]!;
        if (isExpired(o, now)) {
          side.splice(i, 1);
          this.byId.delete(o.id);
          out.push(o.id);
        }
      }
    }
    return out;
  }

  /** Aggregated price levels, best first. */
  depth(maxLevels: number): { bids: Level[]; asks: Level[] } {
    return { bids: aggregate(this.bids, maxLevels), asks: aggregate(this.asks, maxLevels) };
  }

  /** All resting orders, bids then asks, each best first. */
  orders(): Readonly<RestingOrder>[] {
    return [...this.bids, ...this.asks];
  }

  // ------------------------------------------------------------ internals

  private crosses(takerIsBuy: boolean, takerPrice: bigint, makerPrice: bigint): boolean {
    return takerIsBuy ? takerPrice >= makerPrice : takerPrice <= makerPrice;
  }

  private dropExpiredHead(side: RestingOrder[], now: bigint, out: string[]): void {
    while (side[0] && isExpired(side[0], now)) {
      const o = side.shift()!;
      this.byId.delete(o.id);
      out.push(o.id);
    }
  }

  /** True if `a` has priority over `b` on the same side. */
  private before(a: RestingOrder, b: RestingOrder): boolean {
    if (a.price !== b.price) return a.isBuy ? a.price > b.price : a.price < b.price;
    return a.seq < b.seq;
  }

  private insert(o: RestingOrder): void {
    const side = o.isBuy ? this.bids : this.asks;
    let lo = 0;
    let hi = side.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.before(side[mid]!, o)) lo = mid + 1;
      else hi = mid;
    }
    side.splice(lo, 0, o);
    this.byId.set(o.id, o);
  }

  private remove(o: RestingOrder): void {
    const side = o.isBuy ? this.bids : this.asks;
    const i = side.indexOf(o);
    if (i >= 0) side.splice(i, 1);
    this.byId.delete(o.id);
  }
}

function aggregate(side: RestingOrder[], maxLevels: number): Level[] {
  const levels: Level[] = [];
  for (const o of side) {
    const last = levels[levels.length - 1];
    if (last && last.price === o.price) {
      last.size += o.remaining;
    } else {
      if (levels.length >= maxLevels) break;
      levels.push({ price: o.price, size: o.remaining });
    }
  }
  return levels;
}
