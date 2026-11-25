// Regression tests for the second independent review (F1 is in review.test.ts, "1: dead nonces").
import type { AddressInfo } from "node:net";
import { encodeErrorResult, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { exchangeAbi } from "../src/abi.ts";
import { buildServer } from "../src/api/server.ts";
import { LogPoller } from "../src/chain/logPoller.ts";
import { loadEngineConfig, loadKeeperConfig } from "../src/config.ts";
import { Engine, EngineError } from "../src/engine/engine.ts";
import { Keeper, type KeeperChain } from "../src/keeper/keeper.ts";
import { FakeSettler } from "../src/settlement/fakeSettler.ts";
import { hashOrder } from "../src/signing.ts";
import { ViemSettler, type RpcReceipt, type SettlerRpc } from "../src/settlement/viemSettler.ts";
import { SqliteStore } from "../src/store/sqliteStore.ts";
import { errMessage, jsonReplacer, type Address, type Hex, type Logger, type Match } from "../src/types.ts";
import { alice, bob, carol, DOMAIN, harness, makeOrder, MARKET, signCancel, signOrder, wad } from "./helpers.ts";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "OK";
};
const err = (errorName: string, args: unknown[] = []) => encodeErrorResult({ abi: exchangeAbi, errorName, args } as never);

describe("F2 / item 5: a trader's failing orders do not stay in the book", () => {
  it("reduce-only orders on one side may not exceed the position at intake", async () => {
    const h = harness({ withChain: true });
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, -wad(1)); // short 1
    expect(await code(h.place(alice, true, 100, "0.6", { order: { reduceOnly: true } }))).toBe("OK");
    expect(await code(h.place(alice, true, 100, "0.5", { order: { reduceOnly: true } }))).toBe("REDUCE_ONLY_EXCEEDS_POSITION");
    expect(await code(h.place(alice, true, 99, "0.4", { order: { reduceOnly: true } }))).toBe("OK");
    expect(await code(h.place(alice, true, 99, "0.01", { order: { reduceOnly: true } }))).toBe("REDUCE_ONLY_EXCEEDS_POSITION");
  });

  it("after one reduce-only order fails on-chain, the trader's other reduce-only orders on that side are pulled: one failed round, not one per order", async () => {
    const h = harness({ withChain: true, faultThreshold: 3 });
    // short 8 when the orders are placed; the position shrinks to 1 afterwards (other venue, liquidation, ...)
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, -wad(8));
    const orders = [];
    for (let i = 0; i < 8; i++) orders.push(await h.place(alice, true, 100, 1, { order: { reduceOnly: true } }));
    const normal = await h.place(alice, true, 99, 1); // not reduce-only: unaffected by a reduce-only failure
    let ok = 0;
    h.settler.failWhen = (m) => (m.maker.trader === alice.address && m.maker.reduceOnly && ok++ >= 1 ? err("ReduceOnlyViolated", [alice.address]) : null);
    const taker = await h.place(bob, false, 100, 3, { ioc: true });
    await h.engine.idle();
    const st = h.engine.settlementStatus();
    expect(st.settled).toBe(1);
    expect(st.failed).toBe(2); // the two fills of the first batch that came after the position was used up
    expect(h.settler.calls).toHaveLength(1); // bob's remainder found nothing of alice's to hit again
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "cancelled", filled: wad(1) });
    for (const o of orders.slice(3)) {
      expect(h.engine.getOrder(o.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n, reason: expect.stringMatching(/another order of this trader failed/) });
    }
    expect(h.engine.getOrder(normal.orderHash)!.status).toBe("open");
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([{ price: wad(99), size: wad(1) }]);
  });

  it("a margin failure pulls the trader's other position-increasing orders; suspension pulls everything", async () => {
    const h = harness({ withChain: true, faultThreshold: 2 });
    h.chain.positions.set(`${alice.address.toLowerCase()}:1`, wad(5));
    const a1 = await h.place(alice, true, 100, 1);
    const a2 = await h.place(alice, true, 99, 1);
    const ro = await h.place(alice, false, 104, 1, { order: { reduceOnly: true } });
    h.settler.failWhen = (m) => (m.maker.trader === alice.address ? err("InsufficientMargin", [alice.address]) : null);
    await h.place(bob, false, 100, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(a1.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(a2.orderHash)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(/insufficient margin/) });
    expect(h.engine.getOrder(ro.orderHash)!.status).toBe("open"); // reducing: would not fail for that reason
    // second fault within the window: suspended, and nothing of hers is left resting
    const a3 = await h.place(alice, true, 100, 1);
    await h.place(bob, false, 100, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(a3.orderHash)!.status).toBe("rejected");
    expect(h.engine.getOrder(ro.orderHash)).toMatchObject({ status: "cancelled", reason: expect.stringMatching(/suspended/) });
    expect(h.engine.getOpenOrders(alice.address)).toEqual([]);
    expect(await code(h.place(alice, true, 99, 1))).toBe("TRADER_SUSPENDED");
  });
});

