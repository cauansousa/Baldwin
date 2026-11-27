// Keeper inventory unwind, keeper observability, and the funding / insurance figures in the API.
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.ts";
import { loadKeeperConfig } from "../src/config.ts";
import { EngineError, type Engine } from "../src/engine/engine.ts";
import { Keeper, type KeeperChain } from "../src/keeper/keeper.ts";
import { keeperServer } from "../src/keeper/server.ts";
import { httpEngineClient, Unwinder, type EngineClient, type EngineReply } from "../src/keeper/unwinder.ts";
import { Metrics } from "../src/metrics.ts";
import { hashOrder } from "../src/signing.ts";
import type { Hex, Order } from "../src/types.ts";
import { alice, bob, carol, DOMAIN, harness, MARKET, wad, type Harness } from "./helpers.ts";

const keeperAcct = carol;
const KEY = `${keeperAcct.address.toLowerCase()}:1`;

/** EngineClient that talks to an Engine in this process, mapping errors as the HTTP API does. */
function inProcess(engine: Engine) {
  const calls = { submit: [] as Order[], cancel: [] as Hex[] };
  const state = { down: false };
  const wrap = async <T>(fn: () => Promise<T>): Promise<EngineReply<T>> => {
    if (state.down) return { ok: false, code: "NO_ANSWER", outcome: "unknown", message: "connect ECONNREFUSED" };
    try {
      return { ok: true, body: await fn() };
    } catch (e) {
      if (e instanceof EngineError) return { ok: false, code: e.code, outcome: e.outcome, message: e.message };
      throw e;
    }
  };
  const client: EngineClient = {
    minOrderSizes: () => wrap(async () => new Map(engine.getMarkets().map((m) => [m.marketId, m.minOrderSize]))),
    time: () => wrap(async () => engine.engineTime()),
    openOrders: (trader) =>
      wrap(async () => engine.getOpenOrders(trader).map((v) => ({ orderHash: v.orderHash, order: v.order, status: v.status, remaining: v.remaining, pending: v.pending, filled: v.filled }))),
    submit: (order, signature) => (calls.submit.push(order), wrap(() => engine.submit({ order, signature }))),
    cancel: (hash, signature, trader, nonce) => (calls.cancel.push(hash), wrap(() => engine.cancel(hash, signature, { trader, nonce }))),
  };
  return { client, calls, state };
}

function setup(h: Harness = harness({ withChain: true })) {
  const eng = inProcess(h.engine);
  const unwinder = new Unwinder({
    chain: {
      positionSize: async () => h.chain.positions.get(KEY) ?? 0n,
      indexPrice: () => h.chain.indexPrice(),
    },
    engine: eng.client,
    account: keeperAcct,
    domain: DOMAIN,
    marketIds: [1],
    offsetBps: 10n,
    repriceBps: 20n,
    expirySec: 300,
    renewBeforeSec: 120,
    now: () => h.clock.now,
  });
  const resting = () => h.engine.getOpenOrders(keeperAcct.address);
  return { h, unwinder, resting, ...eng };
}

