// Regression tests for the findings of the independent review (R1-R7 and follow-ups).
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { accountFromKey, privateKey } from "../src/config.ts";
import { FileDeadNonceStore, MemoryDeadNonceStore } from "../src/engine/deadNonces.ts";
import { Engine, EngineError } from "../src/engine/engine.ts";
import { FakeSettler } from "../src/settlement/fakeSettler.ts";
import { hashOrder } from "../src/signing.ts";
import { alice, bob, carol, DEFAULT_EXPIRY, DOMAIN, FakeChain, harness, makeOrder, MARKET, signCancel, signOrder, wad } from "./helpers.ts";

const ERR = parseAbi([
  "error InsufficientMargin(address trader)",
  "error OrderExpired()",
  "error OnlyReducingAllowed()",
  "error PriceOutOfBand(uint256 price, uint256 index)",
  "error StalePrice(uint32 marketId)",
  "error OpenInterestCapExceeded()",
]);
const blame = (trader: `0x${string}`) => encodeErrorResult({ abi: ERR, errorName: "InsufficientMargin", args: [trader] });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "OK";
};
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "baldwin-dead-")), "dead.jsonl");

describe("1: dead nonces survive a restart", () => {
  it("R1: an order cancelled off-chain cannot be re-posted from public calldata after a restart", async () => {
    const path = tmpFile();
    const chain = new FakeChain(); // on-chain state survives; the off-chain cancel is not on it
    const settler1 = new FakeSettler();
    const store1 = new FileDeadNonceStore(path, 1000n);
    const e1 = new Engine({ domain: DOMAIN, markets: [MARKET], settler: settler1, chain, deadNonces: store1, now: () => 1000 });
    const aOrder = makeOrder(alice, true, 100, 10);
    await e1.submit({ order: aOrder, signature: await signOrder(alice, aOrder) });
    const bOrder = makeOrder(bob, false, 100, 1);
    await e1.submit({ order: bOrder, signature: await signOrder(bob, bOrder) });
    await e1.idle();
    const aHash = hashOrder(DOMAIN, aOrder);
    chain.filled.set(aHash, wad(1));
    const publicCalldata = settler1.calls[0]!.matches[0]!;
    expect((await e1.cancel(aHash, await signCancel(alice, alice.address, aOrder.nonce))).status).toBe("cancelled");
    // durable at the moment the cancel is acknowledged
    expect(readFileSync(path, "utf8")).toContain(`"n":"${aOrder.nonce}"`);
    await e1.stop();
    store1.close();

    const e2 = new Engine({ domain: DOMAIN, markets: [MARKET], settler: new FakeSettler(), chain, deadNonces: new FileDeadNonceStore(path, 2000n), now: () => 2000 });
    expect(await code(e2.submit({ order: publicCalldata.maker, signature: publicCalldata.makerSig }))).toBe("NONCE_CANCELLED");
    expect(e2.getOrderBook(1, 10).bids).toEqual([]);
  });

  it("R1b: an IOC order's unfilled remainder cannot be re-posted as a resting order after a restart", async () => {
    const dead = new MemoryDeadNonceStore(); // stands for the persisted set
    const chain = new FakeChain();
    const settler1 = new FakeSettler();
    const e1 = new Engine({ domain: DOMAIN, markets: [MARKET], settler: settler1, chain, deadNonces: dead, now: () => 1000 });
    const mk = makeOrder(bob, false, 100, 1);
    await e1.submit({ order: mk, signature: await signOrder(bob, mk) });
    const ioc = makeOrder(alice, true, 100, 10);
    expect((await e1.submit({ order: ioc, signature: await signOrder(alice, ioc), ioc: true })).status).toBe("cancelled");
    await e1.idle();
    chain.filled.set(hashOrder(DOMAIN, ioc), wad(1));
    const pub = settler1.calls[0]!.matches[0]!;
    const e2 = new Engine({ domain: DOMAIN, markets: [MARKET], settler: new FakeSettler(), chain, deadNonces: dead, now: () => 2000 });
    expect(await code(e2.submit({ order: pub.taker, signature: pub.takerSig }))).toBe("NONCE_CANCELLED");
    expect(e2.getOrderBook(1, 10).bids).toEqual([]);
  });

  it("an IOC order is dead from the moment it is accepted, even if it matched fully", async () => {
    const dead = new MemoryDeadNonceStore();
    const h = harness({ deadNonces: dead });
    await h.place(alice, false, 100, 1);
    const ioc = makeOrder(bob, true, 100, 1);
    await h.engine.submit({ order: ioc, signature: await signOrder(bob, ioc), ioc: true });
    expect(dead.has(bob.address, ioc.nonce)).toBe(true);
  });

  it("orders rejected after an on-chain failure, and self-trade / band remainders, are dead too", async () => {
    const dead = new MemoryDeadNonceStore();
    const h = harness({ deadNonces: dead, withChain: true });
    const maker = makeOrder(alice, false, 100, 1);
    await h.engine.submit({ order: maker, signature: await signOrder(alice, maker) });
    h.settler.failWhen = () => blame(alice.address);
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(dead.has(alice.address, maker.nonce)).toBe(true);
    const offMarket = makeOrder(carol, true, 150, 1); // above the band: remainder cancelled
    expect((await h.engine.submit({ order: offMarket, signature: await signOrder(carol, offMarket) })).status).toBe("cancelled");
    expect(dead.has(carol.address, offMarket.nonce)).toBe(true);
  });

  it("the file store drops expired entries on load, tolerates a torn last line, and keeps live ones", () => {
    const path = tmpFile();
    const s1 = new FileDeadNonceStore(path, 1000n);
    s1.add(alice.address, 1n, 1500n);
    s1.add(alice.address, 2n, 5000n);
    s1.add(bob.address, 1n, 5000n);
    s1.close();
    appendFileSync(path, '{"t":"0xabc","n":"9"'); // crash in the middle of a write
    const s2 = new FileDeadNonceStore(path, 2000n);
    expect(s2.has(alice.address, 1n)).toBe(false); // expired: the order is dead on-chain anyway
    expect(s2.has(alice.address, 2n)).toBe(true);
    expect(s2.has(bob.address, 1n)).toBe(true);
    expect(s2.has(bob.address, 2n)).toBe(false);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2); // compacted
    s2.prune(5000n);
    expect(s2.size).toBe(0);
    s2.close();
  });

  it("a cancel that cannot be made durable is not acknowledged and changes nothing", async () => {
    const dead = new MemoryDeadNonceStore();
    const h = harness({ deadNonces: dead });
    const order = makeOrder(alice, true, 100, 1);
    const r = await h.engine.submit({ order, signature: await signOrder(alice, order) });
    dead.add = () => {
      throw new Error("ENOSPC");
    };
    await expect(h.engine.cancel(r.orderHash, await signCancel(alice, alice.address, order.nonce))).rejects.toThrow("ENOSPC");
    expect(h.engine.getOrder(r.orderHash)!.status).toBe("open");
  });

  it("orders must expire: no expiry, too far out, or too soon are refused", async () => {
    const h = harness({ minTimeToExpirySec: 60, expiryBufferSec: 30, maxTimeToExpirySec: 7 * 86400 });
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 0n } }))).toBe("INVALID_EXPIRY");
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 1000n + 7n * 86400n + 1n } }))).toBe("INVALID_EXPIRY");
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 1000n + 7n * 86400n } }))).toBe("OK");
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 1060n } }))).toBe("EXPIRED");
    expect(await code(h.place(alice, true, 100, 1, { order: { expiry: 1061n } }))).toBe("OK");
  });
});

