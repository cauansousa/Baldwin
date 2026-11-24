// Chain watching, metrics, health and keeper persistence.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeErrorResult } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { exchangeAbi } from "../src/abi.ts";
import { buildServer } from "../src/api/server.ts";
import { applyCancelEvents } from "../src/chain/cancelWatcher.ts";
import { LogPoller } from "../src/chain/logPoller.ts";
import { loadEngineConfig, loadKeeperConfig } from "../src/config.ts";
import { Keeper } from "../src/keeper/keeper.ts";
import { FileKeeperState } from "../src/keeper/state.ts";
import { Metrics } from "../src/metrics.ts";
import { createLogger, silentLogger } from "../src/types.ts";
import { alice, bob, carol, harness, wad } from "./helpers.ts";

const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "baldwin-ops-")), name);

describe("LogPoller", () => {
  function setup(opts: { cursor?: bigint; startBlock?: bigint; maxRange?: bigint; overlap?: bigint } = {}) {
    const w = {
      head: 100n,
      saved: opts.cursor as bigint | undefined,
      queries: [] as [bigint, bigint][],
      handled: [] as number[],
      events: new Map<bigint, number>(), // block -> event id
      failFetch: (_from: bigint, _to: bigint): boolean => false,
      failHandle: false,
    };
    const make = () =>
      new LogPoller<number>({
        name: "test",
        head: async () => w.head,
        fetch: async (from, to) => {
          w.queries.push([from, to]);
          if (w.failFetch(from, to)) throw new Error("query returned more than 10000 results");
          return [...w.events].filter(([b]) => b >= from && b <= to).map(([, id]) => id);
        },
        handle: (events) => {
          if (w.failHandle) throw new Error("handler failed");
          w.handled.push(...events);
        },
        loadCursor: () => w.saved,
        saveCursor: (b) => (w.saved = b),
        startBlock: opts.startBlock,
        maxRange: opts.maxRange ?? 1000n,
        minRange: 10n,
        overlap: opts.overlap,
        maxBackoffMs: 5,
      });
    return { w, make, poller: make() };
  }

  it("first start without a cursor begins at the current head; later blocks are scanned once", async () => {
    const { w, poller } = setup();
    w.events.set(50n, 1); // before the engine existed: not its concern
    await poller.poll();
    expect(w.queries).toEqual([]);
    expect(w.saved).toBe(100n);
    w.head = 103n;
    w.events.set(102n, 2);
    await poller.poll();
    expect(w.queries).toEqual([[101n, 103n]]);
    expect(w.handled).toEqual([2]);
    await poller.poll();
    expect(w.queries).toHaveLength(1); // nothing new: no query
  });

  it("a restart continues from the stored cursor and misses nothing that happened while it was down", async () => {
    const { w, make, poller } = setup();
    await poller.poll(); // cursor 100
    w.events.set(150n, 7); // happens while the process is down
    w.head = 400n;
    const restarted = make();
    await restarted.poll();
    expect(w.queries).toEqual([[101n, 400n]]);
    expect(w.handled).toEqual([7]);
    expect(w.saved).toBe(400n);
  });

  it("splits long gaps into ranges, shrinks the range when the provider refuses, and grows it back", async () => {
    const { w, poller } = setup({ cursor: 0n, maxRange: 400n });
    w.head = 1000n;
    w.failFetch = (from, to) => to - from + 1n > 100n; // provider limit: 100 blocks
    await expect(poller.poll()).rejects.toThrow(/10000 results/); // 400 refused -> next try 200
    await expect(poller.poll()).rejects.toThrow(); // 200 refused -> next try 100
    await expect(poller.poll()).rejects.toThrow(); // 1..100 ok, then grows to 200: refused -> back to 100
    expect(w.saved).toBe(100n); // progress made so far is kept
    w.failFetch = () => false;
    await poller.poll();
    expect(w.saved).toBe(1000n);
    const spans = w.queries.map(([a, b]) => b - a + 1n);
    expect(spans.slice(0, 4)).toEqual([400n, 200n, 100n, 200n]);
    expect(spans.at(-1)! <= 400n).toBe(true);
    // every block was covered exactly by the successful queries
    expect(w.queries.filter(([a]) => a === 101n).length).toBeGreaterThanOrEqual(1);
  });

  it("does not advance the cursor past a range whose handler failed", async () => {
    const { w, poller } = setup({ cursor: 10n });
    w.head = 20n;
    w.events.set(15n, 1);
    w.failHandle = true;
    await expect(poller.poll()).rejects.toThrow(/handler failed/);
    expect(w.saved).toBe(10n);
    w.failHandle = false;
    await poller.poll();
    expect(w.handled).toEqual([1]);
    expect(w.saved).toBe(20n);
  });

  it("catchUp retries with backoff until a pass succeeds", async () => {
    const { w, poller } = setup({ cursor: 10n });
    w.head = 20n;
    let failures = 2;
    w.failFetch = () => failures-- > 0;
    await poller.catchUp(5, 1);
    expect(w.saved).toBe(20n);
    w.head = 30n;
    w.failFetch = () => true;
    await expect(poller.catchUp(2, 1)).rejects.toThrow();
  });

  it("re-scans the last blocks when an overlap is configured (shallow reorgs)", async () => {
    const { w, poller } = setup({ cursor: 100n, overlap: 3n });
    w.head = 101n;
    await poller.poll();
    expect(w.queries).toEqual([[98n, 101n]]);
  });

  it("START_BLOCK is honoured when there is no cursor", async () => {
    const { w, poller } = setup({ startBlock: 40n });
    w.events.set(50n, 1);
    await poller.poll();
    expect(w.queries[0]![0]).toBe(40n);
    expect(w.handled).toEqual([1]);
  });
});

