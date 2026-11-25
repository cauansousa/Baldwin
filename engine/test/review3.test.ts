// Regression tests for the third independent review. Each case was demonstrated by the
// reviewer as a defect; here it asserts the fixed behaviour.
import { encodeErrorResult } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { exchangeAbi } from "../src/abi.ts";
import { EngineError, type Engine } from "../src/engine/engine.ts";
import { Unwinder, type EngineClient, type EngineReply } from "../src/keeper/unwinder.ts";
import { SqliteStore } from "../src/store/sqliteStore.ts";
import type { Hex, Order } from "../src/types.ts";
import { alice, bob, carol, DOMAIN, harness, makeOrder, MARKET, signCancel, signOrder, wad, type Harness, type TestAccount } from "./helpers.ts";

const keeperAcct = carol;
const KEY = `${keeperAcct.address.toLowerCase()}:1`;
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e instanceof EngineError ? e.code : `THROW ${e}`));
const err = (name: string, args: unknown[] = []) => encodeErrorResult({ abi: exchangeAbi, errorName: name as never, args: args as never });
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function inProcess(engine: Engine) {
  const calls = { submit: [] as Order[], cancel: [] as Hex[], replies: [] as string[] };
  const wrap = async <T>(fn: () => Promise<T>, record = false): Promise<EngineReply<T>> => {
    try {
      const body = await fn();
      if (record) calls.replies.push("ok");
      return { ok: true, body };
    } catch (e) {
      if (e instanceof EngineError) {
        if (record) calls.replies.push(`${e.code}:${e.outcome}`);
        return { ok: false, code: e.code, outcome: e.outcome, message: e.message };
      }
      throw e;
    }
  };
  const client: EngineClient = {
    minOrderSizes: () => wrap(async () => new Map(engine.getMarkets().map((m) => [m.marketId, m.minOrderSize]))),
    time: () => wrap(async () => engine.engineTime()),
    openOrders: (trader) =>
      wrap(async () => engine.getOpenOrders(trader).map((v) => ({ orderHash: v.orderHash, order: v.order, status: v.status, remaining: v.remaining, pending: v.pending, filled: v.filled }))),
    submit: (order, signature) => (calls.submit.push(order), wrap(() => engine.submit({ order, signature }), true)),
    cancel: (hash, signature, trader, nonce) => (calls.cancel.push(hash), wrap(() => engine.cancel(hash, signature, { trader, nonce }), true)),
  };
  return { client, calls };
}
function setup(h: Harness, opts: { offsetBps?: bigint } = {}) {
  const eng = inProcess(h.engine);
  const unwinder = new Unwinder({
    chain: { positionSize: async () => h.chain.positions.get(KEY) ?? 0n, indexPrice: () => h.chain.indexPrice() },
    engine: eng.client,
    account: keeperAcct,
    domain: DOMAIN,
    marketIds: [1],
    offsetBps: opts.offsetBps ?? 10n,
    repriceBps: 20n,
    expirySec: 300,
    renewBeforeSec: 120,
    now: () => h.clock.now,
  });
  const resting = () => h.engine.getOpenOrders(keeperAcct.address).filter((o) => o.remaining > 0n);
  return { h, unwinder, resting, ...eng };
}