describe("F3 / item 9: only the failed fill is undone", () => {
  it("FillTooSmall after someone else's failure: the honest taker keeps its order and is matched again for the maker's whole remainder", async () => {
    const h = harness();
    const maker = await h.place(alice, false, 100, "0.015"); // min is 0.01
    h.settler.beforeSettle = () => new Promise((r) => setTimeout(r, 20));
    // The contract's rule: a fill below the minimum is fine only if it completes one of the two orders.
    const completes = (m: Match) =>
      (h.settler.filled.get(m.makerHash) ?? 0n) + m.fillSize === m.maker.size || (h.settler.filled.get(m.takerHash) ?? 0n) + m.fillSize === m.taker.size;
    h.settler.failWhen = (m) =>
      m.taker.trader === carol.address ? err("InsufficientMargin", [carol.address]) : m.fillSize < MARKET.minOrderSize && !completes(m) ? err("FillTooSmall") : null;
    await h.place(carol, true, 100, "0.01"); // will fail on-chain, at carol's fault
    const honest = await h.place(bob, true, 100, 5); // takes the 0.005 remainder, rests 4.995
    expect(honest.remaining).toBe(wad("4.995"));
    await h.engine.idle();
    const v = h.engine.getOrder(honest.orderHash)!;
    expect(v).toMatchObject({ status: "partially_filled", filled: wad("0.015"), remaining: wad("4.985"), pending: 0n });
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "filled", filled: wad("0.015") });
    expect(h.settler.settled.reduce((sum, m) => sum + m.fillSize, 0n)).toBe(wad("0.015"));
    expect(h.engine.settlementStatus().failed).toBe(2); // carol's fill, and the one sub-minimum fill that followed it
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([{ price: wad(100), size: wad("4.985") }]);
  });

  it("FillTooSmall cannot repeat for ever: the dust maker collects strikes", async () => {
    const h = harness({ maxOrderStrikes: 2 });
    const maker = await h.place(alice, false, 100, 1);
    h.settler.failWhen = () => err("FillTooSmall");
    const taker = await h.place(bob, true, 100, 1);
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/repeatedly/) });
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "open", remaining: wad(1) });
    expect(h.settler.calls).toHaveLength(2);
  });

  it("global condition with a resting taker: the taker's slice is dropped, the maker gets its size back; a taker that keeps failing is removed", async () => {
    const h = harness({ maxOrderStrikes: 3 });
    const maker = await h.place(alice, false, 100, 1);
    const deep = await h.place(alice, false, 101, 1);
    h.settler.failWhen = () => err("OpenInterestCapExceeded");
    const taker = await h.place(bob, true, 100, 3); // takes 1 @ 100, rests 2 @ 100
    await h.engine.idle();
    // the maker never loses anything, and gets no strike
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(1), pending: 0n });
    expect(h.engine.getOrder(deep.orderHash)!.status).toBe("open");
    // the restored maker crossed the resting taker again and the match failed again:
    // after three such failures the taker's order is taken out, bounded and without blame
    expect(h.settler.calls).toHaveLength(3);
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n, reason: expect.stringMatching(/open-interest cap.*repeatedly/) });
    expect(h.engine.getOrderBook(1, 10)).toMatchObject({ bids: [], asks: [{ price: wad(100), size: wad(1) }, { price: wad(101), size: wad(1) }] });
  });

  it("global condition with a taker that no longer rests: the maker gets the size back", async () => {
    const h = harness();
    const maker = await h.place(alice, false, 100, 2);
    h.settler.failWhen = () => err("StalePrice", [1]);
    const taker = await h.place(bob, true, 100, 1); // fully matched, nothing resting
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "open", remaining: wad(2) });
    expect(h.engine.getOrder(taker.orderHash)).toMatchObject({ status: "cancelled", remaining: 0n });
  });
});

describe("F4 / item 3: log polling does not trust the newest blocks", () => {
  it("a backend that lags behind the reported head cannot make an event disappear", async () => {
    const events = [{ block: 12n, id: "cancel" }];
    let headA = 12n; // the node that answers eth_blockNumber
    let headB = 11n; // the node that answers eth_getLogs, one block behind: fewer logs, no error
    const seen: string[] = [];
    let cursor: bigint | undefined = 10n;
    const poller = new LogPoller<{ block: bigint; id: string }>({
      name: "t",
      head: async () => headA,
      fetch: async (from, to) => events.filter((e) => e.block >= from && e.block <= to && e.block <= headB),
      handle: (evs) => void seen.push(...evs.map((e) => e.id)),
      loadCursor: () => cursor,
      saveCursor: (b) => void (cursor = b),
    });
    await poller.poll();
    expect(cursor).toBe(10n); // head - 2: block 12 is not claimed as handled
    headA = headB = 20n;
    await poller.poll();
    expect(seen).toContain("cancel");
    expect(cursor).toBe(18n);
  });

  it("the last blocks are read again on every pass, so an event the first read missed is still found", async () => {
    const present = new Set<bigint>();
    const seen: bigint[] = [];
    let head = 10n;
    let cursor: bigint | undefined = 5n;
    const poller = new LogPoller<bigint>({
      name: "t",
      head: async () => head,
      fetch: async (from, to) => [...present].filter((b) => b >= from && b <= to),
      handle: (evs) => void seen.push(...evs),
      loadCursor: () => cursor,
      saveCursor: (b) => void (cursor = b),
      headLag: 0n,
      overlap: 3n,
    });
    await poller.poll(); // block 9 has an event, but this answer did not include it
    expect(seen).toEqual([]);
    present.add(9n);
    head = 11n;
    await poller.poll(); // re-reads 8..11
    expect(seen).toEqual([9n]);
  });

  it("a long backlog is read a bounded number of ranges per pass", async () => {
    const queries: [bigint, bigint][] = [];
    let cursor: bigint | undefined = 0n;
    const poller = new LogPoller<number>({
      name: "t",
      head: async () => 10_000n,
      fetch: async (from, to) => (queries.push([from, to]), []),
      handle: () => {},
      loadCursor: () => cursor,
      saveCursor: (b) => void (cursor = b),
      maxRange: 100n,
      headLag: 0n,
      overlap: 0n,
      maxRangesPerPoll: 3,
    });
    await poller.poll();
    expect(queries).toHaveLength(3);
    expect(poller.isCaughtUp).toBe(false);
    expect(cursor).toBe(300n);
  });
});

