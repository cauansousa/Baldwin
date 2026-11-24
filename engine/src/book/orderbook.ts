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
 * - Price band (optional, mirrors the contract's oracle band [lo, hi] for fill prices):
 *     * Invariant: no bid rests above `hi` and no ask rests below `lo`. Hence every
 *       crossing pair in the book has its maker price inside the band.
 *     * An incoming order trades as if its limit were clamped into the band (a buy
 *       never pays more than `hi`, a sell never accepts less than `lo`). Nothing is
 *       skipped: makers outside the band are always behind all makers inside it in
 *       price priority, so matching simply stops when the next maker is outside.
 *     * A remainder that would rest on the wrong side (bid above `hi`, ask below
 *       `lo`) is cancelled instead of resting.
 *     * `pruneOutOfBand` removes resting orders that ended up on the wrong side
 *       after the band moved. Orders beyond the far side (bid below `lo`, ask above
 *       `hi`) rest untouched and become matchable when the band reaches them.
 * - Post-only orders never take liquidity: rejected on arrival if they would, and
 *   cancelled if a later `restore` would make them the taker.
 * - `reduceOnlyMakersOnly` (exchange paused): an order may only trade with
 *   reduce-only makers. Matching stops at the first maker that is not reduce-only
 *   and the remainder is cancelled (it cannot rest across a better-priced order).
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
  /** Never executes as taker. */
  postOnly?: boolean;
  /** Carried from the signed order; used by `reduceOnlyMakersOnly`. */
  reduceOnly?: boolean;
}

/** Inclusive bounds for fill prices. */
export interface Band {
  lo: bigint;
  hi: bigint;
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

export type RejectReason =
  | "below_min_size"
  | "invalid_price"
  | "expired"
  | "duplicate"
  | "post_only_would_cross"
  | "post_only_outside_band"
  | "conflicting_flags";
export type CancelReason = "ioc" | "self_trade" | "price_band" | "halted" | "post_only";

export interface PlaceOptions {
  /** Current time, unix seconds. */
  now: bigint;
  /** Reject instead of taking liquidity. */
  postOnly?: boolean;
  /** Immediate-or-cancel: never rest. */
  ioc?: boolean;
  /** Fill-price band; see the file comment. */
  band?: Band | undefined;
  /** Accept a quantity below the market minimum (remainder of a partly filled order). */
  allowBelowMin?: boolean;
  /** Only trade with reduce-only makers (exchange paused). */
  reduceOnlyMakersOnly?: boolean;
}

export interface RestoreOptions {
  now: bigint;
  band?: Band | undefined;
  reduceOnlyMakersOnly?: boolean;
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
  /** Resting orders removed while uncrossing (self-trade, post-only as taker, band, pause). */
  cancelled: { id: string; size: bigint; reason: CancelReason }[];
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

  constructor(public minOrderSize: bigint = 1n) {}

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
    if (size <= 0n || (size < this.minOrderSize && !opts.allowBelowMin)) return { accepted: false, reason: "below_min_size", expired: [] };
    if (order.price <= 0n) return { accepted: false, reason: "invalid_price", expired: [] };
    if (isExpired(order, now)) return { accepted: false, reason: "expired", expired: [] };
    if (this.byId.has(order.id)) return { accepted: false, reason: "duplicate", expired: [] };

    const opposite = order.isBuy ? this.asks : this.bids;
    const expired: string[] = [];
    const wrongSide = isWrongSide(order, opts.band);

    if (opts.postOnly) {
      if (wrongSide) return { accepted: false, reason: "post_only_outside_band", expired };
      this.dropExpiredHead(opposite, now, expired);
      const best = opposite[0];
      if (best && this.crosses(order.isBuy, order.price, best.price)) {
        return { accepted: false, reason: "post_only_would_cross", expired };
      }
    }

    // The taker never trades outside the band: clamp its limit into it.
    let limit = order.price;
    if (opts.band) {
      if (order.isBuy && limit > opts.band.hi) limit = opts.band.hi;
      if (!order.isBuy && limit < opts.band.lo) limit = opts.band.lo;
    }

    const seq = this.nextSeq++;
    const fills: BookFill[] = [];
    let remaining = size;
    let cancelReason: CancelReason | undefined;