describe("R3-1 / item 2: an order whose first submission had no definite answer is never forgotten", () => {
  it("STATE_UNKNOWN, then the store is still down: the keeper keeps the order and gets its real state when the engine can say", async () => {
    const store = new SqliteStore(":memory:");
    const h = harness({ withChain: true, store });
    const { unwinder, resting, calls } = setup(h);
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    const commit = store.commit.bind(store);
    store.commit = () => {
      throw new Error("disk full");
    };
    await unwinder.tick(); // place -> STATE_UNKNOWN
    expect(calls.replies).toEqual(["STATE_UNKNOWN:unknown"]);
    await unwinder.tick(); // the same order again: the engine knows it and answers with its state
    expect(calls.replies[1]).toBe("ok");
    expect(new Set(calls.submit.map((o) => o.nonce)).size).toBe(1);
    expect(unwinder.status()[0]!.order).toMatchObject({ state: "resting" }); // the keeper manages what the engine has
    store.commit = commit;
    h.engine.sweepExpired();
    expect(resting().map((o) => o.orderHash)).toEqual([unwinder.status()[0]!.order!.orderHash]);
    // and it is managed: an index move re-prices it, nothing stale can be hit
    h.chain.index = wad(103);
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting().map((o) => o.order.limitPrice)).toEqual([wad("102.897")]);
  });

  it("no answer at all, then a not_applied answer: the order is not declared gone until a cancel by nonce is confirmed", async () => {
    const h = harness({ withChain: true });
    const { unwinder, resting, client, calls } = setup(h);
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    const realSubmit = client.submit;
    // 1st attempt: the request reaches the engine after a delay (so it is not there yet), the client times out
    let late: (() => Promise<unknown>) | null = null;
    client.submit = async (o, s) => {
      late = () => realSubmit(o, s);
      return { ok: false, code: "NO_ANSWER", outcome: "unknown", message: "timeout" };
    };
    await unwinder.tick();
    // 2nd attempt: the engine is recovering and says "not applied" (it does not have the order - yet)
    client.submit = async () => ({ ok: false, code: "RECOVERING", outcome: "not_applied", message: "recovering" });
    await unwinder.tick();
    // the keeper cancelled by nonce (durable) instead of assuming the order does not exist
    expect(calls.cancel).toHaveLength(1);
    expect(unwinder.status()[0]!.order).toBeNull();
    // the delayed first request now arrives: it is refused, the nonce is dead
    expect(await late!()).toMatchObject({ ok: false, code: "NONCE_CANCELLED" });
    expect(resting()).toEqual([]);
    // had the cancel not been confirmed, the order would have stayed "unconfirmed" and nothing new placed
    const h2 = harness({ withChain: true });
    const s2 = setup(h2);
    h2.chain.positions.set(KEY, wad(2));
    await h2.engine.refreshChainState();
    s2.client.submit = async () => ({ ok: false, code: "NO_ANSWER", outcome: "unknown", message: "timeout" });
    await s2.unwinder.tick();
    s2.client.submit = async () => ({ ok: false, code: "STORE_UNAVAILABLE", outcome: "not_applied", message: "" });
    s2.client.cancel = async () => ({ ok: false, code: "STORE_UNAVAILABLE", outcome: "not_applied", message: "" });
    await s2.unwinder.tick();
    await s2.unwinder.tick();
    expect(s2.unwinder.status()[0]).toMatchObject({ order: { state: "unconfirmed" }, note: expect.stringMatching(/may be live/) });
  });

  it("an order of the keeper that this process is not managing (left by an earlier process) is cancelled on the first pass", async () => {
    const h = harness({ withChain: true });
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    const ghost = await h.place(keeperAcct, false, "99.5", 2, { order: { reduceOnly: true } });
    const { unwinder, resting } = setup(h);
    await unwinder.tick(); // cancels the ghost; with it gone the reduce-only cap is free again
    await unwinder.tick();
    expect(h.engine.getOrder(ghost.orderHash)!.status).toBe("cancelled");
    expect(resting().map((o) => o.order.limitPrice)).toEqual([wad("99.9")]);
  });
});

describe("R3-2 / item 3: no stale quote through an oracle outage", () => {
  it("index unavailable: the working order is cancelled; when the feed returns 3% higher there is nothing to hit; the next pass quotes the new price", async () => {
    const h = harness({ withChain: true });
    const { unwinder, resting } = setup(h);
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting()[0]!.order.limitPrice).toBe(wad("99.9"));
    h.chain.indexFails = true;
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(unwinder.status()[0]!.note).toBe("index price unavailable");
    expect(resting()).toEqual([]); // cancels work while the market is halted
    h.chain.indexFails = false;
    h.chain.index = wad(103);
    await h.engine.refreshChainState(); // the engine resumes before the keeper looks again
    const t = await h.place(alice, true, 103, 2, { ioc: true });
    expect(t.fills).toEqual([]);
    await unwinder.tick();
    expect(resting().map((o) => o.order.limitPrice)).toEqual([wad("102.897")]);
  });

  it("the reprice threshold is never wider than the offset: a resting quote is at most twice the offset through the index", async () => {
    const h = harness({ withChain: true });
    const { unwinder, resting } = setup(h); // offset 10 bps, reprice asked 20 bps
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    await unwinder.tick();
    const first = resting()[0]!.orderHash;
    h.chain.index = wad("100.09"); // 9 bps: stays
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting()[0]!.orderHash).toBe(first);
    h.chain.index = wad("100.11"); // 11 bps: re-priced
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting().map((o) => o.order.limitPrice)).toEqual([wad("100.00989")]);
  });
});

describe("R3-3 / item 4: the keeper notices when the engine has closed its order", () => {
  it("the order was fully matched as taker and the match failed for a global reason: the next pass sees it is not live and places a new one", async () => {
    const h = harness({ withChain: true });
    const { unwinder, resting, calls } = setup(h);
    await h.engine.refreshChainState();
    await h.place(bob, true, 100, 2); // resting bid crosses the keeper's 99.9 sell
    h.settler.failWhen = () => err("PriceOutOfBand", [wad(100), wad(90)]);
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    await h.engine.idle();
    const first = calls.submit[0]!;
    h.settler.failWhen = () => null;
    h.clock.now += 5;
    await unwinder.tick(); // not in the engine's list any more -> forgotten -> replaced in the same pass
    expect(calls.submit).toHaveLength(2);
    expect(calls.submit[1]!.nonce).not.toBe(first.nonce);
    await h.engine.idle();
    expect(h.settler.settled).toHaveLength(1); // and this one trades
    void resting;
  });
});