function keeperChain(over: Partial<KeeperChain>): KeeperChain {
  return {
    blockNumber: async () => 10n,
    touchedPositions: async (from, to) => (from <= 5n && to >= 5n ? [{ trader: alice.address, marketId: 1 }] : []),
    positionSize: async () => 5n,
    isLiquidatable: async () => false,
    isLiquidatableIn: async () => false,
    liquidate: async () => {},
    ownFreeCollateral: async () => 10n ** 12n,
    indexPrice: async () => 100n * 10n ** 18n,
    initialMarginBps: async () => 2000n,
    updateFunding: async () => {},
    lastFundingTime: async () => 10n ** 12n,
    blockTimestamp: async () => 1n,
    ...over,
  };
}

describe("F5 / items 4 and 12: keeper", () => {
  it("one stale zero read does not make it forget an account", async () => {
    let reads = 0;
    const liquidations: Address[] = [];
    const keeper = new Keeper({
      chain: keeperChain({
        positionSize: async () => (reads++ === 0 ? 0n : 5n), // first read answered by a lagging node
        isLiquidatable: async () => true,
        liquidate: async (t) => void liquidations.push(t),
      }),
      marketIds: [1],
      headLag: 0n,
    });
    await keeper.tick();
    expect(keeper.trackedAccounts()).toEqual([alice.address]);
    await keeper.tick();
    expect(liquidations).toEqual([alice.address]);
  });

  it("forgets a position only after it read as zero on several consecutive ticks", async () => {
    let size = 5n;
    const keeper = new Keeper({ chain: keeperChain({ positionSize: async () => size }), marketIds: [1], headLag: 0n, untrackAfterZeroReads: 3 });
    await keeper.tick();
    size = 0n;
    await keeper.tick();
    await keeper.tick();
    expect(keeper.trackedAccounts()).toEqual([alice.address]);
    size = 5n; // it was a lagging node after all
    await keeper.tick();
    size = 0n;
    await keeper.tick();
    await keeper.tick();
    expect(keeper.trackedAccounts()).toEqual([alice.address]); // the count started again
    await keeper.tick();
    expect(keeper.trackedAccounts()).toEqual([]);
  });

  it("backs off on an account it cannot afford to liquidate instead of retrying every tick", async () => {
    let attempts = 0;
    const keeper = new Keeper({
      chain: keeperChain({
        isLiquidatable: async () => true,
        ownFreeCollateral: async () => 0n,
        liquidate: async () => {
          attempts++;
          throw new Error("InsufficientMargin(keeper)");
        },
      }),
      marketIds: [1],
      headLag: 0n,
    });
    for (let i = 0; i < 16; i++) await keeper.tick();
    expect(attempts).toBeLessThanOrEqual(4); // ticks 1, 3, 7, 15
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("does not send updateFunding before the latest block's time has reached the interval, whatever the host clock says", async () => {
    const calls: number[] = [];
    let blockTime = 1000n;
    const keeper = new Keeper({
      chain: keeperChain({ lastFundingTime: async () => 0n, blockTimestamp: async () => blockTime, updateFunding: async (m) => void calls.push(m) }),
      marketIds: [1],
      fundingIntervalSec: 3600,
      now: () => 10 ** 9, // host clock far ahead
      headLag: 0n,
    });
    await keeper.tick();
    expect(calls).toEqual([]); // would have been a no-op transaction
    blockTime = 3600n;
    await keeper.tick();
    expect(calls).toEqual([1]);
  });

  it("liquidation checks are not held up by a long historical sync", async () => {
    const liquidations: Address[] = [];
    const keeper = new Keeper({
      chain: keeperChain({
        blockNumber: async () => 1_000_000n,
        isLiquidatable: async () => true,
        liquidate: async (t) => void liquidations.push(t),
      }),
      marketIds: [1],
      maxBlockRange: 100n,
      headLag: 0n,
    });
    await keeper.tick(); // read 10 ranges (blocks 0..999), found alice at block 5, checked her at once
    expect(liquidations).toEqual([alice.address]);
  });

  it("KEEPER_START_BLOCK is required on anything but a local chain", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "baldwin-cfg-"));
    const dep = (chainId: number) => {
      const f = join(dir, `${chainId}.json`);
      writeFileSync(f, JSON.stringify({ chainId, exchange: alice.address, usdc: bob.address, oracle: carol.address, markets: [] }));
      return f;
    };
    const env = { KEEPER_PRIVATE_KEY: "0x" + "22".repeat(32) };
    expect(() => loadKeeperConfig({ ...env, DEPLOYMENT_PATH: dep(421614) })).toThrow(/KEEPER_START_BLOCK is required on chain 421614/);
    expect(loadKeeperConfig({ ...env, DEPLOYMENT_PATH: dep(421614), KEEPER_START_BLOCK: "123" }).startBlock).toBe(123n);
    expect(loadKeeperConfig({ ...env, DEPLOYMENT_PATH: dep(31337) }).startBlock).toBe(0n);
    // a deployment file that records its block makes the variable optional, for keeper and engine
    const withBlock = join(dir, "with-block.json");
    writeFileSync(
      withBlock,
      JSON.stringify({ chainId: 421614, exchange: alice.address, usdc: bob.address, oracle: carol.address, markets: [], deploymentBlock: 777 }),
    );
    expect(loadKeeperConfig({ ...env, DEPLOYMENT_PATH: withBlock }).startBlock).toBe(777n);
    expect(loadKeeperConfig({ ...env, DEPLOYMENT_PATH: withBlock, KEEPER_START_BLOCK: "900" }).startBlock).toBe(900n);
    const op = { OPERATOR_PRIVATE_KEY: "0x" + "11".repeat(32) };
    expect(loadEngineConfig({ ...op, DEPLOYMENT_PATH: withBlock }).startBlock).toBe(777n);
    expect(loadEngineConfig({ ...op, DEPLOYMENT_PATH: withBlock, START_BLOCK: "900" }).startBlock).toBe(900n);
    expect(loadEngineConfig({ ...op, DEPLOYMENT_PATH: dep(421614) }).startBlock).toBeUndefined();
    // and the engine ships with a fee cap unless it is switched off explicitly
    const eenv = { OPERATOR_PRIVATE_KEY: "0x" + "11".repeat(32), DEPLOYMENT_PATH: dep(31337) };
    expect(loadEngineConfig(eenv).maxFeePerGasCap).toBe(100n * 10n ** 9n);
    expect(loadEngineConfig({ ...eenv, MAX_FEE_PER_GAS_GWEI: "0.5" }).maxFeePerGasCap).toBe(5n * 10n ** 8n);
    expect(loadEngineConfig({ ...eenv, MAX_FEE_PER_GAS_GWEI: "0" }).maxFeePerGasCap).toBeUndefined();
  });
});

