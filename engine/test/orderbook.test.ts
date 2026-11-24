import { describe, expect, it } from "vitest";
import { OrderBook, type BookOrder, type PlaceOptions } from "../src/book/orderbook.ts";

const NOW = 1_000n;
let n = 0;
const o = (trader: string, isBuy: boolean, price: bigint, expiry = 0n): BookOrder => ({ id: `o${++n}`, trader, isBuy, price, expiry });
const place = (book: OrderBook, order: BookOrder, size: bigint, opts: Partial<PlaceOptions> = {}) => {
  const r = book.place(order, size, { now: NOW, ...opts });
  if (!r.accepted) throw new Error(`rejected: ${r.reason}`);
  return r;
};

describe("OrderBook", () => {
  it("rests a non-crossing order and reports depth aggregated by price", () => {
    const book = new OrderBook();
    place(book, o("a", true, 100n), 5n);
    place(book, o("b", true, 100n), 3n);
    place(book, o("c", true, 99n), 1n);
    place(book, o("d", false, 101n), 2n);
    expect(book.depth(10)).toEqual({
      bids: [{ price: 100n, size: 8n }, { price: 99n, size: 1n }],
      asks: [{ price: 101n, size: 2n }],
    });
    expect(book.depth(1).bids).toEqual([{ price: 100n, size: 8n }]);
  });

  it("matches best price first, then earliest order (price-time priority)", () => {
    const book = new OrderBook();
    const a1 = o("a", false, 101n);
    const b = o("b", false, 100n);
    const c = o("c", false, 100n);
    const a2 = o("a", false, 99n);
    place(book, a1, 1n);
    place(book, b, 1n);
    place(book, c, 1n);
    place(book, a2, 1n);
    const r = place(book, o("t", true, 101n), 4n);
    expect(r.fills.map((f) => [f.makerId, f.price])).toEqual([[a2.id, 99n], [b.id, 100n], [c.id, 100n], [a1.id, 101n]]);
    expect(r.rested).toBe(0n);
    expect(book.size).toBe(0);
  });

  it("bids: highest price first, then earliest", () => {
    const book = new OrderBook();
    const lo = o("a", true, 99n);
    const hi1 = o("b", true, 100n);
    const hi2 = o("c", true, 100n);
    place(book, lo, 1n);
    place(book, hi1, 1n);
    place(book, hi2, 1n);
    const r = place(book, o("t", false, 99n), 3n);
    expect(r.fills.map((f) => f.makerId)).toEqual([hi1.id, hi2.id, lo.id]);
    expect(r.fills.map((f) => f.price)).toEqual([100n, 100n, 99n]);
  });

  it("fills at the maker's price, never the taker's", () => {
    const book = new OrderBook();
    place(book, o("a", false, 100n), 1n);
    const r = place(book, o("t", true, 150n), 1n);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(100n);
    expect(r.fills[0]!.takerIsBuy).toBe(true);
  });

  it("does not match when prices do not cross", () => {
    const book = new OrderBook();
    place(book, o("a", false, 101n), 1n);
    const r = place(book, o("t", true, 100n), 1n);
    expect(r.fills).toEqual([]);
    expect(r.rested).toBe(1n);
    expect(book.bestBid()!.price).toBe(100n);
    expect(book.bestAsk()!.price).toBe(101n);
  });

  it("partially fills the taker and rests the remainder", () => {
    const book = new OrderBook();
    place(book, o("a", false, 100n), 2n);
    const t = o("t", true, 100n);
    const r = place(book, t, 5n);
    expect(r.fills.map((f) => f.size)).toEqual([2n]);
    expect(r.rested).toBe(3n);
    expect(book.get(t.id)!.remaining).toBe(3n);
    expect(book.bestAsk()).toBeUndefined();
  });

  it("partially fills the maker, which keeps its priority", () => {
    const book = new OrderBook();
    const a = o("a", false, 100n);
    const b = o("b", false, 100n);
    place(book, a, 5n);
    place(book, b, 5n);
    place(book, o("t", true, 100n), 2n);
    expect(book.get(a.id)!.remaining).toBe(3n);
    const r = place(book, o("u", true, 100n), 4n);
    expect(r.fills.map((f) => [f.makerId, f.size])).toEqual([[a.id, 3n], [b.id, 1n]]);
  });

  it("cancel removes an order and returns what was resting", () => {
    const book = new OrderBook();
    const a = o("a", false, 100n);
    place(book, a, 5n);
    place(book, o("t", true, 100n), 2n);
    expect(book.cancel(a.id)).toBe(3n);
    expect(book.cancel(a.id)).toBeNull();
    expect(place(book, o("u", true, 100n), 1n).fills).toEqual([]);
  });

  it("self-trade prevention: stops at own order, cancels the incoming remainder, keeps earlier fills", () => {
    const book = new OrderBook();
    const other = o("b", false, 99n);
    const own = o("a", false, 100n);
    const behind = o("c", false, 100n);
    place(book, other, 1n);
    place(book, own, 1n);
    place(book, behind, 1n);
    const t = o("a", true, 100n);
    const r = place(book, t, 3n);
    expect(r.fills.map((f) => f.makerId)).toEqual([other.id]);
    expect(r.cancelled).toBe(2n);
    expect(r.cancelReason).toBe("self_trade");
    expect(r.rested).toBe(0n);
    expect(book.get(t.id)).toBeUndefined();
    // resting orders untouched
    expect(book.get(own.id)!.remaining).toBe(1n);
    expect(book.get(behind.id)!.remaining).toBe(1n);
  });

  it("self-trade prevention does not apply when own order is not reachable by price", () => {
    const book = new OrderBook();
    place(book, o("a", false, 105n), 1n);
    const r = place(book, o("a", true, 100n), 1n);
    expect(r.cancelled).toBe(0n);
    expect(r.rested).toBe(1n);
  });

  it("skips and removes expired makers; rejects expired takers", () => {
    const book = new OrderBook();
    const stale = o("a", false, 99n, 1_000n); // expiry == now => expired
    const live = o("b", false, 100n, 1_001n);
    place(book, stale, 1n, { now: 900n });
    place(book, live, 1n, { now: 900n });
    const r = place(book, o("t", true, 100n), 1n);
    expect(r.expired).toEqual([stale.id]);
    expect(r.fills.map((f) => f.makerId)).toEqual([live.id]);
    expect(book.get(stale.id)).toBeUndefined();
    expect(book.place(o("x", true, 100n, 1_000n), 1n, { now: NOW })).toMatchObject({ accepted: false, reason: "expired" });
  });

  it("pruneExpired removes expired orders on both sides", () => {
    const book = new OrderBook();
    const a = o("a", true, 90n, 1_500n);
    const b = o("b", false, 110n, 1_500n);
    const c = o("c", false, 111n);
    for (const x of [a, b, c]) place(book, x, 1n);
    expect(book.pruneExpired(1_499n)).toEqual([]);
    expect(book.pruneExpired(1_500n).sort()).toEqual([a.id, b.id].sort());
    expect(book.orders().map((x) => x.id)).toEqual([c.id]);
  });

  it("enforces min size, positive price and unique ids", () => {
    const book = new OrderBook(10n);
    expect(book.place(o("a", true, 100n), 9n, { now: NOW })).toMatchObject({ accepted: false, reason: "below_min_size" });
    expect(book.place(o("a", true, 100n), 0n, { now: NOW })).toMatchObject({ accepted: false, reason: "below_min_size" });
    expect(book.place(o("a", true, 0n), 10n, { now: NOW })).toMatchObject({ accepted: false, reason: "invalid_price" });
    const x = o("a", true, 100n);
    place(book, x, 10n);
    expect(book.place(x, 10n, { now: NOW })).toMatchObject({ accepted: false, reason: "duplicate" });
  });

  it("post-only: rejected if it would cross, rests otherwise", () => {
    const book = new OrderBook();
    place(book, o("a", false, 100n), 1n);
    expect(book.place(o("t", true, 100n), 1n, { now: NOW, postOnly: true })).toMatchObject({ accepted: false, reason: "post_only_would_cross" });
    expect(place(book, o("t", true, 99n), 1n, { postOnly: true }).rested).toBe(1n);
    expect(book.depth(5).asks).toEqual([{ price: 100n, size: 1n }]);
  });

  it("post-only ignores an expired best opposite order", () => {
    const book = new OrderBook();
    const stale = o("a", false, 100n, 950n);
    place(book, stale, 1n, { now: 900n });
    const r = place(book, o("t", true, 100n), 1n, { postOnly: true });
    expect(r.rested).toBe(1n);
    expect(r.expired).toEqual([stale.id]);
  });

  it("IOC: fills what it can and never rests", () => {
    const book = new OrderBook();
    place(book, o("a", false, 100n), 2n);
    const t = o("t", true, 100n);
    const r = place(book, t, 5n, { ioc: true });
    expect(r.fills.map((f) => f.size)).toEqual([2n]);
    expect(r.cancelled).toBe(3n);
    expect(r.cancelReason).toBe("ioc");
    expect(book.get(t.id)).toBeUndefined();
    const full = place(book, o("u", true, 100n), 1n, { ioc: true });
    expect(full).toMatchObject({ cancelled: 1n, cancelReason: "ioc", fills: [] });
  });

  it("rejects postOnly together with ioc", () => {
    expect(new OrderBook().place(o("a", true, 1n), 1n, { now: NOW, postOnly: true, ioc: true })).toMatchObject({ accepted: false, reason: "conflicting_flags" });
  });

  describe("restore", () => {
    it("adds size back to a still-resting order without changing its priority", () => {
      const book = new OrderBook();
      const a = o("a", false, 100n);
      const b = o("b", false, 100n);
      const ra = place(book, a, 5n);
      place(book, b, 5n);
      place(book, o("t", true, 100n), 2n);
      expect(book.restore(a, ra.seq, 2n, { now: NOW }).fills).toEqual([]);
      expect(book.get(a.id)!.remaining).toBe(5n);
      expect(place(book, o("u", true, 100n), 5n).fills.map((f) => f.makerId)).toEqual([a.id]);
    });

    it("re-inserts a fully consumed order ahead of later orders at the same price", () => {
      const book = new OrderBook();
      const a = o("a", false, 100n);
      const b = o("b", false, 100n);
      const ra = place(book, a, 1n);
      place(book, b, 1n);
      place(book, o("t", true, 100n), 1n); // consumes a
      book.restore(a, ra.seq, 1n, { now: NOW });
      expect(place(book, o("u", true, 100n), 1n).fills.map((f) => f.makerId)).toEqual([a.id]);
    });

    it("uncrosses the book when the restored order crosses orders that arrived meanwhile", () => {
      const book = new OrderBook();
      const ask = o("a", false, 100n);
      const ra = place(book, ask, 2n);
      place(book, o("t", true, 100n), 2n); // consumes the ask
      const lateBid = o("c", true, 101n);
      place(book, lateBid, 1n); // rests: book has no asks
      const r = book.restore(ask, ra.seq, 2n, { now: NOW });
      // the older order (the ask) is the maker: fill at 100, not 101
      expect(r.fills).toEqual([{ makerId: ask.id, takerId: lateBid.id, price: 100n, size: 1n, takerIsBuy: true }]);
      expect(book.get(ask.id)!.remaining).toBe(1n);
      expect(book.bestBid()).toBeUndefined();
    });

    it("never self-trades while uncrossing: the newer order is cancelled", () => {
      const book = new OrderBook();
      const ask = o("a", false, 100n);
      const ra = place(book, ask, 1n);
      place(book, o("t", true, 100n), 1n);
      const ownBid = o("a", true, 100n);
      place(book, ownBid, 3n);
      const r = book.restore(ask, ra.seq, 1n, { now: NOW });
      expect(r.fills).toEqual([]);
      expect(r.cancelled).toEqual([{ id: ownBid.id, size: 3n, reason: "self_trade" }]);
      expect(book.get(ask.id)!.remaining).toBe(1n);
      expect(book.get(ownBid.id)).toBeUndefined();
    });

    it("does not re-insert an expired order", () => {
      const book = new OrderBook();
      const ask = o("a", false, 100n, 1_200n);
      const ra = place(book, ask, 1n);
      place(book, o("t", true, 100n), 1n);
      expect(book.restore(ask, ra.seq, 1n, { now: 1_200n })).toEqual({ fills: [], expired: [ask.id], cancelled: [] });
      expect(book.size).toBe(0);
    });
  });

  describe("post-only as taker", () => {
    it("a resting post-only order that a restored older order would make the taker is cancelled instead", () => {
      const book = new OrderBook();
      const ask = o("a", false, 100n);
      const ra = place(book, ask, 1n);
      place(book, o("t", true, 100n), 1n); // consumes the ask
      const postOnlyBid: BookOrder = { ...o("b", true, 101n), postOnly: true };
      place(book, postOnlyBid, 1n, { postOnly: true }); // rests: no ask in the book
      const r = book.restore(ask, ra.seq, 1n, { now: NOW });
      expect(r.fills).toEqual([]);
      expect(r.cancelled).toEqual([{ id: postOnlyBid.id, size: 1n, reason: "post_only" }]);
      expect(book.get(ask.id)!.remaining).toBe(1n);
      expect(book.bestBid()).toBeUndefined();
    });

    it("a restored post-only order may still be the maker", () => {
      const book = new OrderBook();
      const ask: BookOrder = { ...o("a", false, 100n), postOnly: true };
      const ra = place(book, ask, 1n, { postOnly: true });
      place(book, o("t", true, 100n), 1n);
      const lateBid = o("c", true, 100n);
      place(book, lateBid, 1n);
      const r = book.restore(ask, ra.seq, 1n, { now: NOW });
      expect(r.fills).toEqual([{ makerId: ask.id, takerId: lateBid.id, price: 100n, size: 1n, takerIsBuy: true }]);
    });
  });

  describe("price band", () => {
    const band = { lo: 95n, hi: 105n };

    it("a taker never trades outside the band and its out-of-band remainder is cancelled, not rested", () => {
      const book = new OrderBook();
      const inBand = o("a", false, 104n);
      const edge = o("b", false, 105n);
      const outside = o("c", false, 106n);
      for (const x of [inBand, edge, outside]) place(book, x, 1n, { band });
      const t = o("t", true, 200n);
      const r = place(book, t, 5n, { band });
      expect(r.fills.map((f) => [f.makerId, f.price])).toEqual([[inBand.id, 104n], [edge.id, 105n]]);
      expect(r).toMatchObject({ rested: 0n, cancelled: 3n, cancelReason: "price_band" });
      expect(book.get(t.id)).toBeUndefined();
      expect(book.get(outside.id)!.remaining).toBe(1n); // far-side orders rest untouched
    });

    it("sell side mirrors it: stops below lo, remainder cancelled", () => {
      const book = new OrderBook();
      const good = o("a", true, 95n);
      const deep = o("b", true, 94n);
      place(book, good, 1n, { band });
      place(book, deep, 1n, { band });
      const r = place(book, o("t", false, 1n), 3n, { band });
      expect(r.fills.map((f) => f.makerId)).toEqual([good.id]);
      expect(r).toMatchObject({ cancelled: 2n, cancelReason: "price_band" });
      expect(book.get(deep.id)!.remaining).toBe(1n);
    });

    it("an order on the wrong side with nothing to match is accepted and fully cancelled; post-only is rejected", () => {
      const book = new OrderBook();
      expect(place(book, o("a", true, 106n), 1n, { band })).toMatchObject({ fills: [], rested: 0n, cancelled: 1n, cancelReason: "price_band" });
      expect(book.size).toBe(0);
      expect(book.place(o("a", false, 94n), 1n, { now: NOW, band, postOnly: true })).toMatchObject({ accepted: false, reason: "post_only_outside_band" });
    });

    it("orders at the band edge and beyond the far side rest", () => {
      const book = new OrderBook();
      expect(place(book, o("a", true, 105n), 1n, { band }).rested).toBe(1n);
      expect(place(book, o("b", true, 10n), 1n, { band }).rested).toBe(1n);
      expect(place(book, o("c", false, 1000n), 1n, { band }).rested).toBe(1n);
    });

    it("pruneOutOfBand removes exactly the resting orders on the wrong side after the band moved", () => {
      const book = new OrderBook();
      const b1 = o("a", true, 100n);
      const b2 = o("b", true, 90n);
      const a1 = o("c", false, 101n);
      const a2 = o("d", false, 120n);
      for (const x of [b1, b2, a1, a2]) place(book, x, 2n, { band });
      expect(book.pruneOutOfBand(band)).toEqual([]);
      // index falls: band is now [85, 95]
      expect(book.pruneOutOfBand({ lo: 85n, hi: 95n })).toEqual([{ id: b1.id, size: 2n }]);
      // index rises: band is now [110, 125]
      expect(book.pruneOutOfBand({ lo: 110n, hi: 125n })).toEqual([{ id: a1.id, size: 2n }]);
      expect(book.orders().map((x) => x.id)).toEqual([b2.id, a2.id]);
    });

    it("restore does not bring back an order that is now on the wrong side", () => {
      const book = new OrderBook();
      const ask = o("a", false, 100n);
      const ra = place(book, ask, 1n, { band });
      place(book, o("t", true, 100n), 1n, { band });
      const r = book.restore(ask, ra.seq, 1n, { now: NOW, band: { lo: 110n, hi: 120n } });
      expect(r).toEqual({ fills: [], expired: [], cancelled: [{ id: ask.id, size: 1n, reason: "price_band" }] });
      expect(book.size).toBe(0);
    });
  });

  describe("reduceOnlyMakersOnly (exchange paused)", () => {
    it("trades only with reduce-only makers and stops at the first other one, cancelling the remainder", () => {
      const book = new OrderBook();
      const ro: BookOrder = { ...o("a", false, 100n), reduceOnly: true };
      const normal = o("b", false, 101n);
      const roBehind: BookOrder = { ...o("c", false, 102n), reduceOnly: true };
      for (const x of [ro, normal, roBehind]) place(book, x, 1n);
      const r = place(book, { ...o("t", true, 102n), reduceOnly: true }, 3n, { reduceOnlyMakersOnly: true });
      expect(r.fills.map((f) => f.makerId)).toEqual([ro.id]);
      expect(r).toMatchObject({ rested: 0n, cancelled: 2n, cancelReason: "halted" });
      expect(book.get(normal.id)!.remaining).toBe(1n);
    });
  });

  it("allowBelowMin lets the remainder of a partly filled order in", () => {
    const book = new OrderBook(10n);
    expect(book.place(o("a", true, 100n), 4n, { now: NOW })).toMatchObject({ accepted: false, reason: "below_min_size" });
    expect(book.place(o("a", true, 100n), 4n, { now: NOW, allowBelowMin: true })).toMatchObject({ accepted: true, rested: 4n });
  });

  it("randomised: never crossed, never self-matched, sizes conserved", () => {
    let seed = 42;
    const rnd = (m: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m;
    const book = new OrderBook();
    const placed = new Map<string, { trader: string; size: bigint }>();
    const filled = new Map<string, bigint>();
    const gone = new Map<string, bigint>();
    for (let i = 0; i < 3000; i++) {
      const order = o(`t${rnd(5)}`, rnd(2) === 0, BigInt(95 + rnd(11)), rnd(10) === 0 ? BigInt(1000 + rnd(50)) : 0n);
      const size = BigInt(1 + rnd(9));
      const now = 1000n + BigInt(Math.floor(i / 100));
      const r = book.place(order, size, { now, ioc: rnd(7) === 0 });
      if (!r.accepted) continue;
      placed.set(order.id, { trader: order.trader, size });
      for (const f of r.fills) {
        expect(placed.get(f.makerId)!.trader).not.toBe(order.trader);
        expect(f.takerId).toBe(order.id);
        for (const id of [f.makerId, f.takerId]) filled.set(id, (filled.get(id) ?? 0n) + f.size);
      }
      gone.set(order.id, r.cancelled);
      if (rnd(4) === 0) {
        const all = book.orders();
        const victim = all[rnd(all.length || 1)];
        if (victim) gone.set(victim.id, (gone.get(victim.id) ?? 0n) + book.cancel(victim.id)!);
      }
      const bid = book.bestBid();
      const ask = book.bestAsk();
      // An expired order may still sit at the top (lazy removal), but live orders never cross.
      if (bid && ask && !(bid.expiry !== 0n && bid.expiry <= now) && !(ask.expiry !== 0n && ask.expiry <= now)) {
        expect(bid.price < ask.price).toBe(true);
      }
    }
    for (const [id, p] of placed) {
      const resting = book.get(id)?.remaining;
      if (resting !== undefined) expect((filled.get(id) ?? 0n) + resting + (gone.get(id) ?? 0n)).toBe(p.size);
      else expect((filled.get(id) ?? 0n) + (gone.get(id) ?? 0n)).toBeLessThanOrEqual(p.size);
    }
  });
});