describe("unwinder", () => {
  it("keeps one reduce-only order per market that closes the position, priced through the index inside the band", async () => {
    const { h, unwinder, resting, calls } = setup();
    h.chain.positions.set(KEY, wad(2)); // long 2 taken over in a liquidation
    await unwinder.tick();
    expect(resting()).toHaveLength(1);
    const o = resting()[0]!;
    expect(o.order).toMatchObject({ isBuy: false, reduceOnly: true, size: wad(2), limitPrice: wad("99.9"), marketId: 1 });
    expect(o.order.expiry).toBe(1000n + 300n);
    expect(h.engine.getOrderBook(1, 5).asks).toEqual([{ price: wad("99.9"), size: wad(2) }]);
    // nothing changes: the same order stays, nothing new is signed
    await unwinder.tick();
    await unwinder.tick();
    expect(calls.submit).toHaveLength(1);
    expect(unwinder.status()[0]).toMatchObject({ position: wad(2), order: { orderHash: o.orderHash, state: "resting", isBuy: false }, note: null });
    // a short is bought back, above the index
    const other = setup();
    other.h.chain.positions.set(KEY, -wad(1));
    await other.unwinder.tick();
    expect(other.resting()[0]!.order).toMatchObject({ isBuy: true, reduceOnly: true, size: wad(1), limitPrice: wad("100.1") });
  });

  it("no position, no order; a position below the minimum order size is reported and left", async () => {
    const { h, unwinder, resting, calls } = setup();
    await unwinder.tick();
    expect(calls.submit).toEqual([]);
    h.chain.positions.set(KEY, MARKET.minOrderSize - 1n);
    await unwinder.tick();
    expect(resting()).toEqual([]);
    expect(unwinder.status()[0]!.note).toMatch(/below the minimum order size/);
  });

  it("replaces the order (cancel confirmed first) when the index moves, the position changes, or it nears expiry", async () => {
    const { h, unwinder, resting, calls } = setup();
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    const first = resting()[0]!.orderHash;
    // a move inside the threshold (never more than the offset: 10 bps) changes nothing
    h.chain.index = wad("100.05");
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting()[0]!.orderHash).toBe(first);
    // beyond it: re-priced
    h.chain.index = wad(101);
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(calls.cancel).toEqual([first]);
    expect(resting()).toHaveLength(1);
    expect(resting()[0]!.order.limitPrice).toBe(wad("100.899"));
    expect(h.engine.getOrder(first)!.status).toBe("cancelled");
    // position shrinks (part was closed elsewhere): re-sized
    const second = resting()[0]!.orderHash;
    h.chain.positions.set(KEY, wad(1));
    await unwinder.tick();
    expect(resting().map((o) => o.order.size)).toEqual([wad(1)]);
    expect(h.engine.getOrder(second)!.status).toBe("cancelled");
    // nearing expiry: renewed
    const third = resting()[0]!;
    h.chain.time = BigInt(h.clock.now + 181);
    h.clock.now += 181; // 119 s left of 300
    await unwinder.tick();
    expect(resting()).toHaveLength(1);
    expect(resting()[0]!.orderHash).not.toBe(third.orderHash);
    expect(resting()[0]!.order.expiry).toBe(BigInt(h.clock.now + 300));
    // position gone: order withdrawn, nothing new
    h.chain.positions.set(KEY, 0n);
    await unwinder.tick();
    expect(resting()).toEqual([]);
    expect(h.engine.getOrderBook(1, 5).asks).toEqual([]);
  });

  it("a taker fills it; after settlement the position is gone and nothing new is placed; the keeper is never at fault", async () => {
    const { h, unwinder, resting } = setup();
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    const t = await h.place(alice, true, 100, 2);
    expect(t.fills.map((f) => f.price)).toEqual([wad("99.9")]);
    await unwinder.tick(); // matched, not settled yet: on-chain position unchanged, order left alone
    await h.engine.idle();
    h.chain.positions.set(KEY, 0n); // what the settlement did on-chain
    await unwinder.tick();
    expect(resting()).toEqual([]);
    expect(h.settler.settled).toHaveLength(1);
    expect(h.settler.settled[0]!.maker.reduceOnly).toBe(true);
    expect(unwinder.status()[0]).toMatchObject({ position: 0n, order: null });
  });

  it("an aggressive unwind order takes resting liquidity like any order, and never matches the keeper's own", async () => {
    const { h, unwinder, resting } = setup();
    await h.place(alice, true, "99.95", 1); // a bid above the unwind price
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    await h.engine.idle();
    expect(h.settler.settled.map((m) => [m.taker.trader, m.price, m.fillSize])).toEqual([[keeperAcct.address, wad("99.95"), wad(1)]]);
    expect(resting().map((o) => o.remaining)).toEqual([wad(1)]); // the rest rests
    for (const m of h.settler.settled) expect(m.maker.trader).not.toBe(m.taker.trader);
  });

  it("engine down or answering 'unknown': the SAME signed order is sent again until there is a definite answer", async () => {
    const { h, unwinder, resting, calls, state } = setup();
    h.chain.positions.set(KEY, wad(2));
    state.down = true;
    await unwinder.tick(); // cannot even read the minimum size: nothing signed
    expect(calls.submit).toEqual([]);
    expect(unwinder.status()[0]!.note).toBe("engine unreachable");
    state.down = false;
    // the order reaches the engine, but the answer is lost
    const real = unwinder["opts"].engine.submit;
    let lose = true;
    unwinder["opts"].engine.submit = async (o, s) => {
      const r = await real(o, s);
      return lose ? { ok: false, code: "NO_ANSWER", outcome: "unknown", message: "timeout" } : r;
    };
    await unwinder.tick();
    expect(resting()).toHaveLength(1); // the engine has it
    expect(unwinder.status()[0]!.order).toMatchObject({ state: "unconfirmed" });
    await unwinder.tick();
    await unwinder.tick();
    lose = false;
    await unwinder.tick();
    expect(new Set(calls.submit.map((o) => hashOrder(DOMAIN, o))).size).toBe(1); // one order, sent four times
    expect(calls.submit).toHaveLength(4);
    expect(resting()).toHaveLength(1); // and only one in the book
    expect(unwinder.status()[0]!.order).toMatchObject({ state: "resting" });
  });

  it("an unconfirmed order that expired is dropped and replaced by a fresh one", async () => {
    const { h, unwinder, calls } = setup();
    h.chain.positions.set(KEY, wad(2));
    const real = unwinder["opts"].engine.submit;
    unwinder["opts"].engine.submit = async () => ({ ok: false, code: "NO_ANSWER", outcome: "unknown", message: "down" });
    await unwinder.tick();
    h.clock.now += 301;
    unwinder["opts"].engine.submit = real;
    await unwinder.tick();
    expect(calls.submit).toHaveLength(1); // only the fresh one went through the counting client
    expect(h.engine.getOpenOrders(keeperAcct.address)).toHaveLength(1);
  });

  it("'not_applied' answers (recovering, halted, paused-for-others, rate limit) are simply retried with a fresh order", async () => {
    const { h, unwinder, resting } = setup();
    h.chain.positions.set(KEY, wad(2));
    h.chain.indexFails = true; // market halted in the engine and for the unwinder
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting()).toEqual([]);
    expect(unwinder.status()[0]!.note).toBe("index price unavailable");
    h.chain.indexFails = false;
    // the engine has not noticed yet: it refuses with MARKET_HALTED (not_applied)
    await unwinder.tick();
    expect(unwinder.status()[0]!.note).toMatch(/MARKET_HALTED|refused/);
    await h.engine.refreshChainState();
    await unwinder.tick();
    expect(resting()).toHaveLength(1);
    // a paused exchange still takes the reduce-only order
    const p = setup();
    p.h.chain.positions.set(KEY, wad(1));
    p.h.chain.isPaused = true;
    await p.h.engine.refreshChainState();
    await p.unwinder.tick();
    expect(p.resting()).toHaveLength(1);
  });

  it("never asks for more than the position: with a fill still unsettled the engine's reduce-only cap refuses the replacement until it settles", async () => {
    const { h, unwinder, resting } = setup();
    let release!: () => void;
    h.settler.beforeSettle = () => new Promise<void>((r) => (release = r));
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    await h.place(alice, true, 100, 1); // half of it matched, settlement pending
    h.chain.index = wad(102); // forces a re-price while 1 is pending
    await h.engine.refreshChainState();
    await unwinder.tick();
    // old order cancelled; a new one for the full on-chain position (2) would exceed position - pending
    expect(resting().filter((o) => o.remaining > 0n)).toEqual([]);
    expect(unwinder.status()[0]!.note).toMatch(/REDUCE_ONLY_EXCEEDS_POSITION/);
    release();
    await h.engine.idle();
    h.chain.positions.set(KEY, wad(1));
    await unwinder.tick();
    expect(resting().map((o) => [o.order.size, o.order.reduceOnly])).toEqual([[wad(1), true]]);
  });

  it("shutdown cancels what is resting and places nothing afterwards", async () => {
    const { h, unwinder, resting } = setup();
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    expect(resting()).toHaveLength(1);
    await unwinder.shutdown();
    expect(resting()).toEqual([]);
    await unwinder.tick();
    expect(resting()).toEqual([]);
  });

  it("the keeper withdraws its order before taking over another position in that market", async () => {
    const { h, unwinder, resting } = setup();
    h.chain.positions.set(KEY, wad(2));
    await unwinder.tick();
    const order: string[] = [];
    const chain: KeeperChain = {
      blockNumber: async () => 10n,
      touchedPositions: async (from, to) => (from <= 5n && to >= 5n ? [{ trader: alice.address, marketId: 1 }] : []),
      positionSize: async () => 5n,
      isLiquidatable: async () => true,
      isLiquidatableIn: async () => true,
      liquidate: async () => {
        order.push(`liquidate (resting unwind orders: ${resting().length})`);
      },
      ownFreeCollateral: async () => 10n ** 12n,
      indexPrice: async () => wad(100),
      initialMarginBps: async () => 2000n,
      updateFunding: async () => {},
      lastFundingTime: async () => 10n ** 12n,
      blockTimestamp: async () => 1n,
    };
    const keeper = new Keeper({ chain, marketIds: [1], headLag: 0n, beforeLiquidate: (m) => unwinder.withdraw(m) });
    await keeper.tick();
    expect(order).toEqual(["liquidate (resting unwind orders: 0)"]);
    expect(keeper.status()).toMatchObject({ liquidations: 1, liquidationFailures: 0, lastLiquidation: { trader: alice.address, marketId: 1, size: 5n } });
    // a failing withdrawal does not stop the liquidation
    const k2 = new Keeper({
      chain,
      marketIds: [1],
      headLag: 0n,
      beforeLiquidate: async () => {
        throw new Error("engine down");
      },
    });
    await k2.tick();
    expect(order).toHaveLength(2);
  });

  it("is on by default and can be switched off; ENGINE_URL is validated", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = join(mkdtempSync(join(tmpdir(), "foxy-kcfg-")), "d.json");
    writeFileSync(f, JSON.stringify({ chainId: 31337, exchange: alice.address, usdc: bob.address, oracle: carol.address, markets: [] }));
    const env = { KEEPER_PRIVATE_KEY: "0x" + "22".repeat(32), DEPLOYMENT_PATH: f };
    expect(loadKeeperConfig(env)).toMatchObject({ unwind: true, engineUrl: "http://127.0.0.1:8080", unwindOffsetBps: 10n, port: 0 });
    expect(loadKeeperConfig({ ...env, KEEPER_UNWIND: "false", KEEPER_PORT: "9100", ENGINE_URL: "https://engine.example" })).toMatchObject({ unwind: false, port: 9100, engineUrl: "https://engine.example" });
    expect(() => loadKeeperConfig({ ...env, ENGINE_URL: "engine:8080" })).toThrow(/ENGINE_URL/);
  });
});