describe("R3-4 / item 11: partial fills and dust", () => {
  it("a partial fill does not make the keeper cancel and re-post; a sub-minimum remainder stays so that it can be completed", async () => {
    const h = harness({ withChain: true });
    const { unwinder, resting, calls } = setup(h);
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    await unwinder.tick();
    const hash = resting()[0]!.orderHash;
    let release!: () => void;
    h.settler.beforeSettle = () => new Promise<void>((r) => (release = r));
    await h.place(alice, true, 100, "0.5", { ioc: true });
    await unwinder.tick(); // matched, unsettled: the on-chain position is still 2
    h.settler.beforeSettle = () => {
      h.chain.positions.set(KEY, wad("1.5")); // settlement moves the position
    };
    h.chain.positions.set(KEY, wad("1.5"));
    release();
    await h.engine.idle();
    await unwinder.tick(); // settled: the position equals what the order has left
    expect(resting().map((o) => [o.orderHash, o.remaining])).toEqual([[hash, wad("1.5")]]);
    h.settler.beforeSettle = () => {
      h.chain.positions.set(KEY, wad("0.005"));
    };
    await h.place(alice, true, 100, "1.495", { ioc: true });
    await h.engine.idle();
    await unwinder.tick();
    expect(resting().map((o) => [o.orderHash, o.remaining])).toEqual([[hash, wad("0.005")]]); // dust, still fillable in one piece
    expect(calls.submit).toHaveLength(1);
    expect(calls.cancel).toEqual([]);
    const t = await h.place(alice, true, 100, 1, { ioc: true });
    expect(t.fills.map((f) => f.size)).toEqual([wad("0.005")]);
  });
});

describe("R3-5 / item 7: cancels for orders the engine has never seen are bounded", () => {
  it("a repeat is a no-op; nonces no order could carry are refused; per trader the number of order-less dead nonces is capped", async () => {
    const store = new SqliteStore(":memory:");
    const h = harness({ store, maxOrderlessCancels: 5 });
    let commits = 0;
    const commit = store.commit.bind(store);
    store.commit = (c) => {
      commits++;
      commit(c);
    };
    const a = privateKeyToAccount(generatePrivateKey()) as unknown as TestAccount;
    const sig = (n: bigint) => signCancel(a, a.address, n);
    // a nonce beyond what any acceptable order could have
    expect(await code(h.engine.cancel(ZERO_HASH, await sig(2n ** 256n - 1n), { trader: a.address, nonce: 2n ** 256n - 1n }))).toBe("INVALID_ORDER");
    expect(commits).toBe(0);
    // the same cancel twice: one commit, one count
    await h.engine.cancel(ZERO_HASH, await sig(7n), { trader: a.address, nonce: 7n });
    h.clock.now += 1;
    expect(await h.engine.cancel(ZERO_HASH, await sig(7n), { trader: a.address, nonce: 7n })).toMatchObject({ known: false, status: "cancelled" });
    expect(commits).toBe(1);
    expect(h.engine.metrics.get("orders_cancelled_total")).toBe(1);
    // the cap
    for (let n = 8n; n < 12n; n++) await h.engine.cancel(ZERO_HASH, await sig(n), { trader: a.address, nonce: n });
    const refused = await h.engine.cancel(ZERO_HASH, await sig(12n), { trader: a.address, nonce: 12n }).catch((e) => e);
    expect(refused).toMatchObject({ code: "RATE_LIMITED", httpStatus: 429, outcome: "not_applied" });
    expect(store.load().deadNonces).toHaveLength(5);
    // cancelling an order the engine HAS is never subject to that cap
    const order = makeOrder(a, true, 100, 1, { nonce: 1_000_000n });
    const r = await h.engine.submit({ order, signature: await signOrder(a, order) });
    expect((await h.engine.cancel(r.orderHash, await sig(order.nonce))).status).toBe("cancelled");
    // others are unaffected, and nobody can kill someone else's nonce
    expect(await h.engine.cancel(ZERO_HASH, await signCancel(bob, bob.address, 9n), { trader: bob.address, nonce: 9n })).toMatchObject({ known: false });
    expect(await code(h.engine.cancel(ZERO_HASH, await signCancel(bob, alice.address, 9n), { trader: alice.address, nonce: 9n }))).toBe("BAD_SIGNATURE");
    // the rows go away with time, and the count with them
    h.clock.now += 9 * 86400;
    h.engine.pruneFinished();
    expect(store.load().deadNonces).toHaveLength(0);
    expect(await code(h.engine.cancel(ZERO_HASH, await sig(BigInt(h.clock.now)), { trader: a.address, nonce: BigInt(h.clock.now) }))).toBe("OK");
  });

  it("pre-emptive cancels are rate-limited per trader, like orders", async () => {
    const h = harness({ traderOrdersPerMinute: 3 });
    for (let n = 1n; n <= 3n; n++) await h.engine.cancel(ZERO_HASH, await signCancel(alice, alice.address, n), { trader: alice.address, nonce: n });
    expect(await code(h.engine.cancel(ZERO_HASH, await signCancel(alice, alice.address, 4n), { trader: alice.address, nonce: 4n }))).toBe("RATE_LIMITED");
  });

  it("an on-chain cancel event read again in the rescan window writes nothing", async () => {
    const store = new SqliteStore(":memory:");
    const h = harness({ store });
    const order = makeOrder(alice, true, 100, 1);
    await h.engine.submit({ order, signature: await signOrder(alice, order) });
    let commits = 0;
    const commit = store.commit.bind(store);
    store.commit = (c) => {
      commits++;
      commit(c);
    };
    for (let i = 0; i < 5; i++) {
      h.clock.now += 2;
      h.engine.cancelNonce(alice.address, order.nonce, "cancelled on-chain");
      h.engine.cancelNonce(bob.address, 77n, "cancelled on-chain"); // a nonce the engine has no order for
      h.engine.cancelBelow(carol.address, 500n);
    }
    expect(commits).toBe(3);
    expect(h.engine.metrics.get("orders_cancelled_total")).toBe(3);
  });
});

