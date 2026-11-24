import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { EngineError, type Trade } from "../src/engine/engine.ts";
import { hashOrder } from "../src/signing.ts";
import { BatchRevertedError } from "../src/settlement/types.ts";
import { alice, bob, carol, DOMAIN, harness, makeOrder, MARKET, signCancel, signOrder, wad } from "./helpers.ts";

const REASON = "0xdeadbeef";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "OK";
};

describe("order intake", () => {
  it("accepts a valid signed order and rests it", async () => {
    const h = harness();
    const r = await h.place(alice, true, 100, 1);
    expect(r).toMatchObject({ status: "open", fills: [], remaining: wad(1) });
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([{ price: wad(100), size: wad(1) }]);
    expect(h.engine.getOpenOrders(alice.address)).toHaveLength(1);
  });

  it("rejects a signature that does not recover to order.trader", async () => {
    const h = harness();
    const order = makeOrder(alice, true, 100, 1);
    expect(await code(h.engine.submit({ order, signature: await signOrder(bob, order) }))).toBe("BAD_SIGNATURE");
    expect(await code(h.engine.submit({ order: { ...order, size: wad(2) }, signature: await signOrder(alice, order) }))).toBe("BAD_SIGNATURE");
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([]);
  });

  it("rejects duplicates, also when submitted concurrently", async () => {
    const h = harness();
    const order = makeOrder(alice, true, 100, 1);
    const signature = await signOrder(alice, order);
    const results = await Promise.all([code(h.engine.submit({ order, signature })), code(h.engine.submit({ order, signature }))]);
    expect(results.sort()).toEqual(["DUPLICATE_ORDER", "OK"]);
    expect(await code(h.engine.submit({ order, signature }))).toBe("DUPLICATE_ORDER");
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([{ price: wad(100), size: wad(1) }]);
  });

  it("rejects expired orders, including those expiring within the safety buffer", async () => {
    const h = harness({ expiryBufferSec: 5 });
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 999n } }))).toBe("EXPIRED");
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 1005n } }))).toBe("EXPIRED");
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 1006n } }))).toBe("OK");
  });

  it("rejects unknown market, inactive market, zero size, zero price and size below the market minimum", async () => {
    const h = harness({ markets: [MARKET, { ...MARKET, marketId: 2, active: false }] });
    expect(await code(h.place(alice, true, 100, 1, { order: { marketId: 9 } }))).toBe("UNKNOWN_MARKET");
    expect(await code(h.place(alice, true, 100, 1, { order: { marketId: 2 } }))).toBe("MARKET_INACTIVE");
    expect(await code(h.place(alice, true, 100, 0))).toBe("INVALID_ORDER");
    expect(await code(h.place(alice, true, 0, 1))).toBe("INVALID_ORDER");
    expect(await code(h.place(alice, true, 100, "0.009"))).toBe("BELOW_MIN_SIZE");
    expect(await code(h.place(alice, true, 100, "0.01"))).toBe("OK");
  });

  it("rejects a nonce that was cancelled or is used by another order", async () => {
    const h = harness();
    const first = await h.place(alice, true, 100, 1, { order: { nonce: 500n } });
    expect(await code(h.place(alice, true, 101, 1, { order: { nonce: 500n } }))).toBe("NONCE_REUSED");
    await h.engine.cancel(first.orderHash, await signCancel(alice, alice.address, 500n));
    expect(await code(h.place(alice, true, 101, 1, { order: { nonce: 500n } }))).toBe("NONCE_CANCELLED");
    // nonces are per trader
    expect(await code(h.place(bob, true, 101, 1, { order: { nonce: 500n } }))).toBe("OK");
  });

  it("post-only is rejected when it would cross and leaves no trace", async () => {
    const h = harness();
    await h.place(alice, false, 100, 1);
    const order = makeOrder(bob, true, 100, 1);
    const signature = await signOrder(bob, order);
    expect(await code(h.engine.submit({ order, signature, postOnly: true }))).toBe("POST_ONLY_WOULD_CROSS");
    // not recorded: the same order may be sent again without the flag
    expect((await h.engine.submit({ order, signature })).fills).toHaveLength(1);
  });

  it("IOC fills what it can; the rest is cancelled and never rests", async () => {
    const h = harness();
    await h.place(alice, false, 100, 1);
    const r = await h.place(bob, true, 100, 3, { ioc: true });
    expect(r).toMatchObject({ status: "cancelled", remaining: 0n });
    expect(r.fills.map((f) => f.size)).toEqual([wad(1)]);
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
  });

  it("never matches a trader against themselves", async () => {
    const h = harness();
    await h.place(alice, false, 100, 1);
    const r = await h.place(alice, true, 100, 1);
    expect(r).toMatchObject({ status: "cancelled", fills: [] });
    expect(r.reason).toMatch(/self-trade/);
    await h.engine.idle();
    expect(h.settler.settled).toEqual([]);
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([{ price: wad(100), size: wad(1) }]);
  });

  it("drops resting orders once they expire", async () => {
    const h = harness({ expiryBufferSec: 0 });
    const r = await h.place(alice, false, 100, 1, { order: { expiry: 1100n } });
    h.clock.now = 1099;
    h.engine.sweepExpired();
    expect(h.engine.getOrder(r.orderHash)!.status).toBe("open");
    h.clock.now = 1100;
    h.engine.sweepExpired();
    expect(h.engine.getOrder(r.orderHash)).toMatchObject({ status: "expired", remaining: 0n });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([]);
    expect((await h.place(bob, true, 100, 1)).fills).toEqual([]);
  });

  it("an expired maker is skipped at match time even before the sweep runs", async () => {
    const h = harness({ expiryBufferSec: 0 });
    const stale = await h.place(alice, false, 99, 1, { order: { expiry: 1100n } });
    await h.place(carol, false, 100, 1);
    h.clock.now = 1100;
    const r = await h.place(bob, true, 100, 1);
    expect(r.fills.map((f) => f.price)).toEqual([wad(100)]);
    expect(h.engine.getOrder(stale.orderHash)!.status).toBe("expired");
  });
});