describe("httpEngineClient follows the engine's error contract", () => {
  it("maps answers to ok / not_applied / unknown, and no answer to unknown", async () => {
    const h = harness({ withChain: true });
    const app = await buildServer(h.engine);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const client = httpEngineClient(`http://127.0.0.1:${port}/`);
    expect(await client.minOrderSizes()).toEqual({ ok: true, body: new Map([[1, MARKET.minOrderSize]]) });
    h.chain.positions.set(KEY, wad(1));
    const unwinder = new Unwinder({ chain: { positionSize: async () => h.chain.positions.get(KEY) ?? 0n, indexPrice: () => h.chain.indexPrice() }, engine: client, account: keeperAcct, domain: DOMAIN, marketIds: [1], now: () => h.clock.now });
    await unwinder.tick();
    expect(h.engine.getOpenOrders(keeperAcct.address)).toHaveLength(1);
    expect(unwinder.status()[0]!.order).toMatchObject({ state: "resting" });
    // a refusal carries its code and outcome
    const o = h.engine.getOpenOrders(keeperAcct.address)[0]!;
    const bad = await client.submit({ ...o.order, size: o.order.size + 1n }, `0x${"11".repeat(65)}`);
    expect(bad).toMatchObject({ ok: false, outcome: "not_applied" });
    // shutdown cancels over HTTP (DELETE with trader and nonce)
    await unwinder.shutdown();
    expect(h.engine.getOpenOrders(keeperAcct.address)).toEqual([]);
    await app.close();
    // engine gone: unknown
    expect(await client.submit(o.order, `0x${"11".repeat(65)}`)).toMatchObject({ ok: false, code: "NO_ANSWER", outcome: "unknown" });
  });
});