describe("2: off-market and unfunded makers cannot hurt takers", () => {
  it("R3: a bid far above the index never rests, so it cannot stand in front of real liquidity", async () => {
    const h = harness({ withChain: true });
    await h.place(alice, true, 99, 1);
    h.chain.free.set(carol.address.toLowerCase(), 1_000_000_000n);
    const atk = await h.place(carol, true, 200, 1); // index 100, band [95, 105]
    expect(atk).toMatchObject({ status: "cancelled", remaining: 0n, fills: [] });
    expect(atk.reason).toMatch(/price band/);
    const bobRes = await h.place(bob, false, 99, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(bobRes.orderHash)).toMatchObject({ status: "filled", filled: wad(1) });
    expect(h.settler.settled).toHaveLength(1);
  });

  it("R3: the same attacker with exactly the index-notional margin fails the pre-trade check even inside the band", async () => {
    const h = harness({ withChain: true });
    h.chain.free.set(carol.address.toLowerCase(), 20_000_000n); // IM of 1 @ index, nothing for fees or the premium
    expect(await code(h.place(carol, true, 105, 1))).toBe("INSUFFICIENT_MARGIN");
  });

  it("a taker crossing the band trades only inside it and never pays more than the band allows", async () => {
    const h = harness({ withChain: true });
    await h.place(alice, false, 104, 1);
    await h.place(alice, false, 110, 1); // rests beyond the far side, not matchable now
    const r = await h.place(bob, true, 500, 2);
    expect(r.fills.map((f) => f.price)).toEqual([wad(104)]);
    expect(r).toMatchObject({ status: "cancelled", remaining: 0n });
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [{ price: wad(110), size: wad(1) }] });
  });

  it("when the index moves, resting orders now on the wrong side of the band are cancelled", async () => {
    const h = harness({ withChain: true });
    const bid = await h.place(alice, true, 100, 1);
    const lowBid = await h.place(alice, true, 96, 1);
    const ask = await h.place(bob, false, 101, 1);
    h.chain.index = wad(90); // band [85.5, 94.5]
    await h.engine.refreshChainState();
    expect(h.engine.getOrder(bid.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n });
    expect(h.engine.getOrder(lowBid.orderHash)!.status).toBe("cancelled");
    expect(h.engine.getOrder(ask.orderHash)!.status).toBe("open"); // above the band: harmless, stays
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([]);
    expect(h.engine.chainStatus()).toMatchObject({ paused: false, markets: [{ marketId: 1, indexPrice: wad(90), band: { lo: wad("85.5"), hi: wad("94.5") } }] });
  });

  it("2c: an innocent IOC taker whose maker failed is matched again against the rest of the book", async () => {
    const h = harness({ withChain: true });
    const bad = await h.place(alice, true, 100, 1);
    const good = await h.place(carol, true, 99, 1);
    h.settler.failWhen = (m) => (m.maker.trader === alice.address ? blame(alice.address) : null);
    const taker = await h.place(bob, false, 99, 1, { ioc: true });
    expect(taker.fills.map((f) => f.makerOrderHash)).toEqual([bad.orderHash]);
    await h.engine.idle();
    expect(h.engine.getOrder(bad.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "filled", filled: wad(1), pending: 0n });
    expect(h.settler.settled.map((m) => [m.makerHash, m.price])).toEqual([[good.orderHash, wad(99)]]);
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
  });

  it("2c: with nothing left to match, the IOC taker is closed and never rests", async () => {
    const h = harness({ withChain: true });
    await h.place(alice, true, 100, 1);
    h.settler.failWhen = () => blame(alice.address);
    const taker = await h.place(bob, false, 99, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n, pending: 0n, filled: 0n });
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
  });

  it("2d: a trader whose orders keep failing on-chain is refused for a while", async () => {
    const h = harness({ withChain: true, faultThreshold: 2, faultWindowSec: 600 });
    h.settler.failWhen = (m) => (m.maker.trader === carol.address ? blame(carol.address) : null);
    for (let i = 0; i < 2; i++) {
      expect(await code(h.place(carol, true, 100, 1))).toBe("OK");
      await h.place(bob, false, 100, 1, { ioc: true });
      await h.engine.idle();
    }
    const e = await h.place(carol, true, 100, 1).catch((x) => x);
    expect(e).toMatchObject({ code: "TRADER_SUSPENDED", httpStatus: 429 });
    expect(await code(h.place(alice, true, 100, 1))).toBe("OK"); // others are unaffected
    h.clock.now += 601;
    h.chain.time += 601n;
    expect(await code(h.place(carol, true, 100, 1, { order: { expiry: DEFAULT_EXPIRY + 1000n } }))).toBe("OK");
  });
});