async function oneMatch(): Promise<Match> {
  const maker = makeOrder(alice, false, 100, 1);
  const taker = makeOrder(bob, true, 101, 1);
  return { id: "m1", marketId: MARKET.marketId, maker, makerSig: await signOrder(alice, maker), makerHash: hashOrder(DOMAIN, maker), taker, takerSig: await signOrder(bob, taker), takerHash: hashOrder(DOMAIN, taker), fillSize: wad(1), price: maker.limitPrice };
}

describe("F6 / item 8: fee bumping cannot lock the operator out", () => {
  it("when a replacement is refused for insufficient funds, bumping stops and the best accepted transaction keeps being sent", async () => {
    const m = await oneMatch();
    const balance = 10n ** 15n; // 0.001 ETH
    const sent: { maxFee: bigint; accepted: boolean; raw: Hex }[] = [];
    let mineIt = false;
    const receipts = new Map<Hex, RpcReceipt>();
    const { keccak256 } = await import("viem");
    const rpc: SettlerRpc = {
      getNonce: async () => 7,
      estimateGas: async () => 200_000n,
      call: async () => {},
      estimateFees: async () => ({ maxFeePerGas: 10n ** 8n, maxPriorityFeePerGas: 10n ** 7n }), // 0.1 gwei
      sendRawTransaction: async (raw) => {
        const tx = parseTransaction(raw);
        const accepted = tx.gas! * tx.maxFeePerGas! <= balance; // what every node checks before admitting a transaction
        sent.push({ maxFee: tx.maxFeePerGas!, accepted, raw });
        if (!accepted) throw new Error("insufficient funds for gas * price + value");
        if (mineIt) receipts.set(keccak256(raw), { status: "success", logs: [], blockNumber: 101n, blockHash: `0x${"01".repeat(32)}` });
      },
      getReceipt: async (hash) => receipts.get(hash) ?? null,
      filledSize: async () => 0n,
      blockNumber: async () => 100n,
    };
    const errors: string[] = [];
    const logger: Logger = { info() {}, warn() {}, error: (msg) => errors.push(msg) };
    const settler = new ViemSettler({ rpc, account: carol, chainId: DOMAIN.chainId, exchange: DOMAIN.verifyingContract, receiptTimeoutMs: 2, pollIntervalMs: 1, maxRounds: 4, bumpAfterRounds: 1, gasFloorPerMatch: 700_000n, logger });
    for (let i = 0; i < 8; i++) await settler.settle({ id: "b1", matches: [m] }).catch(() => {});
    const firstRejected = sent.findIndex((s) => !s.accepted);
    expect(firstRejected).toBeGreaterThan(0);
    const best = sent.slice(0, firstRejected).at(-1)!;
    // after the refusal: no further bump, and what is broadcast is the highest-fee transaction a node took
    expect(sent.filter((s) => !s.accepted)).toHaveLength(1);
    expect(sent.slice(firstRejected + 1).length).toBeGreaterThan(5);
    expect(sent.slice(firstRejected + 1).every((s) => s.accepted && s.raw === best.raw)).toBe(true);
    expect(settler.status()).toEqual({ insufficientFunds: true, feeCapReached: false });
    expect(errors.filter((e) => /cannot pay/.test(e))).toHaveLength(1); // said once, not every round
    // the chain catches up: that transaction is mined and the batch resolves
    mineIt = true;
    expect(await settler.settle({ id: "b1", matches: [m] })).toEqual([{ status: "settled", txHash: keccak256(best.raw) }]);
    expect(settler.status()).toEqual({ insufficientFunds: false, feeCapReached: false });
  });

  it("/health and metrics surface it", async () => {
    const settler = new FakeSettler() as FakeSettler & { status(): { insufficientFunds: boolean; feeCapReached: boolean } };
    let flags = { insufficientFunds: true, feeCapReached: true };
    settler.status = () => flags;
    const engine = new Engine({ domain: DOMAIN, markets: [MARKET], settler });
    const app = await buildServer(engine);
    const h = (await app.inject({ url: "/health" })).json();
    expect(h.warnings).toEqual([expect.stringMatching(/cannot pay/), expect.stringMatching(/fee cap/)]);
    expect((await app.inject({ url: "/metrics" })).body).toContain("baldwin_settler_insufficient_funds 1\n");
    flags = { insufficientFunds: false, feeCapReached: false };
    expect((await app.inject({ url: "/health" })).json().warnings).toEqual([]);
    await app.close();
  });
});

