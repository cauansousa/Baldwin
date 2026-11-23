import { BPS, WAD } from "../../../shared/src/index.ts";
import { errMessage, silentLogger, type Address, type Logger } from "../types.ts";

/** Chain access the keeper needs. Injectable so the logic can be tested with a fake. */
export interface KeeperChain {
  blockNumber(): Promise<bigint>;
  /** (trader, market) pairs whose position was touched by Fill or Liquidation events in [from, to]. */
  touchedPositions(from: bigint, to: bigint): Promise<{ trader: Address; marketId: number }[]>;
  /** Signed base size (WAD). */
  positionSize(trader: Address, marketId: number): Promise<bigint>;
  isLiquidatable(trader: Address): Promise<boolean>;
  /** Liquidate up to `maxSize` (base WAD); resolves once mined, rejects if it would revert or reverted. */
  liquidate(trader: Address, marketId: number, maxSize: bigint): Promise<void>;
  /** The keeper account's own free collateral, USDC units. */
  ownFreeCollateral(): Promise<bigint>;
  /** Oracle price (WAD). */
  indexPrice(marketId: number): Promise<bigint>;
  initialMarginBps(marketId: number): Promise<bigint>;
  /** Resolves once mined. */
  updateFunding(marketId: number): Promise<void>;
}

export interface KeeperOptions {
  chain: KeeperChain;
  marketIds: number[];
  /** First block to scan for events. */
  startBlock?: bigint;
  /** Max block span per log query. Default 2000. */
  maxBlockRange?: bigint;
  /** The keeper's own address: never liquidated by itself. */
  self?: Address;
  /** Seconds between updateFunding rounds. Default 3600. */
  fundingIntervalSec?: number;
  /** Unix seconds. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Liquidation + funding keeper.
 *
 * Each `tick`:
 *  1. reads new Fill/Liquidation events and records which accounts hold positions;
 *  2. for every tracked account, drops closed positions, and if `isLiquidatable`
 *     calls `liquidate` on its open positions until the account is healthy again.
 *     The whole position is tried first. In the current Exchange the liquidator takes
 *     the position over and must margin it, so if that fails the keeper retries with
 *     the size its own free collateral supports;
 *  3. calls `updateFunding` for every market when the funding interval has elapsed
 *     (and once at start-up; the contract ignores calls that come too early).
 */
export class Keeper {
  /** trader (lower-case) -> markets with a possibly open position. */
  private readonly tracked = new Map<string, { trader: Address; markets: Set<number> }>();
  private nextBlock: bigint;
  private nextFundingAt = 0;
  private readonly chain: KeeperChain;
  private readonly marketIds: number[];
  private readonly maxRange: bigint;
  private readonly fundingIntervalSec: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly self: string | undefined;

  constructor(opts: KeeperOptions) {
    this.chain = opts.chain;
    this.self = opts.self?.toLowerCase();
    this.marketIds = opts.marketIds;
    this.nextBlock = opts.startBlock ?? 0n;
    this.maxRange = opts.maxBlockRange ?? 2000n;
    this.fundingIntervalSec = opts.fundingIntervalSec ?? 3600;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = opts.logger ?? silentLogger;
  }

  trackedAccounts(): Address[] {
    return [...this.tracked.values()].map((t) => t.trader);
  }

  async tick(): Promise<void> {
    await this.step("event sync", () => this.syncEvents());
    await this.step("liquidations", () => this.checkLiquidations());
    await this.step("funding", () => this.updateFunding());
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error(`keeper ${name} failed`, { error: errMessage(e) });
    }
  }

  private async syncEvents(): Promise<void> {
    const head = await this.chain.blockNumber();
    while (this.nextBlock <= head) {
      const to = this.nextBlock + this.maxRange - 1n < head ? this.nextBlock + this.maxRange - 1n : head;
      for (const { trader, marketId } of await this.chain.touchedPositions(this.nextBlock, to)) {
        const key = trader.toLowerCase();
        let entry = this.tracked.get(key);
        if (!entry) this.tracked.set(key, (entry = { trader, markets: new Set() }));
        entry.markets.add(marketId);
      }
      this.nextBlock = to + 1n;
    }
  }

  private async checkLiquidations(): Promise<void> {
    for (const [key, entry] of this.tracked) {
      if (key === this.self) continue;
      try {
        const open: [number, bigint][] = [];
        for (const marketId of entry.markets) {
          const size = await this.chain.positionSize(entry.trader, marketId);
          if (size === 0n) entry.markets.delete(marketId);
          else open.push([marketId, size < 0n ? -size : size]);
        }
        if (open.length === 0) {
          this.tracked.delete(key);
          continue;
        }
        for (const [marketId, size] of open) {
          if (!(await this.chain.isLiquidatable(entry.trader))) break;
          await this.liquidate(entry.trader, marketId, size);
        }
      } catch (e) {
        this.log.warn("liquidation check failed", { trader: entry.trader, error: errMessage(e) });
      }
    }
  }

  private async liquidate(trader: Address, marketId: number, size: bigint): Promise<void> {
    this.log.info("liquidating", { trader, marketId, size });
    try {
      await this.chain.liquidate(trader, marketId, size);
      return;
    } catch (e) {
      this.log.warn("full liquidation failed", { trader, marketId, error: errMessage(e) });
    }
    try {
      const affordable = await this.affordableSize(marketId);
      if (affordable === 0n || affordable >= size) return;
      this.log.info("liquidating partially", { trader, marketId, size: affordable });
      await this.chain.liquidate(trader, marketId, affordable);
    } catch (e) {
      this.log.warn("partial liquidation failed", { trader, marketId, error: errMessage(e) });
    }
  }

  /** Base size the keeper can take over with 90% of its free collateral at initial margin. */
  private async affordableSize(marketId: number): Promise<bigint> {
    const [free, price, imBps] = await Promise.all([
      this.chain.ownFreeCollateral(),
      this.chain.indexPrice(marketId),
      this.chain.initialMarginBps(marketId),
    ]);
    if (price === 0n || imBps === 0n) return 0n;
    const budget = (free * 9n) / 10n; // USDC units
    return (budget * 10n ** 12n * WAD * BPS) / (price * imBps);
  }

  private async updateFunding(): Promise<void> {
    const now = this.now();
    if (now < this.nextFundingAt) return;
    let allOk = true;
    for (const marketId of this.marketIds) {
      try {
        await this.chain.updateFunding(marketId);
        this.log.info("funding updated", { marketId });
      } catch (e) {
        allOk = false;
        this.log.warn("updateFunding failed", { marketId, error: errMessage(e) });
      }
    }
    // On any failure the whole round is retried on the next tick (extra calls are no-ops on-chain).
    if (allOk) this.nextFundingAt = now + this.fundingIntervalSec;
  }
}