describe("on-chain cancel events", () => {
  it("OrderCancelled and OrdersCancelledBelow remove resting orders; applying them twice is harmless", async () => {
    const h = harness();
    const a = await h.place(alice, true, 100, 1, { order: { nonce: 10n } });
    const b = await h.place(bob, true, 99, 1, { order: { nonce: 20n } });
    const c = await h.place(bob, true, 98, 1, { order: { nonce: 5_000n } });
    const events = [
      { kind: "nonce" as const, trader: alice.address, nonce: 10n },
      { kind: "below" as const, trader: bob.address, minValidNonce: 1000n },
    ];
    applyCancelEvents(h.engine, events, silentLogger);
    applyCancelEvents(h.engine, events, silentLogger);
    expect(h.engine.getOrder(a.orderHash)).toMatchObject({ status: "cancelled", reason: "cancelled on-chain" });
    expect(h.engine.getOrder(b.orderHash)!.status).toBe("cancelled");
    expect(h.engine.getOrder(c.orderHash)!.status).toBe("open");
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([{ price: wad(98), size: wad(1) }]);
    expect(h.engine.metrics.get("orders_cancelled_total")).toBe(2);
  });
});

describe("oracle failures (Chainlink adapter errors)", () => {
  it.each(["SequencerDown", "SequencerGracePeriodNotOver", "FeedStale", "InvalidAnswer", "FeedNotSet"] as const)("%s in MatchFailed is a global condition: no strike, nobody blamed", async (errorName) => {
    const h = harness({ withChain: true, maxOrderStrikes: 1, faultThreshold: 1 });
    const maker = await h.place(alice, true, 100, 5);
    const args = errorName === "FeedStale" ? [1, 123n] : errorName === "InvalidAnswer" || errorName === "FeedNotSet" ? [1] : [];
    h.settler.failWhen = () => encodeErrorResult({ abi: exchangeAbi, errorName, args } as never);
    const taker = await h.place(bob, false, 100, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(5) });
    expect(h.engine.getOrder(taker.orderHash)!.status).toBe("cancelled");
    h.settler.failWhen = () => null;
    await h.place(bob, false, 100, 1, { ioc: true }); // bob is not suspended
    await h.engine.idle();
    expect(h.settler.settled).toHaveLength(1);
  });

  it("account views reverting during fault attribution (oracle down for another market) is a global condition too", async () => {
    const h = harness({ withChain: true, maxOrderStrikes: 1 });
    const maker = await h.place(alice, true, 100, 5);
    h.settler.failWhen = () => "0x5863f789";
    h.settler.beforeSettle = () => {
      h.chain.freeCollateral = async () => {
        throw new Error("FeedStale");
      };
    };
    await h.place(bob, false, 100, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(5) });
  });

  it("views reverting halt the market and fail pre-trade checks with 503; the engine keeps running and recovers", async () => {
    const h = harness({ withChain: true });
    const resting = await h.place(alice, true, 100, 1);
    h.chain.indexFails = true;
    await h.engine.refreshChainState(); // must not throw
    expect(h.engine.chainStatus()!.markets[0]!.indexPrice).toBeNull();
    expect(await h.place(bob, false, 100, 1).catch((e) => e)).toMatchObject({ httpStatus: 503 });
    expect(h.engine.getOrder(resting.orderHash)!.status).toBe("open"); // resting orders are kept
    h.chain.indexFails = false;
    h.chain.freeCollateral = async () => {
      throw new Error("SequencerDown");
    };
    await h.engine.refreshChainState();
    expect(await h.place(bob, false, 100, 1).catch((e) => e)).toMatchObject({ code: "CHAIN_UNAVAILABLE", httpStatus: 503 });
  });
});