describe("item 7: releasing a batch whose nonce was consumed", () => {
  it("reads nonce and filledSize as of one pinned block, and only once that block is buried", async () => {
    const m = await oneMatch();
    const reads: { what: string; at: unknown }[] = [];
    let head = 100n;
    const rpc: SettlerRpc = {
      getNonce: async (_a, at) => {
        reads.push({ what: "nonce", at });
        return at === "pending" ? 7 : 8; // consumed by a transaction that is not ours
      },
      estimateGas: async () => 200_000n,
      call: async () => {},
      estimateFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      sendRawTransaction: async () => {
        throw new Error("nonce too low");
      },
      getReceipt: async () => null,
      filledSize: async (_h, block) => {
        reads.push({ what: "filled", at: block });
        return 0n;
      },
      blockNumber: async () => head,
    };
    const settler = new ViemSettler({ rpc, account: carol, chainId: DOMAIN.chainId, exchange: DOMAIN.verifyingContract, receiptTimeoutMs: 2, pollIntervalMs: 1, maxRounds: 1, releasePolls: 2, confirmations: 3, confirmationTimeoutMs: 500 });
    let outcome: unknown = "pending";
    const p = settler.settle({ id: "b1", matches: [m] }).catch((e) => (outcome = e));
    await new Promise((r) => setTimeout(r, 40));
    expect(outcome).toBe("pending"); // block 100 is not 3 deep yet: no verdict
    head = 102n;
    await p;
    expect((outcome as Error).name).toBe("BatchRevertedError");
    // the decisive reads were pinned to the block at which the nonce was seen consumed
    expect(reads.filter((r) => r.what === "nonce" && r.at === 100n).length).toBeGreaterThanOrEqual(2);
    const filledReads = reads.filter((r) => r.what === "filled");
    expect(filledReads.slice(-2).map((r) => r.at)).toEqual([100n, 100n]);
  });
});

