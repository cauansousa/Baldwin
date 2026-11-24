import { describe, expect, it } from "vitest";
import { Keeper, type KeeperChain } from "../src/keeper/keeper.ts";
import type { Address } from "../src/types.ts";
import { ViemKeeperChain } from "../src/keeper/viemKeeperChain.ts";
import { alice, bob, carol } from "./helpers.ts";

class FakeKeeperChain implements KeeperChain {
  head = 10n;
  events: { block: bigint; trader: Address; marketId: number }[] = [];
  positions = new Map<string, bigint>();
  liquidatable = new Set<Address>();
  liquidations: [Address, number, bigint][] = [];
  funding: number[] = [];
  queries: [bigint, bigint][] = [];
  fundingFails = false;

  async blockNumber() {
    return this.head;
  }
  async touchedPositions(from: bigint, to: bigint) {
    this.queries.push([from, to]);
    return this.events.filter((e) => e.block >= from && e.block <= to);
  }
  async positionSize(trader: Address, marketId: number) {
    return this.positions.get(`${trader}:${marketId}`) ?? 0n;
  }
  async isLiquidatable(trader: Address) {
    return this.liquidatable.has(trader);
  }
  async isLiquidatableIn(trader: Address) {
    return this.liquidatable.has(trader);
  }
  /** Largest size the liquidator can take over (as the contract would enforce through margin). */
  capacity: bigint | null = null;
  free = 0n;
  async liquidate(trader: Address, marketId: number, maxSize: bigint) {
    if (this.capacity !== null && maxSize > this.capacity) throw new Error("InsufficientMargin(liquidator)");
    this.liquidations.push([trader, marketId, maxSize]);
    const key = `${trader}:${marketId}`;
    const pos = this.positions.get(key)!;
    this.positions.set(key, pos > 0n ? pos - maxSize : pos + maxSize);
    // one liquidation is enough to make the account healthy in this fake
    this.liquidatable.delete(trader);
  }
  async ownFreeCollateral() {
    return this.free;
  }
  async indexPrice() {
    return 100n * 10n ** 18n;
  }
  async initialMarginBps() {
    return 2000n;
  }
  /** Chain clock and per-market last funding time. */
  time = 10_000n;
  lastFunding = new Map<number, bigint>();
  async updateFunding(marketId: number) {
    if (this.fundingFails) throw new Error("revert");
    this.funding.push(marketId);
    this.lastFunding.set(marketId, this.time > BigInt(this.wall()) ? this.time : BigInt(this.wall()));
  }
  wall: () => number = () => 0;
  async lastFundingTime(marketId: number) {
    return this.lastFunding.get(marketId) ?? 0n;
  }
  async blockTimestamp() {
    return this.time;
  }
}

