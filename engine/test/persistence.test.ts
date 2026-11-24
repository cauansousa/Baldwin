// Durable state: restart, crash and reconciliation scenarios.
import { copyFileSync, existsSync, mkdtempSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Engine, EngineError, type EngineOptions } from "../src/engine/engine.ts";
import { FakeSettler } from "../src/settlement/fakeSettler.ts";
import { hashOrder } from "../src/signing.ts";
import { SqliteStore } from "../src/store/sqliteStore.ts";
import type { Commit } from "../src/store/types.ts";
import { alice, bob, carol, DOMAIN, FakeChain, makeOrder, MARKET, signCancel, signOrder, wad, type TestAccount } from "./helpers.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "baldwin-store-")), "engine.sqlite");
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "OK";
};

/** One "process": an engine on a store file. The chain and the settler outlive it. */
function boot(path: string, world: { chain: FakeChain; settler: FakeSettler; now: number }, extra: Partial<EngineOptions> = {}) {
  const store = new SqliteStore(path);
  const engine = new Engine({
    domain: DOMAIN,
    markets: [MARKET],
    settler: world.settler,
    chain: world.chain,
    store,
    now: () => world.now,
    retryDelayMs: 1,
    expiryBufferSec: 5,
    minTimeToExpirySec: 0,
    ...extra,
  });
  const place = async (a: TestAccount, isBuy: boolean, price: number | string, size: number | string, flags: { ioc?: boolean; postOnly?: boolean; expiry?: bigint; nonce?: bigint } = {}) => {
    const order = makeOrder(a, isBuy, price, size, { ...(flags.expiry ? { expiry: flags.expiry } : {}), ...(flags.nonce ? { nonce: flags.nonce } : {}) });
    const res = await engine.submit({ order, signature: await signOrder(a, order), ioc: flags.ioc, postOnly: flags.postOnly });
    return { ...res, order };
  };
  return { engine, store, place };
}
/** The fake chain's filledSize follows what the fake settler "mined". */
const world = () => {
  const w = { chain: new FakeChain(), settler: new FakeSettler(), now: 1000 };
  const settle = w.settler.settle.bind(w.settler);
  w.settler.settle = async (batch) => {
    const res = await settle(batch);
    for (const [h, v] of w.settler.filled) w.chain.filled.set(h, v);
    return res;
  };
  return w;
};
const mirror = (_w: unknown) => {};