describe("pre-trade chain checks", () => {
  it("rejects nonces cancelled on-chain and orders already filled on-chain", async () => {
    const h = harness({ withChain: true });
    const o1 = makeOrder(alice, true, 100, 1);
    h.chain.cancelled.add(`${alice.address.toLowerCase()}:${o1.nonce}`);
    expect(await code(h.engine.submit({ order: o1, signature: await signOrder(alice, o1) }))).toBe("NONCE_CANCELLED");
    const o2 = makeOrder(alice, true, 100, 1);
    h.chain.filled.set(hashOrder(DOMAIN, o2), wad(1));
    expect(await code(h.engine.submit({ order: o2, signature: await signOrder(alice, o2) }))).toBe("ALREADY_FILLED");
  });

  it("only the size not yet filled on-chain enters the book", async () => {
    const h = harness({ withChain: true });
    const order = makeOrder(alice, true, 100, 1);
    h.chain.filled.set(hashOrder(DOMAIN, order), wad("0.4"));
    const r = await h.engine.submit({ order, signature: await signOrder(alice, order) });
    expect(r).toMatchObject({ status: "partially_filled", remaining: wad("0.6") });
    expect(h.engine.getOrder(r.orderHash)).toMatchObject({ filled: wad("0.4"), pending: 0n });
  });

  it("rejects orders the account cannot margin, but lets position-reducing orders through", async () => {
    const h = harness({ withChain: true });
    // 1 BTC at index 100: 20% initial margin = 20 USDC, plus taker fee 5 bps of 100 = 0.05 (+ rounding)
    h.chain.free.set(alice.address.toLowerCase(), 20_050_001n);
    expect(await code(h.place(alice, true, 100, 1))).toBe("INSUFFICIENT_MARGIN");
    h.chain.free.set(alice.address.toLowerCase(), 20_050_002n);
    expect(await code(h.place(alice, true, 100, 1))).toBe("OK");
    h.chain.free.set(bob.address.toLowerCase(), 0n);
    h.chain.positions.set(`${bob.address.toLowerCase()}:1`, wad(2));
    expect(await code(h.place(bob, false, 104, 2))).toBe("OK"); // closes the long: needs nothing
    expect(await code(h.place(bob, false, 104, 1))).toBe("OK"); // short 1 after both: still less exposure than long 2
    expect(await code(h.place(bob, false, 104, 4))).toBe("INSUFFICIENT_MARGIN"); // all three: short 5, more exposure than before
  });

  it("checks margin for all of a trader's open orders together, including fees and off-index prices", async () => {
    const h = harness({ withChain: true });
    const me = alice.address.toLowerCase();
    // Enough for one order of 1 @ 100 (20.05) but not for two.
    h.chain.free.set(me, 30_000_000n);
    expect(await code(h.place(alice, true, 100, 1))).toBe("OK");
    expect(await code(h.place(alice, true, 99, 1))).toBe("INSUFFICIENT_MARGIN");
    // Opposite-side orders do not add up: worst case is still 1 unit either way.
    expect(await code(h.place(alice, false, 104, 1))).toBe("OK");
    // Concurrent submissions cannot both slip through.
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n);
    const results = await Promise.all([code(h.place(bob, true, 100, 1)), code(h.place(bob, true, 100, 1))]);
    expect(results.sort()).toEqual(["INSUFFICIENT_MARGIN", "OK"]);
    // Buying above the index costs the difference immediately: 1 @ 105 with index 100
    // needs 20 (margin) + 5 (loss vs index) + 0.0525 (fee).
    h.chain.free.set(carol.address.toLowerCase(), 25_000_000n);
    expect(await code(h.place(carol, true, 105, 1))).toBe("INSUFFICIENT_MARGIN");
    h.chain.free.set(carol.address.toLowerCase(), 25_052_502n);
    expect(await code(h.place(carol, true, 105, 1))).toBe("OK");
  });

  it("rejects reduce-only orders without an opposite position", async () => {
    const h = harness({ withChain: true });
    expect(await code(h.place(alice, false, 100, 1, { order: { reduceOnly: true } }))).toBe("REDUCE_ONLY_NO_POSITION");
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, wad(1));
    expect(await code(h.place(alice, false, 100, 1, { order: { reduceOnly: true } }))).toBe("OK");
  });

  it("halts intake (503) while the chain cannot be read, and resumes when it can", async () => {
    const h = harness({ withChain: true });
    h.chain.fail = true;
    const e = await h.place(alice, true, 100, 1).catch((x) => x);
    expect(e).toBeInstanceOf(EngineError);
    expect(e).toMatchObject({ code: "MARKET_HALTED", httpStatus: 503 });
    h.chain.fail = false;
    expect(await code(h.place(alice, true, 100, 1))).toBe("OK");
  });

  it("a chain read failing during the pre-trade check is a 503, not an acceptance", async () => {
    const h = harness({ withChain: true });
    await h.engine.refreshChainState();
    h.chain.fail = true;
    expect(await h.place(alice, true, 100, 1).catch((x) => x)).toMatchObject({ code: "CHAIN_UNAVAILABLE", httpStatus: 503 });
  });
});