describe("item 6: what a client can rely on", () => {
  it("resubmitting the identical signed order returns its current state with 200 and changes nothing", async () => {
    const h = harness();
    const app = await buildServer(h.engine);
    const order = makeOrder(alice, false, 100, 2);
    const payload = { order: JSON.parse(JSON.stringify(order, jsonReplacer)), signature: await signOrder(alice, order) };
    const first = await app.inject({ method: "POST", url: "/orders", payload });
    expect(first.json()).toMatchObject({ status: "open", remaining: wad(2).toString(), pending: "0", filled: "0" });
    expect(first.json().duplicate).toBeUndefined();
    await h.place(bob, true, 100, 1);
    await h.engine.idle();
    const again = await app.inject({ method: "POST", url: "/orders", payload });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ orderHash: first.json().orderHash, status: "partially_filled", fills: [], remaining: wad(1).toString(), pending: "0", filled: wad(1).toString(), duplicate: true });
    expect(h.engine.getOrderBook(1, 10).asks).toEqual([{ price: wad(100), size: wad(1) }]); // not added twice
    // different flags on the retry do not change the stored order
    expect((await app.inject({ method: "POST", url: "/orders", payload: { ...payload, ioc: true } })).json()).toMatchObject({ duplicate: true, status: "partially_filled" });
    // the same order with somebody else's signature learns nothing
    const forged = await app.inject({ method: "POST", url: "/orders", payload: { ...payload, signature: await signOrder(bob, order) } });
    expect(forged.statusCode).toBe(401);
    // two identical requests racing each other: one order
    const o2 = makeOrder(carol, true, 90, 1);
    const p2 = { order: JSON.parse(JSON.stringify(o2, jsonReplacer)), signature: await signOrder(carol, o2) };
    const both = await Promise.all([app.inject({ method: "POST", url: "/orders", payload: p2 }), app.inject({ method: "POST", url: "/orders", payload: p2 })]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(both.map((r) => r.json().duplicate === true).sort()).toEqual([false, true]);
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([{ price: wad(90), size: wad(1) }]);
    expect(h.engine.metrics.get("orders_duplicate_total")).toBe(3);
    await app.close();
  });

  it("every error body carries outcome; only STATE_UNKNOWN and 500 are 'unknown', and a retry after STATE_UNKNOWN is safe", async () => {
    const store = new SqliteStore(":memory:");
    const h = harness({ store });
    const errors: string[] = [];
    const app = await buildServer(h.engine, { rateLimitPerMinute: 1000, logger: { info() {}, warn() {}, error: (msg) => errors.push(msg) } });
    const body = (o: unknown, s: string) => ({ order: JSON.parse(JSON.stringify(o, jsonReplacer)), signature: s });
    const order = makeOrder(alice, true, 100, 1);
    const sig = await signOrder(alice, order);

    expect((await app.inject({ method: "POST", url: "/orders", payload: {} })).json().error).toMatchObject({ code: "BAD_REQUEST", outcome: "not_applied" });
    expect((await app.inject({ method: "POST", url: "/orders", payload: body(order, await signOrder(bob, order)) })).json().error).toMatchObject({ code: "BAD_SIGNATURE", outcome: "not_applied" });
    expect((await app.inject({ url: "/nope" })).json().error).toMatchObject({ code: "NOT_FOUND", outcome: "not_applied" });

    // the commit fails while the order is being taken: the client cannot know
    const commit = store.commit.bind(store);
    store.commit = () => {
      throw new Error("disk full");
    };
    const unknown = await app.inject({ method: "POST", url: "/orders", payload: body(order, sig) });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error).toMatchObject({ code: "STATE_UNKNOWN", outcome: "unknown" });
    // while the store is broken further orders are refused outright
    const o2 = makeOrder(bob, true, 99, 1);
    const refused = await app.inject({ method: "POST", url: "/orders", payload: body(o2, await signOrder(bob, o2)) });
    expect(refused.json().error).toMatchObject({ code: "STORE_UNAVAILABLE", outcome: "not_applied" });
    expect((await app.inject({ url: "/health" })).json()).toMatchObject({ ok: false, warnings: [expect.stringMatching(/store/)] });
    // the store works again; the client retries the identical order and learns its state
    store.commit = commit;
    h.engine.sweepExpired();
    const retry = await app.inject({ method: "POST", url: "/orders", payload: body(order, sig) });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ duplicate: true, status: "open" });
    expect(store.load().orders).toHaveLength(1);

    // an unexpected exception: 500, outcome unknown, logged through the JSON logger without details to the client
    h.engine.getMarkets = () => {
      throw new Error("boom at https://rpc.example/v2/SECRET");
    };
    const boom = await app.inject({ url: "/markets" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: { code: "INTERNAL", message: "internal error", outcome: "unknown" } });
    expect(errors).toContain("unhandled error in request");
    await app.close();
  });

  it("a slow chain cannot hold a request beyond the intake deadline, and the order is then not accepted", async () => {
    const h = harness({ withChain: true, intakeTimeoutMs: 30 });
    await h.engine.refreshChainState();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const free = h.chain.freeCollateral.bind(h.chain);
    h.chain.freeCollateral = async (t) => (await gate, free(t));
    const t0 = Date.now();
    const e = await h.place(alice, true, 100, 1).catch((x) => x);
    expect(e).toMatchObject({ code: "CHAIN_UNAVAILABLE", httpStatus: 503, outcome: "not_applied" });
    expect(Date.now() - t0).toBeLessThan(500);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.engine.getOrderBook(1, 10).bids).toEqual([]); // the late answer did not sneak the order in
  });

  it("orders are rate-limited per trader, counted only for validly signed ones; chain reads per trader are reused briefly", async () => {
    const h = harness({ withChain: true, traderOrdersPerMinute: 3, preTradeCacheMs: 60_000 });
    let freeReads = 0;
    const free = h.chain.freeCollateral.bind(h.chain);
    h.chain.freeCollateral = async (t) => (freeReads++, free(t));
    // forged orders in alice's name do not use up her allowance
    for (let i = 0; i < 5; i++) {
      const o = makeOrder(alice, true, 90, 1);
      expect(await code(h.engine.submit({ order: o, signature: await signOrder(bob, o) }))).toBe("BAD_SIGNATURE");
    }
    for (let i = 0; i < 3; i++) expect(await code(h.place(alice, true, 90 + i, 1))).toBe("OK");
    const e = await h.place(alice, true, 95, 1).catch((x) => x);
    expect(e).toMatchObject({ code: "RATE_LIMITED", httpStatus: 429, outcome: "not_applied" });
    expect(await code(h.place(bob, true, 90, 1))).toBe("OK");
    expect(freeReads).toBe(2); // one for alice (reused twice), one for bob
  });
});