describe("metrics and health", () => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("renders Prometheus text: counters with labels, gauges, histogram", () => {
    const m = new Metrics();
    m.counter("a_total", "help a");
    m.inc("b_total", { code: 'X"Y' });
    m.inc("b_total", { code: 'X"Y' }, 2);
    m.gauge("g", "help g", () => 1.5);
    m.gauge("hidden", "never", () => null);
    m.histogram("h_seconds", "help h", [1, 5]);
    m.observe("h_seconds", 0.5);
    m.observe("h_seconds", 3);
    m.observe("h_seconds", 30);
    const text = m.render();
    expect(text).toContain("# TYPE baldwin_a_total counter\nbaldwin_a_total 0\n");
    expect(text).toContain('baldwin_b_total{code="X\\"Y"} 3\n');
    expect(text).toContain("# TYPE baldwin_g gauge\nbaldwin_g 1.5\n");
    expect(text).not.toContain("hidden");
    expect(text).toContain('baldwin_h_seconds_bucket{le="1"} 1\nbaldwin_h_seconds_bucket{le="5"} 2\nbaldwin_h_seconds_bucket{le="+Inf"} 3\nbaldwin_h_seconds_sum 33.5\nbaldwin_h_seconds_count 3\n');
  });

  it("GET /metrics exposes order, match, batch and queue metrics", async () => {
    const h = harness();
    const app = await buildServer(h.engine);
    close = () => app.close();
    h.engine.metrics.gauge("operator_balance_eth", "ETH balance of the operator account", () => 0.25);
    await h.place(alice, false, 100, 2);
    await h.place(bob, true, 100, 1);
    await h.place(bob, true, 0, 1).catch(() => {});
    h.settler.failWhen = () => "0xdeadbeef";
    await h.place(carol, true, 100, 1);
    await h.engine.idle();
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
    const body = res.body;
    expect(body).toContain("baldwin_orders_accepted_total 3\n");
    expect(body).toContain('baldwin_orders_rejected_total{code="INVALID_ORDER"} 1\n');
    expect(body).toContain("baldwin_matches_settled_total 1\n");
    expect(body).toContain("baldwin_matches_failed_total 1\n");
    expect(body).toContain("baldwin_batches_total 2\n");
    expect(body).toContain("baldwin_batch_latency_seconds_count 2\n");
    expect(body).toContain("baldwin_settlement_queue_depth 0\n");
    expect(body).toContain("baldwin_operator_balance_eth 0.25\n");
    expect(body).toContain("baldwin_resting_orders 1\n");
    for (const line of body.trim().split("\n")) expect(line).toMatch(/^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[0-9.e+-]+)$/);
  });

  it("GET /health carries operator balance and warnings supplied by the process, plus its own", async () => {
    const h = harness({ withChain: true });
    let balance = 5n * 10n ** 16n;
    const app = await buildServer(h.engine, {
      info: () => ({ operatorBalanceWei: balance, warnings: balance < 10n ** 16n ? ["operator ETH balance is low"] : [] }),
    });
    close = () => app.close();
    await h.engine.refreshChainState();
    expect((await app.inject({ url: "/health" })).json()).toMatchObject({ ok: true, operatorBalanceWei: "50000000000000000", warnings: [] });
    balance = 1n;
    h.chain.isPaused = true;
    h.chain.indexFails = true;
    await h.engine.refreshChainState();
    const body = (await app.inject({ url: "/health" })).json();
    expect(body.warnings).toEqual(["operator ETH balance is low", "exchange is paused", "no index price for market 1: market halted"]);
  });
});