describe("3: definitive causes decide the fault", () => {
  it("R4: a taker that expires on-chain is at fault; the maker is innocent and keeps its place", async () => {
    const h = harness({ withChain: true, expiryBufferSec: 5 });
    h.chain.free.set(alice.address.toLowerCase(), 100_000_000n); // would fail the margin heuristic after fees
    const a = await h.place(alice, true, 99, 4);
    h.settler.failWhen = () => encodeErrorResult({ abi: ERR, errorName: "OrderExpired" });
    h.settler.beforeSettle = () => {
      h.chain.time = 1007n;
      h.chain.free.set(alice.address.toLowerCase(), 0n); // even if the heuristic would now blame the maker
    };
    const c = await h.place(carol, false, 99, 4, { ioc: true, order: { expiry: 1006n } });
    expect(c.fills).toHaveLength(1);
    await h.engine.idle();
    expect(h.engine.getOrder(c.orderHash)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/expired on-chain/) });
    expect(h.engine.getOrder(a.orderHash)).toMatchObject({ status: "open", remaining: wad(4) });
    expect(h.engine.getOrderBook(1, 5).bids).toEqual([{ price: wad(99), size: wad(4) }]);
  });

  it("by default an order must have a minute to live at intake and resting orders leave 30 s before expiry", async () => {
    const settler = new FakeSettler();
    let now = 1000;
    const engine = new Engine({ domain: DOMAIN, markets: [MARKET], settler, now: () => now });
    const short = makeOrder(carol, false, 99, 1, { expiry: 1060n });
    expect(await code(engine.submit({ order: short, signature: await signOrder(carol, short) }))).toBe("EXPIRED");
    const ok = makeOrder(carol, false, 99, 1, { expiry: 1061n });
    const r = await engine.submit({ order: ok, signature: await signOrder(carol, ok) });
    now = 1031;
    engine.sweepExpired();
    expect(engine.getOrder(r.orderHash)!.status).toBe("expired");
  });
});