describe("R3-6 / item 8: chain time", () => {
  it("one block-timestamp reading far ahead expires nothing", async () => {
    const h = harness({ withChain: true, expiryBufferSec: 30, minTimeToExpirySec: 60 });
    await h.engine.refreshChainState();
    const a = await h.place(alice, true, 99, 1, { order: { expiry: 1000n + 600n } });
    h.chain.time = 1000n + 10n ** 6n; // one bad answer
    await h.engine.refreshChainState();
    h.engine.sweepExpired();
    h.chain.time = 1000n;
    await h.engine.refreshChainState();
    h.engine.sweepExpired();
    expect(h.engine.getOrder(a.orderHash)!.status).toBe("open");
    expect(h.engine.chainStatus()).toMatchObject({ chainTimeLeadSec: 0n, clockSkewSec: null });
  });

  it("a lead that persists above the limit halts intake with a warning instead of being clamped; resting orders are not mass-expired", async () => {
    const h = harness({ withChain: true, expiryBufferSec: 30, minTimeToExpirySec: 60 });
    await h.engine.refreshChainState();
    const resting = await h.place(alice, true, 99, 1, { order: { expiry: 1000n + 1000n } });
    h.chain.time = 1000n + 3600n; // the host clock is an hour slow (or the node travelled in time)
    for (let i = 0; i < 3; i++) await h.engine.refreshChainState();
    const e = await h.place(bob, true, 98, 1, { order: { expiry: 1000n + 1000n } }).catch((x) => x);
    expect(e).toMatchObject({ code: "CHAIN_UNAVAILABLE", httpStatus: 503, outcome: "not_applied" });
    expect(e.message).toMatch(/3600 s ahead/);
    h.engine.sweepExpired();
    expect(h.engine.getOrder(resting.orderHash)!.status).toBe("open");
    expect(h.engine.chainStatus()).toMatchObject({ clockSkewSec: 3600n, chainTimeLeadSec: 0n });
    const { buildServer } = await import("../src/api/server.ts");
    const app = await buildServer(h.engine);
    expect((await app.inject({ url: "/health" })).json().warnings).toContainEqual(expect.stringMatching(/chain time is 3600 s ahead/));
    await app.close();
    // clocks agree again: back to normal
    h.chain.time = 1000n;
    await h.engine.refreshChainState();
    expect(await code(h.place(bob, true, 98, 1))).toBe("OK");
  });

  it("a moderate lead does not make the keeper's orders unplaceable: it dates them by the engine's clock", async () => {
    const h = harness({ withChain: true, expiryBufferSec: 30, minTimeToExpirySec: 60 });
    h.chain.time = 1000n + 280n; // chain 280 s ahead: an order expiring at local now + 300 would be refused (20 s left)
    for (let i = 0; i < 3; i++) await h.engine.refreshChainState();
    expect(h.engine.engineTime()).toBe(1280n);
    const { unwinder, resting } = setup(h);
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    expect(resting().map((o) => o.order.expiry)).toEqual([1280n + 300n]);
    await unwinder.tick();
    await unwinder.tick();
    expect(resting()).toHaveLength(1); // and it is not renewed every pass either
  });
});