describe("keeper observability", () => {
  it("serves /health and /metrics with labelled gauges", async () => {
    const metrics = new Metrics("foxy_keeper_");
    metrics.gauge("tracked_accounts", "Accounts watched", () => 3);
    metrics.gauge("position", "Position held, by market", () => [{ labels: { market: "0" }, value: 0.2 }, { labels: { market: "1" }, value: -1.5 }]);
    metrics.gauge("nothing", "omitted", () => []);
    let ok = true;
    const server = keeperServer({ health: () => ({ ok, trackedAccounts: 3, freeCollateral: 5n, lastLiquidation: null, unwind: [{ marketId: 0, position: 2n * 10n ** 17n, order: null, note: null }] }), metrics });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, trackedAccounts: 3, freeCollateral: "5", lastLiquidation: null, unwind: [{ marketId: 0, position: "200000000000000000", order: null, note: null }] });
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(text).toContain("foxy_keeper_tracked_accounts 3\n");
    expect(text).toContain('# TYPE foxy_keeper_position gauge\nfoxy_keeper_position{market="0"} 0.2\nfoxy_keeper_position{market="1"} -1.5\n');
    expect(text).not.toContain("nothing");
    ok = false;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" })).status).toBe(405);
    await new Promise((r) => server.close(r));
  });
});