describe("item 10: attribution", () => {
  it("an order found cancelled or expired on-chain is removed without counting against its trader", async () => {
    const h = harness({ withChain: true, faultThreshold: 1 });
    const maker = await h.place(alice, true, 100, 1);
    const other = await h.place(alice, true, 99, 1);
    h.chain.cancelled.add(`${alice.address.toLowerCase()}:${h.engine.getOrder(maker.orderHash)!.order.nonce}`);
    h.settler.failWhen = () => err("OrderIsCancelled");
    await h.place(bob, false, 100, 1, { ioc: true });
    await h.engine.idle();
    expect(h.engine.getOrder(maker.orderHash)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/cancelled on-chain/) });
    expect(h.engine.getOrder(other.orderHash)!.status).toBe("open"); // nothing else of hers is touched
    expect(await code(h.place(alice, true, 98, 1))).toBe("OK"); // and she is not suspended (threshold is 1)
  });
});

describe("items 10 and 11: recovery", () => {
  it("cancels are applied before queued matches are settled or anything is re-crossed; orders are refused until recovery is done", async () => {
    const store = new SqliteStore(":memory:");
    const world = harness({ store, withChain: true });
    world.settler.beforeSettle = () => new Promise<void>(() => {}); // this process never settles anything
    const maker = await world.place(alice, false, 100, 1);
    const resting = await world.place(carol, false, 101, 1);
    const taker = await world.place(bob, true, 100, 1); // queued match maker/taker
    // killed. While it is down carol cancels on-chain (single nonce) and alice bulk-cancels.
    const chain = world.chain;
    chain.cancelled.add(`${carol.address.toLowerCase()}:${world.engine.getOrder(resting.orderHash)!.order.nonce}`);

    const settler = new FakeSettler();
    const order: string[] = [];
    settler.beforeSettle = () => void order.push("settle");
    const engine = new Engine({ domain: DOMAIN, markets: [MARKET], settler, chain, store, now: () => 1000, expiryBufferSec: 5, minTimeToExpirySec: 0, retryDelayMs: 1, preTradeCacheMs: 0 });
    expect(engine.isRecovering()).toBe(true);
    const o = makeOrder(bob, true, 101, 1);
    const early = await engine.submit({ order: o, signature: await signOrder(bob, o) }).catch((x) => x);
    expect(early).toMatchObject({ code: "RECOVERING", httpStatus: 503, outcome: "not_applied" });
    const app = await buildServer(engine);
    expect((await app.inject({ url: "/health" })).json()).toMatchObject({ ok: false, recovering: true, warnings: [expect.stringMatching(/recovering/)] });

    await engine.recover({
      replayCancels: async () => {
        order.push("replay");
        expect(engine.getOrder(resting.orderHash)!.status).toBe("cancelled"); // chain view already applied
      },
    });
    expect(order).toEqual(["replay", "settle"]);
    expect(engine.isRecovering()).toBe(false);
    expect((await app.inject({ url: "/health" })).json()).toMatchObject({ ok: true, recovering: false });
    expect(engine.getOrder(maker.orderHash)!.status).toBe("filled");
    expect(engine.getOrder(taker.orderHash)!.status).toBe("filled");
    expect(engine.getOrderBook(1, 10)).toMatchObject({ asks: [], bids: [] });
    expect(await code(engine.submit({ order: o, signature: await signOrder(bob, o) }))).toBe("OK");
    await app.close();
  });
});

describe("item 2: shutdown", () => {
  it("app.close() returns promptly with a WebSocket client and a keep-alive connection open", async () => {
    const h = harness();
    const app = await buildServer(h.engine);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ op: "subscribe", channel: "orderbook", marketId: 1 }));
    const closed = new Promise((r) => ws.once("close", r));
    await fetch(`http://127.0.0.1:${port}/health`, { headers: { connection: "keep-alive" } }).then((r) => r.text());
    const t0 = Date.now();
    const res = await Promise.race([app.close().then(() => "closed"), new Promise((r) => setTimeout(() => r("hung"), 4000))]);
    expect(res).toBe("closed");
    expect(Date.now() - t0).toBeLessThan(2000);
    await closed; // the client was told
  });
});