describe("restart", () => {
  it("restores the book with the same time priority, fill state, flags and trades", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const first = await p1.place(alice, false, 100, 2);
    const second = await p1.place(carol, false, 100, 1);
    const deep = await p1.place(carol, false, 103, 1, { postOnly: true });
    const bid = await p1.place(bob, true, 98, 3);
    await p1.place(bob, true, 100, "0.5"); // partial fill of `first`
    await p1.engine.idle();
    mirror(w);
    const bookBefore = p1.engine.getOrderBook(1, 10);
    const tradesBefore = p1.engine.getTrades(1, 10);
    // killed: no stop(), no close()

    const p2 = boot(path, w);
    await p2.engine.recover();
    expect(p2.engine.getOrderBook(1, 10)).toEqual(bookBefore);
    expect(p2.engine.getTrades(1, 10)).toEqual(tradesBefore);
    expect(p2.engine.getMarkets()[0]!.lastPrice).toBe(wad(100));
    expect(p2.engine.getOrder(first.orderHash)).toMatchObject({ status: "partially_filled", remaining: wad("1.5"), filled: wad("0.5"), pending: 0n });
    expect(p2.engine.getOrder(deep.orderHash)).toMatchObject({ status: "open", postOnly: true });
    expect(p2.engine.getOpenOrders(bob.address).map((o) => o.orderHash)).toEqual([bid.orderHash]);
    // time priority survived: the older ask at 100 is hit first, then the newer one
    const t = await p2.place(bob, true, 100, 2);
    expect(t.fills.map((f) => [f.makerOrderHash, f.size])).toEqual([[first.orderHash, wad("1.5")], [second.orderHash, wad("0.5")]]);
    // and new orders queue behind restored ones at the same price
    const late = await p2.place(alice, false, 100, 1, {});
    const t2 = await p2.place(bob, true, 100, 1);
    expect(t2.fills.map((f) => f.makerOrderHash)).toEqual([second.orderHash, late.orderHash]);
    // duplicates of restored orders are still recognised
    expect(await code(p2.engine.submit({ order: first.order, signature: await signOrder(alice, first.order) }))).toBe("DUPLICATE_ORDER");
  });

  it("an accepted order is on disk before the client gets its answer", async () => {
    const path = dbPath();
    const p1 = boot(path, world());
    const r = await p1.place(alice, true, 100, 1);
    const other = new SqliteStore(path); // what a process starting right now would read
    expect(other.load().orders.map((o) => [o.hash, o.remaining])).toEqual([[r.orderHash, wad(1)]]);
    other.close();
  });

  it("crash with matches queued but never sent: they are settled after the restart, exactly once", async () => {
    const path = dbPath();
    const w = world();
    const never = new Promise<void>(() => {});
    w.settler.beforeSettle = () => never; // the settlement call never gets anywhere in this process
    const p1 = boot(path, w);
    const maker = await p1.place(alice, false, 100, 2);
    const taker = await p1.place(bob, true, 100, 1);
    expect(taker.status).toBe("pending_settlement");
    // killed

    w.settler.beforeSettle = () => {};
    const p2 = boot(path, w);
    expect(p2.engine.settlementStatus()).toMatchObject({ inFlight: 1 });
    expect(p2.engine.getOrder(taker.orderHash)).toMatchObject({ status: "pending_settlement", pending: wad(1) });
    await p2.engine.recover();
    expect(w.settler.settled).toHaveLength(1);
    expect(w.settler.filled.get(maker.orderHash)).toBe(wad(1));
    expect(p2.engine.getOrder(taker.orderHash)).toMatchObject({ status: "filled", filled: wad(1), pending: 0n });
    expect(p2.engine.getOrder(maker.orderHash)).toMatchObject({ status: "partially_filled", remaining: wad(1), filled: wad(1) });
    expect(p2.engine.getTrades(1, 10)).toHaveLength(1);
  });

  it("crash between broadcast and receipt: the batch that did settle on-chain is recognised, not re-submitted", async () => {
    const path = dbPath();
    const w = world();
    const inner = w.settler.settle.bind(w.settler);
    // The transaction lands on-chain, but this process never learns the result.
    w.settler.settle = async (batch) => {
      await inner(batch);
      mirror(w);
      return new Promise(() => {});
    };
    const p1 = boot(path, w);
    const maker = await p1.place(alice, false, 100, 2);
    const taker = await p1.place(bob, true, 100, 2);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.settler.settled).toHaveLength(1);
    expect(p1.engine.getOrder(taker.orderHash)!.status).toBe("pending_settlement");
    // killed

    w.settler.settle = inner; // the settler's record of the batch survived (same batch id -> same outcome)
    const p2 = boot(path, w);
    await p2.engine.recover();
    expect(w.settler.calls.map((b) => b.id)).toEqual(["b1", "b1"]);
    expect(w.settler.settled).toHaveLength(1); // not settled a second time
    expect(p2.engine.getOrder(maker.orderHash)).toMatchObject({ status: "filled", filled: wad(2), pending: 0n });
    expect(p2.engine.getOrder(taker.orderHash)).toMatchObject({ status: "filled", filled: wad(2) });
    expect(p2.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
    // the next batch gets a new id
    await p2.place(alice, false, 100, 1);
    await p2.place(bob, true, 100, 1);
    await p2.engine.idle();
    expect(w.settler.calls.at(-1)!.id).toBe("b2");
  });

  it("crash between broadcast and receipt, and the batch failed on-chain: the liquidity is restored, not dropped", async () => {
    const path = dbPath();
    const w = world();
    const inner = w.settler.settle.bind(w.settler);
    w.settler.failWhen = () => "0x5863f789";
    w.chain.isPaused = false;
    w.settler.settle = async (batch) => {
      await inner(batch);
      return new Promise(() => {});
    };
    const p1 = boot(path, w);
    const maker = await p1.place(alice, false, 100, 2);
    const taker = await p1.place(bob, true, 100, 2);
    await new Promise((r) => setTimeout(r, 5));
    // killed

    w.settler.settle = inner;
    const p2 = boot(path, w);
    await p2.engine.recover();
    expect(w.settler.settled).toHaveLength(0);
    expect(p2.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(2), pending: 0n, filled: 0n });
    expect(p2.engine.getOrder(taker.orderHash)!.status).toBe("rejected"); // unattributable failure: taker dropped
    expect(p2.engine.getOrderBook(1, 10).asks).toEqual([{ price: wad(100), size: wad(2) }]);
  });

  it("crash after the results were known but before they were written: applied once after the restart", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const maker = await p1.place(alice, false, 100, 1);
    // The commit that would record the batch's results fails as if the process died there.
    const commit = p1.store.commit.bind(p1.store);
    p1.store.commit = (c: Commit) => {
      if (c.removeMatches.length > 0) throw new Error("killed");
      commit(c);
    };
    await p1.place(bob, true, 100, 1);
    await p1.engine.idle();
    expect(w.settler.settled).toHaveLength(1);

    const p2 = boot(path, w);
    expect(p2.engine.getOrder(maker.orderHash)).toMatchObject({ pending: wad(1), filled: 0n }); // disk still has it in flight
    await p2.engine.recover();
    expect(w.settler.settled).toHaveLength(1);
    expect(p2.engine.getOrder(maker.orderHash)).toMatchObject({ status: "filled", filled: wad(1), pending: 0n });
    expect(p2.engine.getTrades(1, 10)).toHaveLength(1);
  });

  it("reconciles restored orders with the chain: fills, cancels, cancelAllOrders and expiry that happened meanwhile", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const partly = await p1.place(alice, false, 101, 4);
    const full = await p1.place(alice, false, 102, 1);
    const cancelled = await p1.place(bob, true, 99, 1);
    const below = await p1.place(carol, true, 98, 1, { nonce: 50n });
    const above = await p1.place(carol, true, 97, 1, { nonce: 5_000_000n });
    const expiring = await p1.place(bob, true, 96, 1, { expiry: 1500n });
    const untouched = await p1.place(bob, true, 95, 1);
    // killed; while the engine is down the chain moves on
    w.chain.filled.set(partly.orderHash, wad(1));
    w.chain.filled.set(full.orderHash, wad(1));
    w.chain.cancelled.add(`${bob.address.toLowerCase()}:${cancelled.order.nonce}`);
    w.chain.minValid.set(carol.address.toLowerCase(), 1000n);
    w.now = 2000;

    const p2 = boot(path, w);
    await p2.engine.recover();
    expect(p2.engine.getOrder(partly.orderHash)).toMatchObject({ status: "partially_filled", remaining: wad(3), filled: wad(1) });
    expect(p2.engine.getOrder(full.orderHash)).toMatchObject({ status: "filled", remaining: 0n, filled: wad(1) });
    expect(p2.engine.getOrder(cancelled.orderHash)).toMatchObject({ status: "cancelled", reason: "cancelled on-chain" });
    expect(p2.engine.getOrder(below.orderHash)!.status).toBe("cancelled");
    expect(p2.engine.getOrder(above.orderHash)!.status).toBe("open");
    expect(p2.engine.getOrder(expiring.orderHash)!.status).toBe("expired");
    expect(p2.engine.getOrder(untouched.orderHash)!.status).toBe("open");
    expect(p2.engine.getOrderBook(1, 10)).toEqual({
      marketId: 1,
      bids: [{ price: wad(97), size: wad(1) }, { price: wad(95), size: wad(1) }],
      asks: [{ price: wad(101), size: wad(3) }],
    });
    // and the corrections are themselves durable
    const p3 = boot(path, w);
    expect(p3.engine.getOrderBook(1, 10)).toEqual(p2.engine.getOrderBook(1, 10));
  });

  it("recover() fails rather than serve unverified state when the chain cannot be read", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    await p1.place(alice, false, 101, 1);
    w.chain.fail = true;
    await expect(boot(path, w).engine.recover()).rejects.toThrow(/rpc down/);
  });

  it("off-chain cancels, IOC orders and rejected orders stay dead across a restart", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const resting = await p1.place(alice, true, 100, 2);
    await p1.engine.cancel(resting.orderHash, await signCancel(alice, alice.address, resting.order.nonce));
    const ioc = await p1.place(bob, true, 100, 1, { ioc: true });
    expect(ioc.status).toBe("cancelled");

    const p2 = boot(path, w);
    await p2.engine.recover();
    expect(p2.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [] });
    for (const [acct, o] of [[alice, resting.order], [bob, ioc.order]] as const) {
      expect(["NONCE_CANCELLED", "DUPLICATE_ORDER"]).toContain(await code(p2.engine.submit({ order: o, signature: await signOrder(acct, o) })));
    }
    expect(p2.engine.getOrder(resting.orderHash)!.status).toBe("cancelled");
  });

  it("a write torn by a crash is discarded: the store opens at the last complete commit", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const a = await p1.place(alice, false, 100, 1);
    const sizeAfterFirst = statSync(`${path}-wal`).size;
    const b = await p1.place(carol, false, 101, 1);
    await p1.place(bob, true, 100, 1); // a match: several rows in one commit
    await p1.engine.idle();
    // Snapshot the files as a crash would leave them, with the tail of the log cut off mid-record.
    const copy = dbPath();
    copyFileSync(path, copy);
    copyFileSync(`${path}-wal`, `${copy}-wal`);
    const walSize = statSync(`${copy}-wal`).size;
    expect(walSize).toBeGreaterThan(sizeAfterFirst);
    truncateSync(`${copy}-wal`, walSize - 1000);
    expect(existsSync(`${copy}-wal`)).toBe(true);

    const store = new SqliteStore(copy);
    const snap = store.load();
    // Whatever survived is a consistent prefix: every match refers to stored orders,
    // and an order's matched size is covered by its unsettled matches.
    const hashes = new Set(snap.orders.map((o) => o.hash));
    expect(hashes.has(a.orderHash)).toBe(true);
    for (const m of snap.matches) expect(hashes.has(m.makerHash) && hashes.has(m.takerHash)).toBe(true);
    for (const o of snap.orders) {
      const inMatches = snap.matches.filter((m) => m.makerHash === o.hash || m.takerHash === o.hash).reduce((s, m) => s + m.fillSize, 0n);
      expect(o.pending).toBe(inMatches);
      expect(o.remaining + o.pending + o.filled).toBeLessThanOrEqual(o.order.size);
    }
    store.close();
    // and an engine starts from it without complaint
    const p2 = boot(copy, w);
    await p2.engine.recover();
    expect(p2.engine.getOrder(a.orderHash)).toBeDefined();
    expect([undefined, "open"]).toContain(p2.engine.getOrder(b.orderHash)?.status);

    // cutting right after the first commit leaves exactly the first order
    const copy2 = dbPath();
    copyFileSync(path, copy2);
    copyFileSync(`${path}-wal`, `${copy2}-wal`);
    truncateSync(`${copy2}-wal`, sizeAfterFirst + 100);
    const s2 = new SqliteStore(copy2);
    expect(s2.load().orders.map((o) => o.hash)).toEqual([a.orderHash]);
    s2.close();
  });

  it("if the store refuses a write, the client is told and intake halts until writes work again", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const commit = p1.store.commit.bind(p1.store);
    p1.store.commit = () => {
      throw new Error("disk full");
    };
    const e = await p1.place(alice, true, 100, 1).catch((x) => x);
    expect(e).toMatchObject({ code: "STORE_UNAVAILABLE", httpStatus: 503 });
    expect(await code(p1.place(bob, true, 100, 1))).toBe("STORE_UNAVAILABLE");
    p1.store.commit = commit;
    p1.engine.sweepExpired(); // any later flush writes what was held back
    expect(await code(p1.place(bob, true, 99, 1))).toBe("OK");
    const other = new SqliteStore(path);
    expect(other.load().orders).toHaveLength(2);
    other.close();
  });

  it("finished orders are forgotten after their expiry, in memory and on disk", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w, { expiryBufferSec: 0 });
    const done = await p1.place(alice, false, 100, 1, { expiry: 1100n });
    await p1.place(bob, true, 100, 1, { expiry: 1100n });
    const live = await p1.place(carol, true, 90, 1);
    await p1.engine.idle();
    w.now = 1099;
    p1.engine.pruneFinished();
    expect(p1.engine.getOrder(done.orderHash)).toBeDefined();
    w.now = 1100;
    p1.engine.pruneFinished();
    expect(p1.engine.getOrder(done.orderHash)).toBeUndefined();
    expect(p1.engine.getOrder(live.orderHash)).toBeDefined();
    const other = new SqliteStore(path);
    expect(other.load().orders.map((o) => o.hash)).toEqual([live.orderHash]);
    other.close();
  });
});