describe("logging and config", () => {
  it("logs are one JSON object per line with level, time, component and context; levels filter", () => {
    const out: string[] = [];
    const err: string[] = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (out.push(s), true)) as never;
    process.stderr.write = ((s: string) => (err.push(s), true)) as never;
    try {
      const log = createLogger("warn", "engine");
      log.info("hidden");
      log.warn("careful", { n: 5n, nested: { x: 1 } });
      log.error("bad");
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
    expect(out).toEqual([]);
    expect(err).toHaveLength(2);
    const first = JSON.parse(err[0]!);
    expect(first).toMatchObject({ level: "warn", component: "engine", msg: "careful", n: "5", nested: { x: 1 } });
    expect(Date.parse(first.time)).not.toBeNaN();
    expect(err[0]!.endsWith("\n")).toBe(true);
  });

  it("chain and paths come from env and the deployment file; nothing is tied to a local chain", () => {
    const dep = tmp("arbitrumSepolia.json");
    writeFileSync(dep, JSON.stringify({ chainId: 421614, exchange: alice.address, usdc: bob.address, oracle: carol.address, markets: [{ marketId: 0, symbol: "BTC-USD" }] }));
    const env = {
      RPC_URL: "https://sepolia-rollup.arbitrum.io/rpc",
      DEPLOYMENT_PATH: dep,
      OPERATOR_PRIVATE_KEY: "0x" + "11".repeat(32),
      KEEPER_PRIVATE_KEY: "0x" + "22".repeat(32),
      CONFIRMATIONS: "3",
      OPERATOR_MIN_BALANCE_ETH: "0.005",
      LOG_LEVEL: "warn",
      START_BLOCK: "123456",
      LOG_MAX_BLOCK_RANGE: "500",
    };
    const cfg = loadEngineConfig(env);
    expect(cfg).toMatchObject({ rpcUrl: env.RPC_URL, confirmations: 3, operatorMinBalance: 5n * 10n ** 15n, logLevel: "warn", startBlock: 123456n, logMaxBlockRange: 500n });
    expect(cfg.deployment.chainId).toBe(421614);
    expect(cfg.storePath).toMatch(/data\/engine\.sqlite$/);
    expect(loadKeeperConfig(env)).toMatchObject({ logLevel: "warn", logMaxBlockRange: 500n });
    expect(() => loadEngineConfig({ ...env, OPERATOR_PRIVATE_KEY: undefined })).toThrow(/OPERATOR_PRIVATE_KEY is required/);
    expect(() => loadEngineConfig({ ...env, RPC_URL: "ws://x" })).toThrow(/RPC_URL/);
    expect(() => loadEngineConfig({ ...env, DEPLOYMENT_PATH: "/nonexistent.json" })).toThrow(/cannot read deployment file/);
  });
});

describe("keeper with a partly failing oracle", () => {
  it("liquidates in a market whose own price is fresh although the account views revert, and skips markets without a price", async () => {
    const WAD = 10n ** 18n;
    const positions = new Map<string, bigint>([[`${alice.address}:1`, 2n * WAD], [`${alice.address}:2`, -3n * WAD]]);
    const done: [string, number, bigint][] = [];
    const chain = {
      async blockNumber() {
        return 1n;
      },
      async touchedPositions() {
        return [{ trader: alice.address, marketId: 1 }, { trader: alice.address, marketId: 2 }];
      },
      async positionSize(t: string, m: number) {
        return positions.get(`${t}:${m}`) ?? 0n;
      },
      async isLiquidatable(): Promise<boolean> {
        throw new Error("FeedStale(2, 0)"); // market 2's feed is stale: account-wide views revert
      },
      async liquidate(t: string, m: number, size: bigint) {
        done.push([t, m, size]);
        positions.set(`${t}:${m}`, 0n);
      },
      async ownFreeCollateral() {
        return 10n ** 12n;
      },
      async indexPrice(m: number) {
        if (m === 2) throw new Error("FeedStale(2, 0)");
        return 100n * WAD;
      },
      async initialMarginBps() {
        return 2000n;
      },
      async updateFunding() {},
      async lastFundingTime() {
        return 10n ** 12n;
      },
      async blockTimestamp() {
        return 1000n;
      },
    };
    const keeper = new Keeper({ chain, marketIds: [1, 2] });
    await keeper.tick();
    expect(done).toEqual([[alice.address, 1, 2n * WAD]]);
  });
});

