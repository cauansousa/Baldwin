import { describe, expect, it } from "vitest";
import { Keeper, type KeeperChain } from "../src/keeper/keeper.ts";
import type { Address } from "../src/types.ts";
import { alice, bob } from "./helpers.ts";

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
  async updateFunding(marketId: number) {
    if (this.fundingFails) throw new Error("revert");
    this.funding.push(marketId);
  }
}

describe("Keeper", () => {
  it("tracks accounts from events in bounded block ranges and never rescans", async () => {
    const chain = new FakeKeeperChain();
    chain.head = 25n;
    chain.events = [{ block: 3n, trader: alice.address, marketId: 1 }, { block: 22n, trader: bob.address, marketId: 1 }];
    chain.positions.set(`${alice.address}:1`, 5n);
    chain.positions.set(`${bob.address}:1`, -5n);
    const keeper = new Keeper({ chain, marketIds: [1], maxBlockRange: 10n });
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
    const keeper = new Keeper({ chain, marketIds: [1, 2] });
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
    const keeper = new Keeper({ chain, marketIds: [1] });
    await keeper.tick();
    expect(chain.liquidations).toEqual([[alice.address, 1, (45n * WAD) / 10n]]);
    expect(chain.positions.get(`${alice.address}:1`)).toBe((-55n * WAD) / 10n);
  });

  it("never tries to liquidate itself", async () => {
    const chain = new FakeKeeperChain();
    chain.events = [{ block: 1n, trader: bob.address, marketId: 1 }];
    chain.positions.set(`${bob.address}:1`, 5n);
    chain.liquidatable.add(bob.address);
    const keeper = new Keeper({ chain, marketIds: [1], self: bob.address });
    await keeper.tick();
    expect(chain.liquidations).toEqual([]);
  });

  it("updates funding for every market at start and then once per interval; retries after a failure", async () => {
    const chain = new FakeKeeperChain();
    let now = 10_000;
    const keeper = new Keeper({ chain, marketIds: [1, 2], fundingIntervalSec: 3600, now: () => now });
    await keeper.tick();
    expect(chain.funding).toEqual([1, 2]);
    now += 3599;
    await keeper.tick();
    expect(chain.funding).toEqual([1, 2]);
    now += 1;
    chain.fundingFails = true;
    await keeper.tick();
    chain.fundingFails = false;
    await keeper.tick();
    expect(chain.funding).toEqual([1, 2, 1, 2]);
  });
});