describe("matching and settlement", () => {
  it("reports fills as pending, then confirms them as trades once settled on-chain", async () => {
    const h = harness();
    const trades: Trade[] = [];
    h.engine.on("trade", (t) => trades.push(t));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.settler.beforeSettle = () => gate;

    const maker = await h.place(alice, false, 100, 2);
    const taker = await h.place(bob, true, 105, 1);
    expect(taker.status).toBe("pending_settlement");
    expect(taker.fills).toEqual([{ makerOrderHash: maker.orderHash, takerOrderHash: taker.orderHash, price: wad(100), size: wad(1), status: "pending" }]);
    // before confirmation: liquidity is gone from the book, nothing on the tape
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([{ price: wad(100), size: wad(1) }]);
    expect(h.engine.getTrades(1, 10)).toEqual([]);
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "partially_filled", remaining: wad(1), pending: wad(1), filled: 0n });

    release();
    await h.engine.idle();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ price: wad(100), size: wad(1), takerIsBuy: true, maker: alice.address, taker: bob.address });
    expect(h.engine.getTrades(1, 10)).toEqual(trades);
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "filled", pending: 0n, filled: wad(1) });
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "partially_filled", pending: 0n, filled: wad(1) });
    expect(h.engine.getOpenOrders(bob.address)).toEqual([]);
    expect(h.engine.getMarkets()[0]).toMatchObject({ lastPrice: wad(100), bestAsk: wad(100), bestBid: null });
  });

  it("settles the fills of one taker in one batch, in match order, with signatures attached", async () => {
    const h = harness();
    const m1 = await h.place(alice, false, 100, 1);
    const m2 = await h.place(carol, false, 101, 1);
    const t = await h.place(bob, true, 101, 2);
    await h.engine.idle();
    expect(h.settler.calls).toHaveLength(1);
    const matches = h.settler.calls[0]!.matches;
    expect(matches.map((m) => [m.makerHash, m.takerHash, m.price, m.fillSize])).toEqual([
      [m1.orderHash, t.orderHash, wad(100), wad(1)],
      [m2.orderHash, t.orderHash, wad(101), wad(1)],
    ]);
    expect(matches[0]!.maker.trader).toBe(alice.address);
    expect(matches[0]!.makerSig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(matches[0]!.takerSig).not.toBe(matches[0]!.makerSig);
  });

  it("splits large runs into batches of maxBatchSize, preserving order", async () => {
    const h = harness({ maxBatchSize: 2 });
    for (let i = 0; i < 5; i++) await h.place(alice, false, 100 + i, 1);
    await h.place(bob, true, 110, 5);
    await h.engine.idle();
    expect(h.settler.calls.map((b) => b.matches.length)).toEqual([2, 2, 1]);
    expect(h.settler.settled.map((m) => m.price)).toEqual([100, 101, 102, 103, 104].map(wad));
  });

  it("cancel: needs the trader's signed Cancel, removes the order, is idempotent", async () => {
    const h = harness();
    const order = makeOrder(alice, false, 100, 2);
    const r = await h.engine.submit({ order, signature: await signOrder(alice, order) });
    expect(await code(h.engine.cancel(r.orderHash, await signCancel(bob, alice.address, order.nonce)))).toBe("BAD_SIGNATURE");
    expect(await code(h.engine.cancel(r.orderHash, await signCancel(alice, alice.address, order.nonce + 1n)))).toBe("BAD_SIGNATURE");
    expect(await code(h.engine.cancel(`0x${"00".repeat(32)}`, await signCancel(alice, alice.address, order.nonce)))).toBe("NOT_FOUND");
    expect(h.engine.getOrderBook(1, 10).asks).toHaveLength(1);

    const sig = await signCancel(alice, alice.address, order.nonce);
    expect(await h.engine.cancel(r.orderHash, sig)).toMatchObject({ status: "cancelled", remaining: 0n });
    expect(await h.engine.cancel(r.orderHash, sig)).toMatchObject({ status: "cancelled" });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([]);
    expect((await h.place(bob, true, 100, 1)).fills).toEqual([]);
  });

  it("cancel of a partially filled order keeps the fills already handed to settlement", async () => {
    const h = harness();
    const order = makeOrder(alice, false, 100, 2);
    const r = await h.engine.submit({ order, signature: await signOrder(alice, order) });
    await h.place(bob, true, 100, 1);
    await h.engine.cancel(r.orderHash, await signCancel(alice, alice.address, order.nonce));
    await h.engine.idle();
    expect(h.engine.getOrder(r.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n, filled: wad(1) });
    expect(h.settler.filled.get(r.orderHash)).toBe(wad(1));
  });

  it("an on-chain cancel (cancelNonce) removes the order and blocks the nonce", async () => {
    const h = harness();
    const order = makeOrder(alice, false, 100, 2);
    const r = await h.engine.submit({ order, signature: await signOrder(alice, order) });
    h.engine.cancelNonce(alice.address, order.nonce, "cancelled on-chain");
    expect(h.engine.getOrder(r.orderHash)).toMatchObject({ status: "cancelled", reason: "cancelled on-chain" });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([]);
  });
});