describe("keeper persistence", () => {
  it("cursor and tracked accounts survive a restart; nothing is rescanned or forgotten", async () => {
    const path = tmp("keeper.json");
    const queries: [bigint, bigint][] = [];
    const positions = new Map<string, bigint>([[`${alice.address}:1`, 5n], [`${bob.address}:1`, -5n]]);
    const liquidations: string[] = [];
    const chain = {
      head: 50n,
      liquidatable: false,
      async blockNumber() {
        return this.head;
      },
      async touchedPositions(from: bigint, to: bigint) {
        queries.push([from, to]);
        return from <= 10n && to >= 10n ? [{ trader: alice.address, marketId: 1 }, { trader: bob.address, marketId: 1 }] : [];
      },
      async positionSize(t: string, m: number) {
        return positions.get(`${t}:${m}`) ?? 0n;
      },
      async isLiquidatable(t: string) {
        return this.liquidatable && t === alice.address;
      },
      async liquidate(t: string) {
        liquidations.push(t);
        positions.set(`${t}:1`, 0n);
      },
      async ownFreeCollateral() {
        return 0n;
      },
      async indexPrice() {
        return wad(100);
      },
      async initialMarginBps() {
        return 2000n;
      },
      async updateFunding() {},
      async lastFundingTime() {
        return 10n ** 12n;
      },
      async blockTimestamp() {
        return 1000n;
      },
    };
    const k1 = new Keeper({ chain, marketIds: [1], state: new FileKeeperState(path), startBlock: 5n });
    await k1.tick();
    expect(queries).toEqual([[5n, 50n]]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cursor: "50" });
    // killed and restarted; an account became liquidatable in the meantime
    chain.head = 60n;
    chain.liquidatable = true;
    const k2 = new Keeper({ chain, marketIds: [1], state: new FileKeeperState(path), startBlock: 5n });
    expect(k2.trackedAccounts().sort()).toEqual([alice.address, bob.address].sort());
    await k2.tick();
    expect(queries).toEqual([[5n, 50n], [51n, 60n]]);
    expect(liquidations).toEqual([alice.address]);
    await k2.tick(); // alice's position is closed: she is dropped, and that is saved too
    const k3 = new Keeper({ chain, marketIds: [1], state: new FileKeeperState(path) });
    expect(k3.trackedAccounts()).toEqual([bob.address]);
  });

  it("a keeper whose views revert (oracle down) keeps going and retries on the next tick", async () => {
    let down = true;
    const funded: number[] = [];
    const attempts: [string, number, bigint][] = [];
    const chain = {
      async blockNumber() {
        return 1n;
      },
      async touchedPositions() {
        return [{ trader: alice.address, marketId: 1 }];
      },
      async positionSize() {
        return 5n;
      },
      async isLiquidatable(): Promise<boolean> {
        if (down) throw new Error("SequencerDown()");
        return false;
      },
      async liquidate(t: string, m: number, size: bigint) {
        attempts.push([t, m, size]);
        if (down) throw new Error("NotLiquidatable()");
      },
      async ownFreeCollateral() {
        return 0n;
      },
      async indexPrice() {
        return 1n;
      },
      async initialMarginBps() {
        return 1n;
      },
      async updateFunding(m: number) {
        if (down) throw new Error("SequencerDown()");
        funded.push(m);
      },
      async lastFundingTime() {
        return 0n;
      },
      async blockTimestamp() {
        return 10_000n;
      },
    };
    const keeper = new Keeper({ chain, marketIds: [1, 2] });
    await keeper.tick(); // must not throw
    expect(funded).toEqual([]);
    expect(attempts).toEqual([[alice.address, 1, 5n]]); // tried anyway: this market's own price is readable
    expect(keeper.trackedAccounts()).toEqual([alice.address]);
    down = false;
    await keeper.tick();
    expect(funded).toEqual([1, 2]);
  });
});