describe("R3-7 / items 2 and 9: resubmitting a known order always returns its state", () => {
  it("a resting order close to its expiry answers with its state, not EXPIRED", async () => {
    const h = harness({ expiryBufferSec: 30, minTimeToExpirySec: 60 });
    const order = makeOrder(alice, true, 100, 1, { expiry: 1000n + 100n });
    const sig = await signOrder(alice, order);
    await h.engine.submit({ order, signature: sig });
    h.clock.now += 45; // 55 s left: a NEW order would be refused, this one still rests
    h.engine.sweepExpired();
    expect(await h.engine.submit({ order, signature: sig })).toMatchObject({ duplicate: true, status: "open", remaining: wad(1) });
    h.clock.now += 30;
    h.engine.sweepExpired();
    expect(await h.engine.submit({ order, signature: sig })).toMatchObject({ duplicate: true, status: "expired" });
  });

  it("... also while the engine is draining, recovering, stalled, or its store is down", async () => {
    const store = new SqliteStore(":memory:");
    const h = harness({ store, retryDelayMs: 20 });
    const order = makeOrder(alice, true, 100, 1);
    const sig = await signOrder(alice, order);
    await h.engine.submit({ order, signature: sig });
    const other = makeOrder(bob, true, 99, 1);
    const otherSig = await signOrder(bob, other);
    // store down
    const commit = store.commit.bind(store);
    store.commit = () => {
      throw new Error("disk full");
    };
    expect(await code(h.engine.submit({ order: other, signature: otherSig }))).toBe("STATE_UNKNOWN");
    expect(await h.engine.submit({ order, signature: sig })).toMatchObject({ duplicate: true, status: "open" });
    expect(await h.engine.submit({ order: other, signature: otherSig })).toMatchObject({ duplicate: true, status: "open" });
    const third = makeOrder(carol, true, 98, 1);
    expect(await code(h.engine.submit({ order: third, signature: await signOrder(carol, third) }))).toBe("STORE_UNAVAILABLE");
    store.commit = commit;
    // draining
    void h.engine.stop(50);
    expect(await h.engine.submit({ order, signature: sig })).toMatchObject({ duplicate: true, status: "open" });
    expect(await code(h.engine.submit({ order: third, signature: await signOrder(carol, third) }))).toBe("SHUTTING_DOWN");
    // a wrong signature is still refused
    expect(await code(h.engine.submit({ order, signature: await signOrder(bob, order) }))).toBe("BAD_SIGNATURE");
  });

  it("flags of a resubmission are ignored and a cancelled order answers 200 cancelled (not 409)", async () => {
    const h = harness();
    const order = makeOrder(alice, true, 100, 1);
    const sig = await signOrder(alice, order);
    const first = await h.engine.submit({ order, signature: sig, postOnly: true });
    expect(await h.engine.submit({ order, signature: sig, ioc: true })).toMatchObject({ duplicate: true, status: "open" });
    expect(h.engine.getOrder(first.orderHash)).toMatchObject({ postOnly: true, ioc: false });
    await h.engine.cancel(first.orderHash, await signCancel(alice, alice.address, order.nonce));
    expect(await h.engine.submit({ order, signature: sig })).toMatchObject({ duplicate: true, status: "cancelled" });
  });
});