describe("cancelAllOrders (minValidNonce)", () => {
  it("removes the trader's resting orders below the nonce, refuses them later, and survives a restart", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    const low1 = await p1.place(alice, true, 100, 1, { nonce: 10n });
    const low2 = await p1.place(alice, false, 104, 1, { nonce: 11n });
    const high = await p1.place(alice, true, 99, 1, { nonce: 2_000_000n });
    const other = await p1.place(bob, true, 98, 1, { nonce: 12n });
    p1.engine.cancelBelow(alice.address, 1000n);
    expect(p1.engine.getOrder(low1.orderHash)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(/cancelAllOrders/) });
    expect(p1.engine.getOrder(low2.orderHash)!.status).toBe("cancelled");
    expect(p1.engine.getOrder(high.orderHash)!.status).toBe("open");
    expect(p1.engine.getOrder(other.orderHash)!.status).toBe("open");
    expect(p1.engine.getOrderBook(1, 10)).toMatchObject({ bids: [{ price: wad(99) }, { price: wad(98) }], asks: [] });
    expect(await code(p1.place(alice, true, 100, 1, { nonce: 999n }))).toBe("NONCE_CANCELLED");
    expect(await code(p1.place(alice, true, 97, 1, { nonce: 1000n }))).toBe("OK");
    // a lower value later never lowers it
    p1.engine.cancelBelow(alice.address, 5n);
    expect(await code(p1.place(alice, true, 100, 1, { nonce: 998n }))).toBe("NONCE_CANCELLED");

    const p2 = boot(path, w, { preTradeChecks: false });
    await p2.engine.recover();
    expect(await code(p2.place(alice, true, 100, 1, { nonce: 997n }))).toBe("NONCE_CANCELLED");
  });

  it("an order whose nonce is below minValidNonce on-chain is refused at intake and is a definitive cause of failure", async () => {
    const path = dbPath();
    const w = world();
    const p1 = boot(path, w);
    w.chain.minValid.set(alice.address.toLowerCase(), 1000n);
    expect(await code(p1.place(alice, true, 100, 1, { nonce: 5n }))).toBe("NONCE_CANCELLED"); // engine has not seen the event; the chain view says so
    // maker bulk-cancels on-chain while its order rests and before the engine sees the event
    const maker = await p1.place(carol, false, 100, 1, { nonce: 7n });
    w.chain.minValid.set(carol.address.toLowerCase(), 1000n);
    w.settler.failWhen = () => "0xe3cc7933"; // OrderIsCancelled()
    const taker = await p1.place(bob, true, 100, 1);
    await p1.engine.idle();
    expect(p1.engine.getOrder(maker.orderHash)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/cancelled on-chain/) });
    expect(p1.engine.getOrder(taker.orderHash)).toMatchObject({ status: "open", remaining: wad(1) }); // innocent: restored
  });
});