    while (remaining > 0n) {
      this.dropExpiredHead(opposite, now, expired);
      const maker = opposite[0];
      if (!maker || !this.crosses(order.isBuy, limit, maker.price)) break;
      if (maker.trader === order.trader) {
        cancelReason = "self_trade";
        break;
      }
      if (opts.reduceOnlyMakersOnly && !maker.reduceOnly) {
        cancelReason = "halted";
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
      if (cancelReason === undefined && wrongSide) cancelReason = "price_band";
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

  /**
   * Put a resting order back exactly as it was persisted (same `seq`), without
   * matching. Only for rebuilding a book that was uncrossed when it was saved.
   */
  load(order: BookOrder, seq: bigint, remaining: bigint): void {
    if (remaining <= 0n) throw new Error("load: remaining must be positive");
    if (this.byId.has(order.id)) throw new Error("load: duplicate order");
    this.insert({ ...order, remaining, seq });
    this.reserveSeq(seq);
  }

  /** Make sure future orders get a time priority after `seq`. */
  reserveSeq(seq: bigint): void {
    if (seq >= this.nextSeq) this.nextSeq = seq + 1n;
  }

  /** Change the resting quantity of an order in place (priority kept). Removes it at 0. */
  setRemaining(id: string, remaining: bigint): void {
    const o = this.byId.get(id);
    if (!o) return;
    if (remaining <= 0n) this.remove(o);
    else o.remaining = remaining;
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
   * A crossing pair that may not trade loses its newer order: same trader (STP),
   * newer order is post-only (it would be the taker), or pause rules forbid the pair.
   * An order that is expired or on the wrong side of the band is not restored.
   */
  restore(order: BookOrder, seq: bigint, size: bigint, opts: RestoreOptions): UncrossResult {
    if (size <= 0n) throw new Error("restore size must be positive");
    const { now } = opts;
    const res: UncrossResult = { fills: [], expired: [], cancelled: [] };
    // Keep the band invariant before anything can be matched.
    if (opts.band) {
      for (const o of this.pruneOutOfBand(opts.band)) {
        res.cancelled.push({ ...o, reason: "price_band" });
      }
    }
    const existing = this.byId.get(order.id);
    if (existing) {
      existing.remaining += size;
    } else if (isExpired(order, now)) {
      res.expired.push(order.id);
      return res;
    } else if (isWrongSide(order, opts.band)) {
      res.cancelled.push({ id: order.id, size, reason: "price_band" });
      return res;
    } else {
      this.insert({ ...order, remaining: size, seq });
      if (seq >= this.nextSeq) this.nextSeq = seq + 1n;
    }
    this.uncross(opts, res);
    return res;
  }

  /** Match resting orders against each other while best bid >= best ask. */
  private uncross(opts: RestoreOptions, res: UncrossResult): void {
    for (;;) {
      this.dropExpiredHead(this.bids, opts.now, res.expired);
      this.dropExpiredHead(this.asks, opts.now, res.expired);
      const bid = this.bids[0];
      const ask = this.asks[0];
      if (!bid || !ask || bid.price < ask.price) break;
      const [maker, taker] = bid.seq < ask.seq ? [bid, ask] : [ask, bid];
      let drop: CancelReason | undefined;
      if (bid.trader === ask.trader) drop = "self_trade";
      else if (taker.postOnly) drop = "post_only";
      else if (opts.reduceOnlyMakersOnly && !(maker.reduceOnly && taker.reduceOnly)) drop = "halted";
      if (drop) {
        // Same policy as for incoming orders: the newer order gives way.
        this.remove(taker);
        res.cancelled.push({ id: taker.id, size: taker.remaining, reason: drop });
        continue;
      }
      const size = bid.remaining < ask.remaining ? bid.remaining : ask.remaining;
      res.fills.push({ makerId: maker.id, takerId: taker.id, price: maker.price, size, takerIsBuy: taker.isBuy });
      bid.remaining -= size;
      ask.remaining -= size;
      if (bid.remaining === 0n) this.remove(bid);
      if (ask.remaining === 0n) this.remove(ask);
    }
  }

  /** Remove resting orders on the wrong side of the band (bids above hi, asks below lo). */
  pruneOutOfBand(band: Band): { id: string; size: bigint }[] {
    const out: { id: string; size: bigint }[] = [];
    while (this.bids[0] && this.bids[0].price > band.hi) {
      const o = this.bids.shift()!;
      this.byId.delete(o.id);
      out.push({ id: o.id, size: o.remaining });
    }
    while (this.asks[0] && this.asks[0].price < band.lo) {
      const o = this.asks.shift()!;
      this.byId.delete(o.id);
      out.push({ id: o.id, size: o.remaining });
    }
    return out;
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

function isWrongSide(order: { isBuy: boolean; price: bigint }, band: Band | undefined): boolean {
  if (!band) return false;
  return order.isBuy ? order.price > band.hi : order.price < band.lo;
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