describe("R3-8 / item 1: the open-interest cap", () => {
  it("at the cap, flow that would add open interest is not matched at all: no settlement attempts, nothing to pay for", async () => {
    const h = harness({ withChain: true });
    h.chain.oi = { longs: MARKET.maxOpenInterest, shorts: MARKET.maxOpenInterest };
    await h.engine.refreshChainState();
    h.settler.failWhen = () => err("OpenInterestCapExceeded"); // what the chain would say
    const maker = await h.place(alice, false, 100, 5);
    for (let i = 0; i < 25; i++) {
      const t = await h.place(bob, true, 100, 1, { ioc: true });
      expect(t).toMatchObject({ fills: [], status: "cancelled", reason: expect.stringMatching(/open-interest cap/) });
    }
    await h.engine.idle();
    expect(h.settler.calls).toHaveLength(0);
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(5) });
    expect(h.engine.chainStatus()!.markets[0]!.openInterestCapReached).toBe(true);
    // a non-crossing order still rests
    expect((await h.place(bob, true, 99, 1)).status).toBe("open");
  });

  it("... while reducing flow still trades: a fill with a reduce-only side cannot add open interest", async () => {
    const h = harness({ withChain: true });
    h.chain.oi = { longs: MARKET.maxOpenInterest, shorts: MARKET.maxOpenInterest };
    h.chain.positions.set(`${carol.address.toLowerCase()}:1`, -wad(3)); // carol is short 3
    await h.engine.refreshChainState();
    await h.place(alice, false, 100, 5);
    const t = await h.place(carol, true, 100, 2, { ioc: true, order: { reduceOnly: true } }); // reduce-only taker
    expect(t.fills.map((f) => f.size)).toEqual([wad(2)]);
    const ro = await h.place(carol, true, 99, 1, { order: { reduceOnly: true } }); // reduce-only maker
    const s = await h.place(bob, false, 99, 1, { ioc: true });
    expect(s.fills.map((f) => f.makerOrderHash)).toEqual([ro.orderHash]);
    await h.engine.idle();
    expect(h.settler.settled).toHaveLength(2);
  });

  it("the cap is approached exactly: matches are cut to the room left, counting matches that have not settled yet", async () => {
    const h = harness({ withChain: true });
    h.chain.oi = { longs: MARKET.maxOpenInterest - wad(3), shorts: MARKET.maxOpenInterest - wad(3) };
    await h.engine.refreshChainState();
    let release!: () => void;
    h.settler.beforeSettle = () => new Promise<void>((r) => (release = r));
    await h.place(alice, false, 100, 10);
    const t1 = await h.place(bob, true, 100, 2, { ioc: true }); // room 3 -> 1 (unsettled)
    expect(t1.fills.map((f) => f.size)).toEqual([wad(2)]);
    const t2 = await h.place(bob, true, 100, 2, { ioc: true }); // only 1 fits
    expect(t2.fills.map((f) => f.size)).toEqual([wad(1)]);
    expect(t2.reason).toMatch(/open-interest cap/);
    const t3 = await h.place(bob, true, 100, 1, { ioc: true });
    expect(t3.fills).toEqual([]);
    release();
    h.settler.beforeSettle = () => {};
    await h.engine.idle();
    // settled, chain not re-read yet: still counted in full
    expect((await h.place(bob, true, 100, 1, { ioc: true })).fills).toEqual([]);
    // the chain says the fills added less open interest than assumed (bob was closing a short)
    h.chain.oi = { longs: MARKET.maxOpenInterest - wad(2), shorts: MARKET.maxOpenInterest - wad(2) };
    await h.engine.refreshChainState();
    expect((await h.place(bob, true, 100, 5, { ioc: true })).fills.map((f) => f.size)).toEqual([wad(2)]);
  });

  it("a failed match frees the room it had reserved", async () => {
    const h = harness({ withChain: true });
    h.chain.oi = { longs: MARKET.maxOpenInterest - wad(1), shorts: MARKET.maxOpenInterest - wad(1) };
    await h.engine.refreshChainState();
    await h.place(alice, false, 100, 10);
    h.settler.failWhen = () => err("InsufficientMargin", [bob.address]);
    await h.place(bob, true, 100, 1, { ioc: true });
    await h.engine.idle();
    h.settler.failWhen = () => null;
    expect((await h.place(carol, true, 100, 1, { ioc: true })).fills).toHaveLength(1);
  });

  it("when the chain refuses for a global reason the engine did not see coming: makers keep everything, the taker's order ends after a few rounds, and a trader who keeps producing such failures is throttled", async () => {
    const h = harness({ withChain: true, globalFailureThreshold: 4, globalFailureWindowSec: 60 });
    await h.engine.refreshChainState();
    h.settler.failWhen = () => err("OpenInterestCapExceeded"); // chain OI is at the cap; the engine's reading is stale
    const makers = [];
    for (let i = 0; i < 5; i++) makers.push(await h.place(alice, false, 100 + i * 0.1, 1));
    const t = await h.place(bob, true, 101, 6); // not IOC: 5 matched, 1 rests
    await h.engine.idle();
    expect(makers.map((m) => h.engine.getOrder(m.orderHash)!.status)).toEqual(Array(5).fill("open"));
    expect(makers.map((m) => h.engine.getOrder(m.orderHash)!.remaining)).toEqual(Array(5).fill(wad(1)));
    expect(h.engine.getOrder(t.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n });
    expect(h.engine.getOrderBook(1, 10).asks).toHaveLength(5);
    expect(h.settler.calls.length).toBeLessThanOrEqual(3);
    // bob produced 5+ such failures within the window: his next orders wait
    const e = await h.place(bob, true, 100, 1, { ioc: true }).catch((x) => x);
    expect(e).toMatchObject({ code: "RATE_LIMITED", httpStatus: 429, outcome: "not_applied" });
    expect(await code(h.place(carol, true, 99, 1))).toBe("OK"); // others are unaffected
    h.clock.now += 61;
    h.chain.time += 61n;
    expect(await code(h.place(bob, true, 99, 1, { order: { expiry: BigInt(h.clock.now + 3600) } }))).toBe("OK");
  });

  it("repeated IOC attempts into a condition the engine cannot see are stopped by the throttle (bounded settlement attempts)", async () => {
    const h = harness({ withChain: true, globalFailureThreshold: 5 });
    await h.engine.refreshChainState();
    h.settler.failWhen = () => err("OpenInterestCapExceeded");
    await h.place(alice, false, 100, 5);
    const codes: string[] = [];
    for (let i = 0; i < 25; i++) {
      codes.push(await code(h.place(bob, true, 100, 1, { ioc: true })));
      await h.engine.idle();
    }
    expect(h.settler.calls.length).toBe(5);
    expect(codes.filter((c) => c === "RATE_LIMITED")).toHaveLength(20);
  });
});