describe("graceful shutdown", () => {
  it("refuses new orders at once, lets the in-flight batch resolve, and leaves a consistent store", async () => {
    const path = dbPath();
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.settler.beforeSettle = () => gate;
    const p1 = boot(path, w);
    const maker = await p1.place(alice, false, 100, 1);
    await p1.place(bob, true, 100, 1);
    const stopping = p1.engine.stop(2000);
    expect(await p1.place(carol, true, 100, 1).catch((x) => x)).toMatchObject({ code: "SHUTTING_DOWN", httpStatus: 503 });
    // cancels are still honoured while draining
    setTimeout(release, 20);
    await stopping;
    expect(w.settler.settled).toHaveLength(1);
    p1.store.close();
    const p2 = boot(path, w);
    expect(p2.engine.getOrder(maker.orderHash)).toMatchObject({ status: "filled", pending: 0n });
    expect(p2.engine.settlementStatus()).toMatchObject({ queued: 0, inFlight: 0 });
  });

  it("gives up waiting after the timeout; the unresolved batch is picked up by the next start", async () => {
    const path = dbPath();
    const w = world();
    w.settler.beforeSettle = () => new Promise<void>(() => {});
    const p1 = boot(path, w);
    const maker = await p1.place(alice, false, 100, 1);
    await p1.place(bob, true, 100, 1);
    const t0 = Date.now();
    await p1.engine.stop(30);
    expect(Date.now() - t0).toBeLessThan(1500);
    w.settler.beforeSettle = () => {};
    const p2 = boot(path, w);
    await p2.engine.recover();
    expect(p2.engine.getOrder(maker.orderHash)!.status).toBe("filled");
    expect(w.settler.settled).toHaveLength(1);
  });
});