describe("Keeper", () => {
  it("tracks accounts from events in bounded block ranges and never rescans", async () => {
    const chain = new FakeKeeperChain();
    chain.head = 25n;
    chain.events = [{ block: 3n, trader: alice.address, marketId: 1 }, { block: 22n, trader: bob.address, marketId: 1 }];
    chain.positions.set(`${alice.address}:1`, 5n);
    chain.positions.set(`${bob.address}:1`, -5n);
    const keeper = new Keeper({ chain, headLag: 0n, overlap: 0n, untrackAfterZeroReads: 1, marketIds: [1], maxBlockRange: 10n });
    await keeper.tick();
    expect(chain.queries).toEqual([[0n, 9n], [10n, 19n], [20n, 25n]]);
    expect(keeper.trackedAccounts().sort()).toEqual([alice.address, bob.address].sort());
    await keeper.tick();
    expect(chain.queries).toHaveLength(3);
    chain.head = 26n;
    await keeper.tick();
    expect(chain.queries[3]).toEqual([26n, 26n]);
  });

  it("liquidates only liquidatable accounts with open positions, and forgets closed ones", async () => {
    const chain = new FakeKeeperChain();
    chain.events = [
      { block: 1n, trader: alice.address, marketId: 1 },
      { block: 1n, trader: alice.address, marketId: 2 },
      { block: 1n, trader: bob.address, marketId: 1 },
    ];
    chain.positions.set(`${alice.address}:1`, 5n);
    chain.positions.set(`${alice.address}:2`, -3n);
    chain.positions.set(`${bob.address}:1`, -5n);
    const keeper = new Keeper({ chain, headLag: 0n, overlap: 0n, untrackAfterZeroReads: 1, marketIds: [1, 2] });
    await keeper.tick();
    expect(chain.liquidations).toEqual([]);

    chain.liquidatable.add(alice.address);
    await keeper.tick();
    // stops as soon as the account is healthy again
    expect(chain.liquidations).toEqual([[alice.address, 1, 5n]]);

    chain.positions.set(`${bob.address}:1`, 0n);
    await keeper.tick();
    expect(keeper.trackedAccounts()).toEqual([alice.address]);
  });

  it("falls back to the size its own collateral can margin when the full liquidation is refused", async () => {
    const chain = new FakeKeeperChain();
    const WAD = 10n ** 18n;
    chain.events = [{ block: 1n, trader: alice.address, marketId: 1 }];
    chain.positions.set(`${alice.address}:1`, -10n * WAD);
    chain.liquidatable.add(alice.address);
    chain.capacity = 5n * WAD;
    chain.free = 100_000_000n; // 100 USDC -> 90 budget -> 450 notional at 20% -> 4.5 units at price 100
    const keeper = new Keeper({ chain, headLag: 0n, overlap: 0n, untrackAfterZeroReads: 1, marketIds: [1] });
    await keeper.tick();
    expect(chain.liquidations).toEqual([[alice.address, 1, (45n * WAD) / 10n]]);
    expect(chain.positions.get(`${alice.address}:1`)).toBe((-55n * WAD) / 10n);
  });

  it("never tries to liquidate itself", async () => {
    const chain = new FakeKeeperChain();
    chain.events = [{ block: 1n, trader: bob.address, marketId: 1 }];
    chain.positions.set(`${bob.address}:1`, 5n);
    chain.liquidatable.add(bob.address);
    const keeper = new Keeper({ chain, headLag: 0n, overlap: 0n, untrackAfterZeroReads: 1, marketIds: [1], self: bob.address });
    await keeper.tick();
    expect(chain.liquidations).toEqual([]);
  });

  it("schedules funding from the on-chain lastFundingTime against chain time: no call before the interval, one when due, retry after a failure", async () => {
    const chain = new FakeKeeperChain();
    chain.time = 10_000n;
    chain.lastFunding.set(1, 9_000n); // 1000 s ago
    chain.lastFunding.set(2, 6_400n); // exactly one interval ago
    const keeper = new Keeper({ chain, headLag: 0n, overlap: 0n, marketIds: [1, 2], fundingIntervalSec: 3600, now: () => 99_999_999 });
    await keeper.tick();
    expect(chain.funding).toEqual([2]); // a freshly started keeper does not call what is not due
    await keeper.tick();
    expect(chain.funding).toEqual([2]);
    chain.time = 12_600n; // market 1 becomes due
    chain.fundingFails = true;
    await keeper.tick();
    expect(chain.funding).toEqual([2]);
    chain.fundingFails = false;
    await keeper.tick();
    expect(chain.funding).toEqual([2, 1]);
    // someone else updated funding in the meantime: the keeper follows the chain
    chain.lastFunding.set(2, 12_000n);
    chain.time = 13_700n; // 3700 s after the keeper's own call for market 2, but only 1700 s after the on-chain one
    await keeper.tick();
    expect(chain.funding).toEqual([2, 1]);
    chain.time = 15_600n;
    await keeper.tick();
    expect(chain.funding).toEqual([2, 1, 2]);
  });
});

describe("ViemKeeperChain", () => {
  it("tracks maker, taker, liquidated trader and the liquidator (who takes the position over)", async () => {
    const calls: string[] = [];
    const client = {
      getContractEvents: async ({ eventName }: { eventName: string }) => {
        calls.push(eventName);
        return eventName === "Fill"
          ? [{ args: { marketId: 1, maker: alice.address, taker: bob.address } }]
          : [{ args: { marketId: 2, trader: alice.address, liquidator: carol.address } }];
      },
    };
    const kc = new ViemKeeperChain(client as never, {} as never, carol, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(await kc.touchedPositions(0n, 10n)).toEqual([
      { trader: alice.address, marketId: 1 },
      { trader: bob.address, marketId: 1 },
      { trader: alice.address, marketId: 2 },
      { trader: carol.address, marketId: 2 },
    ]);
    expect(calls.sort()).toEqual(["Fill", "Liquidation"]);
  });
});