describe("ops: nothing secret in logs", () => {
  it("errMessage and the JSON logger never contain an RPC URL (which may carry an API key)", async () => {
    const { createPublicClient } = await import("viem");
    const { rpcTransport } = await import("../src/chain/transport.ts");
    const { createLogger } = await import("../src/types.ts");
    const url = "http://127.0.0.1:9/v2/SECRET_API_KEY_123";
    const client = createPublicClient({ transport: rpcTransport(url, () => {}) });
    const calls = [
      () => client.getBlockNumber(),
      () => client.estimateGas({ to: DOMAIN.verifyingContract, data: "0x" }),
      () => client.sendRawTransaction({ serializedTransaction: "0x02c0" }),
      () => client.getLogs({ fromBlock: 1n, toBlock: 2n }),
    ];
    for (const fn of calls) {
      const e = await fn().catch((x: unknown) => x);
      expect(errMessage(e)).not.toContain("SECRET");
      expect(errMessage(e).length).toBeGreaterThan(5);
    }
    const out: string[] = [];
    const se = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (out.push(s), true)) as never;
    try {
      createLogger("info").error("rpc failed", { error: `HTTP request failed. URL: ${url}`, nested: { url } });
    } finally {
      process.stderr.write = se;
    }
    expect(out.join("")).not.toContain("SECRET");
    expect(out.join("")).toContain("[url]");
  }, 30_000);

  it("a second process cannot open the engine's store while the first holds it", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "baldwin-excl-")), "engine.sqlite");
    const first = new SqliteStore(path, { exclusive: true });
    first.setMeta("k", "v");
    const t0 = Date.now();
    expect(() => new SqliteStore(path, { exclusive: true }).setMeta("k", "w")).toThrow(/locked|busy/i);
    expect(Date.now() - t0).toBeLessThan(2000); // short busy timeout: fails fast
    expect(first.getMeta("k")).toBe("v");
    first.close();
    const again = new SqliteStore(path, { exclusive: true });
    expect(again.getMeta("k")).toBe("v");
    again.close();
  });
});

describe("item 13: operator nonce after a restart", () => {
  it("with no batch in flight, the next nonce comes from the chain, not from the previous process's record", async () => {
    const m = await oneMatch();
    const m2 = { ...(await oneMatch()), id: "m2" };
    const kv = new Map<string, string>();
    const store = { getMeta: (k: string) => kv.get(k), setMeta: (k: string, v: string) => void kv.set(k, v) };
    const { keccak256 } = await import("viem");
    let chainNonce = 7;
    const sent: number[] = [];
    const receipts = new Map<Hex, RpcReceipt>();
    const rpc: SettlerRpc = {
      getNonce: async () => chainNonce,
      estimateGas: async () => 200_000n,
      call: async () => {},
      estimateFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      sendRawTransaction: async (raw) => {
        sent.push(parseTransaction(raw).nonce!);
        receipts.set(keccak256(raw), { status: "success", logs: [], blockNumber: 101n, blockHash: `0x${"01".repeat(32)}` });
      },
      getReceipt: async (hash) => receipts.get(hash) ?? null,
      filledSize: async () => 0n,
      blockNumber: async () => 100n,
    };
    const mk = () => new ViemSettler({ rpc, account: carol, chainId: DOMAIN.chainId, exchange: DOMAIN.verifyingContract, receiptTimeoutMs: 5, pollIntervalMs: 1, store });
    await mk().settle({ id: "b1", matches: [m] });
    expect(sent).toEqual([7]);
    // The chain the engine talks to after the restart is at nonce 3 (a re-deployed local
    // chain; or simply: the old record is not evidence about the present).
    chainNonce = 3;
    await mk().settle({ id: "b2", matches: [m2] });
    expect(sent).toEqual([7, 3]);
  });
});

describe("expiry follows chain time when the chain's clock is ahead of the host's", () => {
  it("orders are judged against the later of the two clocks", async () => {
    const h = harness({ withChain: true, expiryBufferSec: 5 });
    const early = await h.place(alice, true, 99, 1, { order: { expiry: 1200n } });
    const late = await h.place(alice, true, 98, 1, { order: { expiry: 2000n } });
    h.chain.time = 1300n; // block.timestamp is 300 s ahead of this host (clock 1000)
    await h.engine.refreshChainState();
    h.engine.sweepExpired();
    expect(h.engine.getOrder(early.orderHash)!.status).toBe("open"); // one reading is not believed
    await h.engine.refreshChainState();
    await h.engine.refreshChainState();
    h.engine.sweepExpired();
    expect(h.engine.getOrder(early.orderHash)!.status).toBe("expired"); // already expired for the contract
    expect(h.engine.getOrder(late.orderHash)!.status).toBe("open");
    expect(await code(h.place(bob, true, 97, 1, { order: { expiry: 1290n } }))).toBe("EXPIRED");
    expect(await code(h.place(bob, true, 97, 1, { order: { expiry: 1306n } }))).toBe("OK");
    // a chain clock behind the host's changes nothing
    h.chain.time = 500n;
    await h.engine.refreshChainState(); // the lead is gone at once: the smallest of the last readings counts
    expect(await code(h.place(bob, true, 96, 1, { order: { expiry: 1004n } }))).toBe("EXPIRED");
    expect(await code(h.place(bob, true, 96, 1, { order: { expiry: 1006n } }))).toBe("OK");
  });
});