describe("item 6: reduce-only orders and ordinary counterparty flow", () => {
  it("a plain order that closes the position pulls the reduce-only order that relied on it; nothing reaches the chain to fail", async () => {
    const h = harness({ withChain: true });
    const V = `${alice.address.toLowerCase()}:1`;
    h.chain.positions.set(V, wad(10)); // V is long 10
    await h.engine.refreshChainState();
    const ro = await h.place(alice, false, "100.2", 10, { order: { reduceOnly: true } });
    const plain = await h.place(alice, false, 100, 10); // better priced: fills first
    const t = await h.place(bob, true, "100.2", 20); // crosses both in one pass
    expect(t.fills.map((f) => f.makerOrderHash)).toEqual([plain.orderHash]);
    expect(t).toMatchObject({ status: "partially_filled", remaining: wad(10) }); // the taker is not penalised: its remainder rests
    expect(h.engine.getOrder(ro.orderHash)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(/reduce-only/) });
    await h.engine.idle();
    expect(h.settler.settled).toHaveLength(1);
    expect(h.engine.settlementStatus().failed).toBe(0);
  });

  it("only as much as is no longer covered is pulled (newest first), counting the trader's unsettled matches", async () => {
    const h = harness({ withChain: true });
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, wad(10));
    await h.engine.refreshChainState();
    h.settler.beforeSettle = () => new Promise<void>(() => {}); // matches stay unsettled: the chain still says 10
    const ro1 = await h.place(alice, false, "100.3", 4, { order: { reduceOnly: true } });
    const ro2 = await h.place(alice, false, "100.4", 4, { order: { reduceOnly: true } });
    await h.place(alice, false, 100, 5); // plain
    await h.place(bob, true, 100, 5); // plain sell fills 5: position will be 5 -> covers ro1 (4), not ro2
    expect(h.engine.getOrder(ro1.orderHash)!.status).toBe("open");
    expect(h.engine.getOrder(ro2.orderHash)!.status).toBe("cancelled");
    // a new reduce-only order is measured against the position that will be left: 5 - 4 = 1
    expect(await code(h.place(alice, false, "100.5", 2, { order: { reduceOnly: true } }))).toBe("REDUCE_ONLY_EXCEEDS_POSITION");
    expect(await code(h.place(alice, false, "100.5", 1, { order: { reduceOnly: true } }))).toBe("OK");
  });

  it("if the plain match fails on-chain the position is still there: nothing more is pulled afterwards", async () => {
    const h = harness({ withChain: true });
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, wad(10));
    await h.engine.refreshChainState();
    const ro = await h.place(alice, false, "100.3", 10, { order: { reduceOnly: true } });
    await h.place(alice, false, 100, 4);
    h.settler.failWhen = () => err("InsufficientMargin", [bob.address]);
    await h.place(bob, true, 100, 4, { ioc: true }); // would leave 6: the reduce-only 10 is pulled...
    expect(h.engine.getOrder(ro.orderHash)!.status).toBe("cancelled");
    await h.engine.idle();
    // ...and after the failure a new one for the full position is accepted again
    expect(await code(h.place(alice, false, "100.3", 10, { order: { reduceOnly: true } }))).toBe("OK");
  });

  it("a reduce-only failure on-chain does not count towards suspension (anyone could cause it); a margin failure does", async () => {
    const h = harness({ withChain: true, faultThreshold: 1 });
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, wad(10));
    await h.engine.refreshChainState();
    const ro = await h.place(alice, false, 100, 5, { order: { reduceOnly: true } });
    h.settler.failWhen = () => err("ReduceOnlyViolated", [alice.address]);
    await h.place(bob, true, 100, 5, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(ro.orderHash)!.status).toBe("rejected");
    expect(await code(h.place(alice, true, 99, 1))).toBe("OK"); // not suspended although the threshold is 1
    h.settler.failWhen = () => err("InsufficientMargin", [alice.address]);
    await h.place(bob, false, 99, 1, { ioc: true });
    await h.engine.idle();
    expect(await code(h.place(alice, true, 98, 1))).toBe("TRADER_SUSPENDED");
  });
});