describe("on-chain failure reconciliation", () => {
  it("maker at fault: maker is removed for good, the innocent taker gets its size back and trades on", async () => {
    const h = harness({ withChain: true });
    const bad = await h.place(alice, false, 100, 1);
    const good = await h.place(carol, false, 101, 1);
    // alice loses her margin after her order was accepted
    h.chain.free.set(alice.address.toLowerCase(), 0n);
    h.settler.failWhen = (m) => (m.makerHash === bad.orderHash ? REASON : null);

    const taker = await h.place(bob, true, 101, 1);
    expect(taker.fills.map((f) => f.makerOrderHash)).toEqual([bad.orderHash]);
    await h.engine.idle();

    expect(h.engine.getOrder(bad.orderHash)).toMatchObject({ status: "rejected", remaining: 0n, pending: 0n, filled: 0n });
    expect(h.engine.getOrder(bad.orderHash)!.reason).toMatch(/insufficient margin/);
    // bob's order went back in with its size and then matched the next maker
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "filled", filled: wad(1), pending: 0n });
    expect(h.engine.getOrder(good.orderHash)).toMatchObject({ status: "filled", filled: wad(1) });
    expect(h.settler.settled.map((m) => [m.makerHash, m.takerHash, m.price])).toEqual([[good.orderHash, taker.orderHash, wad(101)]]);
    expect(h.engine.getTrades(1, 10)).toHaveLength(1);
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
    expect(h.engine.settlementStatus()).toMatchObject({ settled: 1, failed: 1, queued: 0, stalled: false });
  });

  it("maker at fault with no other liquidity: the innocent taker rests in the book", async () => {
    const h = harness({ withChain: true });
    const bad = await h.place(alice, false, 100, 1);
    h.chain.cancelled.add(`${alice.address.toLowerCase()}:${h.engine.getOrder(bad.orderHash)!.order.nonce}`);
    h.settler.failWhen = () => REASON;
    const taker = await h.place(bob, true, 101, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(bad.orderHash)!.reason).toMatch(/cancelled on-chain/);
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "open", remaining: wad(1), pending: 0n, filled: 0n });
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [{ price: wad(101), size: wad(1) }], asks: [] });
    expect(h.settler.calls).toHaveLength(1); // nothing is retried
  });

  it("taker at fault: taker is removed, the maker's liquidity returns with its time priority", async () => {
    const h = harness({ withChain: true });
    const first = await h.place(alice, false, 100, 1);
    const second = await h.place(carol, false, 100, 1);
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n); // enough for intake (20) ...
    const badTaker = makeOrder(bob, true, 100, 1);
    const signature = await signOrder(bob, badTaker);
    h.settler.beforeSettle = () => void h.chain.free.set(bob.address.toLowerCase(), 0n); // ... gone by settlement
    h.settler.failWhen = (m) => (m.taker.trader === bob.address ? REASON : null);
    const t = await h.engine.submit({ order: badTaker, signature });
    await h.engine.idle();

    expect(h.engine.getOrder(t.orderHash)).toMatchObject({ status: "rejected", remaining: 0n, pending: 0n, filled: 0n });
    expect(h.engine.getOrder(first.orderHash)).toMatchObject({ status: "open", remaining: wad(1), pending: 0n });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([{ price: wad(100), size: wad(2) }]);
    expect(h.engine.getTrades(1, 10)).toEqual([]);
    // priority kept: the restored maker is hit before the one that arrived after it
    const next = await h.place(carol, true, 100, 1).catch(() => null);
    expect(next).not.toBeNull();
    expect(next!.fills.map((f) => f.makerOrderHash)).toEqual([first.orderHash]);
    expect(h.engine.getOrder(second.orderHash)!.status).toBe("open");
  });

  it("partially filled maker: only the failed part comes back", async () => {
    const h = harness({ withChain: true });
    const maker = await h.place(alice, false, 100, 3);
    const okTaker = await h.place(carol, true, 100, 1);
    await h.engine.idle();
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n);
    h.settler.beforeSettle = () => void h.chain.free.set(bob.address.toLowerCase(), 0n);
    h.settler.failWhen = (m) => (m.taker.trader === bob.address ? REASON : null);
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(okTaker.orderHash)!.status).toBe("filled");
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "partially_filled", remaining: wad(2), pending: 0n, filled: wad(1) });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([{ price: wad(100), size: wad(2) }]);
  });

  it("restored liquidity that crosses orders which arrived meanwhile is matched, older order as maker", async () => {
    const h = harness({ withChain: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.settler.beforeSettle = (_b, attempt) => (h.settler.calls.length === 1 && attempt === 1 ? gate : undefined);
    h.settler.failWhen = (m) => (m.taker.trader === bob.address ? REASON : null);

    const ask = await h.place(alice, false, 100, 1);
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n);
    const doomed = await h.place(bob, true, 100, 1); // consumes the ask; will fail on-chain
    const lateBid = await h.place(carol, true, 102, 1); // rests: the ask is gone for now
    expect(lateBid.fills).toEqual([]);
    h.chain.free.set(bob.address.toLowerCase(), 0n);
    release();
    await h.engine.idle();

    expect(h.engine.getOrder(doomed.orderHash)!.status).toBe("rejected");
    expect(h.settler.settled.map((m) => [m.makerHash, m.takerHash, m.price])).toEqual([[ask.orderHash, lateBid.orderHash, wad(100)]]);
    expect(h.engine.getOrder(ask.orderHash)!.status).toBe("filled");
    expect(h.engine.getOrder(lateBid.orderHash)!.status).toBe("filled");
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
  });

  it("unattributable failure: taker is dropped, maker is restored, and is removed after repeated failures", async () => {
    const h = harness({ withChain: true, maxOrderStrikes: 3 });
    const maker = await h.place(alice, false, 100, 1);
    h.settler.failWhen = () => REASON; // e.g. exchange paused: nobody is at fault

    for (let i = 1; i <= 3; i++) {
      const taker = await h.place(i % 2 ? bob : carol, true, 100, 1);
      await h.engine.idle();
      expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "rejected", remaining: 0n, pending: 0n });
      if (i < 3) {
        expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(1), pending: 0n });
      }
    }
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "rejected", remaining: 0n, pending: 0n });
    expect(h.engine.getOrder(maker.orderHash)!.reason).toMatch(/repeatedly/);
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
    expect(h.settler.calls).toHaveLength(3); // bounded: nothing keeps retrying
    expect(h.settler.settled).toEqual([]);
  });

  it("a successful fill resets a maker's strikes", async () => {
    const h = harness({ withChain: true, maxOrderStrikes: 2 });
    const maker = await h.place(alice, false, 100, 5);
    h.settler.failWhen = () => REASON;
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    h.settler.failWhen = () => null;
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    h.settler.failWhen = () => REASON;
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "partially_filled", remaining: wad(4), filled: wad(1) });
  });

  it("without a chain reader every failure is unattributable (taker dropped, maker restored)", async () => {
    const h = harness();
    const maker = await h.place(alice, false, 100, 1);
    h.settler.failWhen = () => REASON;
    const taker = await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(taker.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(1) });
  });

  it("revert data naming a trader decides the fault exactly, even against the view-based estimate", async () => {
    const h = harness({ withChain: true }); // chain views say everybody is healthy
    const maker = await h.place(alice, false, 100, 1);
    const blame = (trader: `0x${string}`) =>
      encodeErrorResult({ abi: parseAbi(["error InsufficientMargin(address trader)"]), args: [trader] });
    h.settler.failWhen = () => blame(bob.address);
    const taker = await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/insufficient margin/) });
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(1) });

    h.settler.failWhen = () => blame(alice.address);
    const taker2 = await h.place(carol, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(taker2.orderHash)).toMatchObject({ status: "open", remaining: wad(1) });
  });

  it("both sides at fault: both removed", async () => {
    const h = harness({ withChain: true });
    const maker = await h.place(alice, false, 100, 1);
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n);
    const taker = makeOrder(bob, true, 100, 1);
    const signature = await signOrder(bob, taker);
    h.settler.beforeSettle = () => {
      h.chain.free.set(bob.address.toLowerCase(), 0n);
      h.chain.free.set(alice.address.toLowerCase(), 0n);
    };
    h.settler.failWhen = () => REASON;
    const t = await h.engine.submit({ order: taker, signature });
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(t.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
  });

  it("an innocent IOC taker is not re-posted", async () => {
    const h = harness({ withChain: true });
    const bad = await h.place(alice, false, 100, 1);
    h.chain.free.set(alice.address.toLowerCase(), 0n);
    h.settler.failWhen = () => REASON;
    const taker = await h.place(bob, true, 100, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(bad.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n, pending: 0n, filled: 0n });
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
  });

  it("an innocent maker that was cancelled while its match was in flight stays cancelled", async () => {
    const h = harness({ withChain: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.settler.beforeSettle = () => gate;
    h.settler.failWhen = () => REASON;
    const makerOrder = makeOrder(alice, false, 100, 1);
    const maker = await h.engine.submit({ order: makerOrder, signature: await signOrder(alice, makerOrder) });
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n);
    await h.place(bob, true, 100, 1);
    h.chain.free.set(bob.address.toLowerCase(), 0n);
    // fully matched, awaiting settlement; the trader cancels now
    expect(await h.engine.cancel(maker.orderHash, await signCancel(alice, alice.address, makerOrder.nonce))).toMatchObject({ status: "pending_settlement" });
    release();
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n, pending: 0n });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([]);
  });

  it("an innocent maker that expired meanwhile is not restored", async () => {
    const h = harness({ withChain: true, expiryBufferSec: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.settler.beforeSettle = () => gate;
    h.settler.failWhen = () => REASON;
    const maker = await h.place(alice, false, 100, 1, { order: { expiry: 1100n } });
    h.chain.free.set(bob.address.toLowerCase(), 30_000_000n);
    await h.place(bob, true, 100, 1);
    h.chain.free.set(bob.address.toLowerCase(), 0n);
    h.clock.now = 1200;
    release();
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "expired", remaining: 0n });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([]);
  });

  it("classifies with definitive chain facts: on-chain fill level and expiry", async () => {
    const h = harness({ withChain: true });
    const maker = await h.place(alice, false, 100, 1);
    h.settler.failWhen = () => REASON;
    h.chain.filled.set(maker.orderHash, wad(1)); // chain says the maker is already full
    const taker = await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)!.reason).toMatch(/already filled on-chain/);
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "open", remaining: wad(1) });

    const expiring = await h.place(carol, false, 101, 1, { order: { expiry: 5000n } });
    h.chain.time = 5000n; // chain clock is ahead of the engine's
    await h.place(alice, true, 101, 1, { order: { nonce: 999_999n } });
    await h.engine.idle();
    expect(h.engine.getOrder(expiring.orderHash)!.reason).toMatch(/expired on-chain/);
  });
});