describe("4: post-only never takes", () => {
  it("R2: a resting post-only order is cancelled rather than executed as taker when an older order is restored", async () => {
    const h = harness();
    const ask = await h.place(alice, false, 100, 1);
    h.settler.failWhen = (m) => (m.taker.trader === carol.address ? blame(carol.address) : null);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.settler.beforeSettle = async (b) => {
      if (b.id === "b1") await gate;
    };
    await h.place(carol, true, 100, 1);
    const bobRes = await h.place(bob, true, 101, 1, { postOnly: true });
    expect(bobRes.status).toBe("open");
    release();
    await h.engine.idle();
    expect(h.settler.settled).toEqual([]);
    expect(h.engine.getOrder(bobRes.orderHash)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(/post-only/) });
    expect(h.engine.getOrder(ask.orderHash)).toMatchObject({ status: "open", remaining: wad(1) });
  });
});

describe("7: global conditions", () => {
  it("R5: failures caused by a pause cost makers no strike; the engine then stops taking position-increasing orders", async () => {
    const h = harness({ withChain: true, maxOrderStrikes: 1 });
    const a = await h.place(alice, true, 100, 10);
    h.chain.isPaused = true; // paused on-chain; the engine has not noticed yet
    h.settler.failWhen = () => encodeErrorResult({ abi: ERR, errorName: "OnlyReducingAllowed" });
    const t = await h.place(carol, false, 100, "0.01", { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(t.orderHash)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(/paused/) });
    expect(h.engine.getOrder(a.orderHash)).toMatchObject({ status: "open", remaining: wad(10) });
    // the failure made the engine re-read the chain: it now knows about the pause
    expect(h.engine.chainStatus()!.paused).toBe(true);
    const e = await h.place(bob, false, 100, "0.01", { ioc: true }).catch((x) => x);
    expect(e).toMatchObject({ code: "EXCHANGE_PAUSED", httpStatus: 503 });
    expect(h.settler.calls).toHaveLength(1);
  });

  it("while paused, reduce-only orders trade with reduce-only makers only", async () => {
    const h = harness({ withChain: true });
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, wad(-5));
    h.chain.positions.set(`${bob.address.toLowerCase()}:1`, wad(5));
    const normalBid = await h.place(carol, true, 100, 1);
    const roBid = await h.place(alice, true, 99, 1, { order: { reduceOnly: true } });
    h.chain.isPaused = true;
    await h.engine.refreshChainState();
    // Best bid is not reduce-only: matching stops there, the remainder is cancelled.
    const blocked = await h.place(bob, false, 99, 1, { order: { reduceOnly: true } });
    expect(blocked).toMatchObject({ status: "cancelled", fills: [] });
    await h.engine.cancel(normalBid.orderHash, await signCancel(carol, carol.address, h.engine.getOrder(normalBid.orderHash)!.order.nonce));
    const ok = await h.place(bob, false, 99, 1, { order: { reduceOnly: true } });
    expect(ok.fills.map((f) => f.makerOrderHash)).toEqual([roBid.orderHash]);
  });

  it.each([
    ["stale oracle", () => encodeErrorResult({ abi: ERR, errorName: "StalePrice", args: [1] })],
    ["price band", () => encodeErrorResult({ abi: ERR, errorName: "PriceOutOfBand", args: [1n, 2n] })],
    ["open-interest cap", () => encodeErrorResult({ abi: ERR, errorName: "OpenInterestCapExceeded" })],
  ])("%s failures: no strikes however often they happen, taker cancelled, maker restored", async (_name, reason) => {
    const h = harness({ withChain: true, maxOrderStrikes: 2 });
    const a = await h.place(alice, true, 100, 10);
    h.settler.failWhen = reason;
    for (let i = 0; i < 4; i++) {
      const t = await h.place(i % 2 ? bob : carol, false, 100, 1, { ioc: true });
      await h.engine.idle();
      expect(h.engine.getOrder(t.orderHash)!.status).toBe("cancelled");
    }
    expect(h.engine.getOrder(a.orderHash)).toMatchObject({ status: "open", remaining: wad(10), pending: 0n });
    // nobody was at fault: nobody is suspended
    expect(await code(h.place(carol, false, 104, 1))).toBe("OK");
  });

  it("unknown revert data: global conditions are recognised from views (pause, unreadable index, OI cap)", async () => {
    for (const setup of [
      (c: FakeChain) => void (c.isPaused = true),
      (c: FakeChain) => void (c.indexFails = true),
      (c: FakeChain) => void (c.oi = { longs: MARKET.maxOpenInterest, shorts: MARKET.maxOpenInterest }),
    ]) {
      const h = harness({ withChain: true, maxOrderStrikes: 1 });
      const a = await h.place(alice, true, 100, 10);
      h.settler.failWhen = () => "0x5863f789";
      h.settler.beforeSettle = () => setup(h.chain);
      await h.place(carol, false, 100, 1, { ioc: true });
      await h.engine.idle();
      const view = h.engine.getOrder(a.orderHash)!;
      // paused / halted markets keep the maker; with the index gone its band is unchanged
      expect(view).toMatchObject({ status: "open", remaining: wad(10) });
    }
  });

  it("a market whose index cannot be read is halted for new orders; cancels still work", async () => {
    const h = harness({ withChain: true });
    const order = makeOrder(alice, true, 100, 1);
    const r = await h.engine.submit({ order, signature: await signOrder(alice, order) });
    h.chain.indexFails = true;
    await h.engine.refreshChainState();
    expect(await h.place(bob, false, 100, 1).catch((x) => x)).toMatchObject({ code: "MARKET_HALTED", httpStatus: 503 });
    expect((await h.engine.cancel(r.orderHash, await signCancel(alice, alice.address, order.nonce))).status).toBe("cancelled");
    h.chain.indexFails = false;
    await h.engine.refreshChainState();
    expect(await code(h.place(bob, false, 100, 1))).toBe("OK");
  });
});