describe("items 10 and 14: refreshes and caches", () => {
  it("a hanging stats view delays neither the refresh matching depends on nor the other figures", async () => {
    const h = harness({ withChain: true, chainReadTimeoutMs: 30 });
    h.chain.insuranceFund = () => new Promise(() => {}); // never answers
    h.chain.markTwap = () => new Promise(() => {});
    h.chain.oi = { longs: wad(7), shorts: wad(7) };
    const t0 = Date.now();
    await h.engine.refreshChainState();
    expect(Date.now() - t0).toBeLessThan(25); // the core refresh does not read them at all
    expect(await code(h.place(alice, true, 100, 1))).toBe("OK");
    await h.engine.refreshStats();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(h.engine.getMarkets()[0]).toMatchObject({ markTwap: null, currentFundingRate: null, openInterestLong: wad(7), lastFundingTime: 900n });
    expect(h.engine.exchangeStats()).toEqual({ insuranceFund: null, totalBadDebt: 0n });
  });

  it("a hanging core view does not hang the refresh: the market is halted until it answers", async () => {
    const h = harness({ withChain: true, chainReadTimeoutMs: 30 });
    await h.engine.refreshChainState();
    const real = h.chain.indexPrice.bind(h.chain);
    h.chain.indexPrice = () => new Promise(() => {});
    await h.engine.refreshChainState();
    expect(h.engine.chainStatus()!.markets[0]!.indexPrice).toBeNull();
    h.chain.indexPrice = real;
    await h.engine.refreshChainState();
    expect(h.engine.chainStatus()!.markets[0]!.indexPrice).toBe(wad(100));
  });

  it("after a settlement failure the chain is read afresh, not through a refresh that was already under way", async () => {
    const h = harness({ withChain: true });
    await h.engine.refreshChainState();
    let pausedReads = 0;
    let releaseStale!: () => void;
    const realPaused = h.chain.paused.bind(h.chain);
    h.chain.paused = async () => {
      if (++pausedReads === 1) {
        const before = await realPaused(); // read "before the pause"
        await new Promise<void>((r) => (releaseStale = r)); // ... and answered late
        return before;
      }
      return realPaused();
    };
    const stale = h.engine.refreshChainState(); // under way, will report "not paused"
    await h.place(alice, true, 100, 5);
    h.chain.isPaused = true;
    h.settler.failWhen = () => err("OnlyReducingAllowed");
    await h.place(bob, false, 100, 1, { ioc: true });
    await new Promise((r) => setTimeout(r, 10));
    releaseStale();
    await stale;
    await h.engine.idle();
    expect(pausedReads).toBeGreaterThanOrEqual(2);
    expect(h.engine.chainStatus()!.paused).toBe(true); // the engine acts on the fresh read
  });

  it("a position read that was started before a match settled cannot repopulate the cache with the old value", async () => {
    const h = harness({ withChain: true, preTradeCacheMs: 60_000 });
    const me = `${carol.address.toLowerCase()}:1`;
    h.chain.positions.set(me, -wad(2));
    await h.engine.refreshChainState();
    await h.place(alice, false, 100, 5);
    // a reduce-only buy is being checked; its position read is slow and returns the old value
    let release!: () => void;
    const realPos = h.chain.positionSize.bind(h.chain);
    let slow = true;
    h.chain.positionSize = async (t, m) => {
      const v = await realPos(t, m);
      if (slow && t === carol.address) {
        slow = false;
        await new Promise<void>((r) => (release = r));
      }
      return v;
    };
    const first = h.place(carol, true, 100, 1, { order: { reduceOnly: true } });
    await new Promise((r) => setTimeout(r, 5));
    // meanwhile another match of carol's settles and invalidates what was cached for her
    h.engine["invalidateReads"](carol.address.toLowerCase());
    h.chain.positions.set(me, -wad(1)); // the settled match closed 1
    release();
    await first;
    // the next check must see the position as it is now (1), not the stale 2 from the slow read
    await h.engine.idle();
    expect(await code(h.place(carol, true, 100, 2, { order: { reduceOnly: true } }))).toBe("REDUCE_ONLY_EXCEEDS_POSITION");
  });

  it("while paused the unwinder does not post an order every pass that is cancelled on arrival", async () => {
    const h = harness({ withChain: true });
    const { unwinder, calls } = setup(h);
    await h.place(bob, true, 100, 2); // a non-reduce-only bid that crosses the keeper's sell
    h.chain.isPaused = true;
    h.chain.positions.set(KEY, wad(2));
    await h.engine.refreshChainState();
    for (let i = 0; i < 10; i++) {
      await unwinder.tick(); // each pass is 1 s in production
      h.clock.now += 1;
      h.chain.time += 1n;
    }
    expect(calls.submit.length).toBeLessThanOrEqual(2); // 5 s, then 10 s, ... between attempts
    expect(unwinder.status()[0]!.note).toMatch(/next attempt in/);
  });
});