describe("store", () => {
  it("round-trips every field, including 256-bit values", () => {
    const store = new SqliteStore(":memory:");
    const order = makeOrder(alice, true, 100, 1, { size: 2n ** 255n, limitPrice: 2n ** 200n + 7n, nonce: 2n ** 256n - 1n });
    const hash = hashOrder(DOMAIN, order);
    store.commit({
      orders: [{ hash, order, signature: "0xabcd", postOnly: true, ioc: false, seq: 2n ** 70n, createdAt: 5, remaining: 2n ** 254n, pending: 3n, filled: 4n, userCancelled: true, strikes: 2, closed: { status: "rejected", reason: "why" } }],
      addMatches: [{ id: "m12", marketId: 1, makerHash: hash, takerHash: hash, fillSize: 2n ** 128n, price: 2n ** 129n, batchId: null }],
      batched: { batchId: "b3", ids: ["m12"] },
      removeMatches: [],
      trades: [{ id: "t1", marketId: 1, price: 2n ** 100n, size: 9n, takerIsBuy: true, maker: alice.address, taker: bob.address, makerOrderHash: hash, takerOrderHash: hash, txHash: "0x01", timestamp: 77 }],
      minValidNonces: [{ trader: alice.address, nonce: 2n ** 80n }],
      meta: { k: "v" },
    });
    const snap = store.load();
    expect(snap.orders[0]).toEqual({ hash, order, signature: "0xabcd", postOnly: true, ioc: false, seq: 2n ** 70n, createdAt: 5, remaining: 2n ** 254n, pending: 3n, filled: 4n, userCancelled: true, strikes: 2, closed: { status: "rejected", reason: "why" } });
    expect(snap.matches).toEqual([{ id: "m12", marketId: 1, makerHash: hash, takerHash: hash, fillSize: 2n ** 128n, price: 2n ** 129n, batchId: "b3" }]);
    expect(snap.trades[0]).toMatchObject({ price: 2n ** 100n, size: 9n, txHash: "0x01" });
    expect(snap.minValidNonces).toEqual([{ trader: alice.address.toLowerCase(), nonce: 2n ** 80n }]);
    expect(store.getMeta("k")).toBe("v");
    store.close();
  });

  it("a commit is all or nothing", () => {
    const store = new SqliteStore(":memory:");
    const order = makeOrder(alice, true, 100, 1);
    const good = { hash: hashOrder(DOMAIN, order), order, signature: "0x" as const, postOnly: false, ioc: false, seq: 1n, createdAt: 1, remaining: 1n, pending: 0n, filled: 0n, userCancelled: false, strikes: 0 };
    const bad = { ...good, hash: null as never };
    expect(() => store.commit({ orders: [good, bad], addMatches: [], batched: null, removeMatches: [], trades: [], minValidNonces: [], meta: { x: "1" } })).toThrow();
    expect(store.load().orders).toEqual([]);
    expect(store.getMeta("x")).toBeUndefined();
    store.close();
  });
});