describe("11: minor", () => {
  it("R6: a partly filled order whose remainder is below the minimum size is accepted again after a restart", async () => {
    const chain = new FakeChain();
    const e = new Engine({ domain: DOMAIN, markets: [MARKET], settler: new FakeSettler(), chain, now: () => 1000 });
    const o = makeOrder(alice, true, 100, "0.015");
    chain.filled.set(hashOrder(DOMAIN, o), wad("0.01"));
    const r = await e.submit({ order: o, signature: await signOrder(alice, o) });
    expect(r).toMatchObject({ status: "partially_filled", remaining: wad("0.005") });
    // and that dust is filled by a larger taker (the fill completes the maker's order)
    const t = makeOrder(bob, false, 100, 1);
    const tr = await e.submit({ order: t, signature: await signOrder(bob, t) });
    expect(tr.fills.map((f) => f.size)).toEqual([wad("0.005")]);
  });

  it("R7: a cancel that arrives while the order is still in its intake checks takes effect", async () => {
    const h = harness({ withChain: true });
    // immediately after submit(), before even the signature check has finished
    const o1 = makeOrder(alice, true, 100, 1);
    const p1 = h.engine.submit({ order: o1, signature: await signOrder(alice, o1) }).catch((e) => e);
    const c1 = await h.engine.cancel(hashOrder(DOMAIN, o1), await signCancel(alice, alice.address, o1.nonce));
    expect(c1).toMatchObject({ status: "cancelled", remaining: 0n });
    expect(await p1).toMatchObject({ code: "NONCE_CANCELLED" });

    // in the middle of a slow pre-trade check
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const free = h.chain.freeCollateral.bind(h.chain);
    h.chain.freeCollateral = async (t) => (await gate, free(t));
    const o2 = makeOrder(alice, true, 100, 1);
    const p2 = h.engine.submit({ order: o2, signature: await signOrder(alice, o2) }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    await h.engine.cancel(hashOrder(DOMAIN, o2), await signCancel(alice, alice.address, o2.nonce));
    release();
    expect(await p2).toMatchObject({ code: "NONCE_CANCELLED" });
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([]);
    // somebody else's Cancel signature does nothing
    const o3 = makeOrder(alice, true, 100, 1);
    const p3 = h.engine.submit({ order: o3, signature: await signOrder(alice, o3) });
    await expect(h.engine.cancel(hashOrder(DOMAIN, o3), await signCancel(bob, alice.address, o3.nonce))).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    expect((await p3).status).toBe("open");
  });

  it("market parameters are refreshed from the chain", async () => {
    const h = harness({ withChain: true, marketRefreshMs: 0 });
    expect(await code(h.place(alice, true, 100, "0.01"))).toBe("OK");
    h.chain.market = { ...MARKET, minOrderSize: wad(1), takerFeeBps: 50n };
    await h.engine.refreshChainState();
    expect(await code(h.place(alice, true, 100, "0.5"))).toBe("BELOW_MIN_SIZE");
    expect(h.engine.getMarkets()[0]).toMatchObject({ minOrderSize: wad(1), takerFeeBps: 50n, symbol: "BTC-USD" });
  });

  it("an invalid private key is never echoed in an error", () => {
    const secret = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbee"; // one nibble short
    for (const bad of [secret, "not-a-key-s3cr3t", `0x${"f".repeat(64)}`, `0x${"0".repeat(64)}`]) {
      let message = "";
      try {
        accountFromKey(privateKey({ K: bad }, "K"), "K");
      } catch (e) {
        message = String((e as Error).message) + String((e as Error).stack);
      }
      expect(message).toMatch(/K /);
      expect(message).not.toContain(bad);
      expect(message).not.toContain(bad.slice(2));
    }
  });
});