describe("funding, open interest, insurance fund and bad debt in the API", () => {
  it("/markets carries the per-market figures, /health the exchange-wide ones; views that revert give null", async () => {
    const h = harness({ withChain: true, statsRefreshMs: 0, fundingIntervalSec: 3600 });
    h.chain.twap = wad("100.5");
    h.chain.fundingRate = -(10n ** 14n);
    h.chain.lastFunding = 900n;
    h.chain.oi = { longs: wad(7), shorts: wad(7) };
    h.chain.insurance = 1_234_000_000n;
    await h.engine.refreshChainState();
    await h.engine.refreshStats();
    const app = await buildServer(h.engine);
    const m = (await app.inject({ url: "/markets" })).json()[0];
    expect(m).toMatchObject({
      marketId: 1,
      indexPrice: wad(100).toString(),
      markTwap: wad("100.5").toString(),
      currentFundingRate: "-100000000000000",
      lastFundingTime: "900",
      nextFundingTime: "4500",
      openInterestLong: wad(7).toString(),
      openInterestShort: wad(7).toString(),
    });
    let health = (await app.inject({ url: "/health" })).json();
    expect(health).toMatchObject({ ok: true, insuranceFund: "1234000000", totalBadDebt: "0", warnings: [] });
    const first = (await app.inject({ url: "/metrics" })).body;
    expect(first).toContain("\nfoxy_insurance_fund_usdc 1234\n");
    expect(first).toContain("\nfoxy_total_bad_debt_usdc 0\n");

    // bad debt appears; some views start reverting (oracle trouble)
    h.chain.badDebt = 5_000_000n;
    h.chain.failing = new Set(["markTwap", "currentFundingRate", "insuranceFund"]);
    await h.engine.refreshStats();
    health = (await app.inject({ url: "/health" })).json();
    expect(health.insuranceFund).toBeNull();
    expect(health.totalBadDebt).toBe("5000000");
    expect(health.warnings).toEqual([expect.stringMatching(/bad debt of 5000000/)]);
    expect(health.ok).toBe(true); // a warning, not an outage
    expect((await app.inject({ url: "/markets" })).json()[0]).toMatchObject({ markTwap: null, currentFundingRate: null, lastFundingTime: "900", openInterestLong: wad(7).toString() });
    const metrics = (await app.inject({ url: "/metrics" })).body;
    expect(metrics).toContain("foxy_total_bad_debt_usdc 5\n");
    expect(metrics).not.toContain("foxy_insurance_fund_usdc ");
    // matching is unaffected by those views
    await h.place(alice, false, 100, 1);
    expect((await h.place(bob, true, 100, 1)).fills).toHaveLength(1);
    await app.close();
  });

  it("markTwap and the funding rate are reported as unknown (null) while the index is unavailable: the contract returns 0 then", async () => {
    const h = harness({ withChain: true, statsRefreshMs: 0 });
    h.chain.twap = wad(101);
    h.chain.fundingRate = 5n;
    await h.engine.refreshChainState();
    await h.engine.refreshStats();
    expect(h.engine.getMarkets()[0]).toMatchObject({ markTwap: wad(101), currentFundingRate: 5n });
    h.chain.indexFails = true;
    h.chain.twap = 0n;
    h.chain.fundingRate = 0n;
    await h.engine.refreshChainState();
    await h.engine.refreshStats();
    expect(h.engine.getMarkets()[0]).toMatchObject({ indexPrice: null, markTwap: null, currentFundingRate: null });
    // a genuine zero rate with a live index stays a zero
    h.chain.indexFails = false;
    h.chain.twap = wad(100);
    await h.engine.refreshChainState();
    await h.engine.refreshStats();
    expect(h.engine.getMarkets()[0]).toMatchObject({ markTwap: wad(100), currentFundingRate: 0n });
  });

  it("without a chain reader the fields exist and are null", async () => {
    const h = harness();
    expect(h.engine.getMarkets()[0]).toMatchObject({ indexPrice: null, markTwap: null, currentFundingRate: null, nextFundingTime: null, openInterestLong: null });
    expect(h.engine.exchangeStats()).toEqual({ insuranceFund: null, totalBadDebt: null });
  });
});