describe("submission failures", () => {
  it("unknown outcome: the same batch is retried under the same id and settles exactly once", async () => {
    const h = harness();
    h.settler.beforeSettle = (_b, attempt) => {
      if (attempt <= 2) throw new Error("socket hang up");
    };
    const maker = await h.place(alice, false, 100, 1);
    const taker = await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.settler.calls.map((b) => b.id)).toEqual(["b1", "b1", "b1"]);
    expect(h.settler.settled).toHaveLength(1);
    expect(h.settler.filled.get(maker.orderHash)).toBe(wad(1));
    expect(h.engine.getTrades(1, 10)).toHaveLength(1);
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "filled", filled: wad(1), pending: 0n });
    expect(h.engine.settlementStatus()).toMatchObject({ stalled: false, lastError: null });
  });

  it("a batch that was applied but whose result was lost is not applied twice", async () => {
    const h = harness();
    // Wrap the fake: the first call settles on the "chain" but the response is lost.
    const inner = h.settler.settle.bind(h.settler);
    let lost = false;
    h.settler.settle = async (batch) => {
      const res = await inner(batch);
      if (!lost) {
        lost = true;
        throw new Error("timeout waiting for receipt");
      }
      return res;
    };
    const maker = await h.place(alice, false, 100, 1);
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.settler.calls).toHaveLength(2);
    expect(h.settler.settled).toHaveLength(1);
    expect(h.settler.filled.get(maker.orderHash)).toBe(wad(1));
    expect(h.engine.getTrades(1, 10)).toHaveLength(1);
  });

  it("while the outcome is unknown nothing else is submitted and new orders are refused", async () => {
    const h = harness({ retryDelayMs: 20 });
    let failing = true;
    h.settler.beforeSettle = () => {
      if (failing) throw new Error("rpc down");
    };
    await h.place(alice, false, 100, 2);
    await h.place(bob, true, 100, 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.engine.settlementStatus()).toMatchObject({ stalled: true, inFlight: 1, lastError: "rpc down" });
    expect(await code(h.place(carol, true, 100, 1))).toBe("CHAIN_UNAVAILABLE");
    failing = false;
    await h.engine.idle();
    expect(h.engine.settlementStatus().stalled).toBe(false);
    expect(new Set(h.settler.calls.map((b) => b.id))).toEqual(new Set(["b1"]));
    expect(await code(h.place(carol, true, 100, 1))).toBe("OK");
  });

  it("a reverted batch is retried, then its matches are failed as unattributable", async () => {
    const h = harness({ maxBatchReverts: 3 });
    h.settler.beforeSettle = () => {
      throw new BatchRevertedError("settleMatches would revert: not operator");
    };
    const maker = await h.place(alice, false, 100, 1);
    const taker = await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.settler.calls).toHaveLength(3);
    expect(h.settler.settled).toEqual([]);
    expect(h.engine.getOrder(taker.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(1), pending: 0n });
    expect(h.engine.getTrades(1, 10)).toEqual([]);
  });

  it("a reverted batch that goes through on retry settles once", async () => {
    const h = harness();
    h.settler.beforeSettle = (_b, attempt) => {
      if (attempt === 1) throw new BatchRevertedError("out of gas");
    };
    await h.place(alice, false, 100, 1);
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.settler.calls).toHaveLength(2);
    expect(h.settler.settled).toHaveLength(1);
  });

  it("conserves size for every order through a mix of successes and failures", async () => {
    const h = harness({ withChain: true, maxBatchSize: 3 });
    let i = 0;
    h.settler.failWhen = () => (++i % 3 === 0 ? REASON : null);
    const traders = [alice, bob, carol];
    const hashes: `0x${string}`[] = [];
    for (let k = 0; k < 60; k++) {
      const t = traders[k % 3]!;
      const r = await h.place(t, k % 2 === 0, 100 + ((k * 7) % 5) - 2, 1 + (k % 3)).catch(() => null);
      if (r) hashes.push(r.orderHash);
    }
    await h.engine.idle();
    for (const hash of hashes) {
      const v = h.engine.getOrder(hash)!;
      expect(v.pending).toBe(0n);
      expect(v.filled).toBe(h.settler.filled.get(hash) ?? 0n);
      expect(v.filled + v.remaining).toBeLessThanOrEqual(v.order.size);
      if (v.status === "open" || v.status === "partially_filled") expect(v.filled + v.remaining).toBe(v.order.size);
    }
    expect(h.engine.settlementStatus().failed).toBeGreaterThan(3);
    expect(h.engine.settlementStatus().settled).toBeGreaterThan(3);
    expect(h.settler.calls.length).toBe(new Set(h.settler.calls.map((b) => b.id)).size); // no retries
    const book = h.engine.getOrderBook(1, 100);
    if (book.bids[0] && book.asks[0]) expect(book.bids[0].price < book.asks[0].price).toBe(true);
    for (const m of h.settler.settled) expect(m.maker.trader).not.toBe(m.taker.trader);
  });
});
