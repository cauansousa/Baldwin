import { BPS, WAD } from "../../../shared/src/index.ts";
import { LogPoller } from "../chain/logPoller.ts";
import { errMessage, silentLogger, type Address, type Logger } from "../types.ts";
import type { KeeperStateStore } from "./state.ts";

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
  /** Unix seconds of the market's last funding accrual on-chain. */
  lastFundingTime(marketId: number): Promise<bigint>;
  /** Timestamp of the latest block, unix seconds. */
  blockTimestamp(): Promise<bigint>;
}

export interface KeeperOptions {
  chain: KeeperChain;
  marketIds: number[];
  /** First block to scan for events when no cursor is stored. Default 0. */
  startBlock?: bigint;
  /** Where the event cursor and the tracked accounts are kept across restarts. */
  state?: KeeperStateStore;
  /** Called on every failed chain query (metrics). */
  onRpcError?: (e: unknown) => void;
  /** Max block span per log query. Default 2000. */
  maxBlockRange?: bigint;
  /** The keeper's own address: never liquidated by itself. */
  self?: Address;
  /** The contract's funding interval in seconds. Default 3600. */
  fundingIntervalSec?: number;
  /** Unix seconds. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Liquidation + funding keeper.
 *
 * Each `tick`:
 *  1. reads new Fill/Liquidation events (block-range polling with a stored cursor, see
 *     LogPoller) and records which accounts hold positions; cursor and accounts are
 *     saved together, so a restart continues without rescanning or forgetting anyone;
 *  2. for every tracked account, drops closed positions, and if `isLiquidatable`
 *     calls `liquidate` on its open positions until the account is healthy again.
 *     The whole position is tried first. In the current Exchange the liquidator takes
 *     the position over and must margin it, so if that fails the keeper retries with
 *     the size its own free collateral supports;
 *  3. calls `updateFunding` for every market whose on-chain `lastFundingTime` is at
 *     least one funding interval old. The schedule lives on-chain: a restarted keeper
 *     neither skips nor repeats a round, and a failed call is retried on the next tick.
 */
export class Keeper {
  /** trader (lower-case) -> markets with a possibly open position. */
  private readonly tracked = new Map<string, { trader: Address; markets: Set<number> }>();
  private readonly poller: LogPoller<{ trader: Address; marketId: number }>;
  private readonly state: KeeperStateStore | undefined;
  private cursor: bigint | undefined;
  private readonly chain: KeeperChain;
  private readonly marketIds: number[];
  private readonly maxRange: bigint;
  private readonly fundingIntervalSec: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly self: string | undefined;
  private readonly onRpcError: ((e: unknown) => void) | undefined;

  constructor(opts: KeeperOptions) {
    this.chain = opts.chain;
    this.self = opts.self?.toLowerCase();
    this.onRpcError = opts.onRpcError;
    this.marketIds = opts.marketIds;
    this.maxRange = opts.maxBlockRange ?? 2000n;
    this.state = opts.state;
    const saved = this.state?.load();
    if (saved) {
      this.cursor = saved.cursor;
      for (const t of saved.tracked) this.tracked.set(t.trader.toLowerCase(), { trader: t.trader, markets: new Set(t.markets) });
    }
    this.poller = new LogPoller({
      name: "keeper events",
      head: () => this.chain.blockNumber(),
      fetch: (from, to) => this.chain.touchedPositions(from, to),
      handle: (events) => {
        for (const { trader, marketId } of events) {
          const key = trader.toLowerCase();
          let entry = this.tracked.get(key);
          if (!entry) this.tracked.set(key, (entry = { trader, markets: new Set() }));
          entry.markets.add(marketId);
        }
      },
      loadCursor: () => this.cursor,
      saveCursor: (b) => {
        this.cursor = b;
        this.save();
      },
      startBlock: opts.startBlock ?? 0n,
      maxRange: this.maxRange,
      logger: opts.logger,
      onError: opts.onRpcError,
    });
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
      this.onRpcError?.(e);
      this.log.error(`keeper ${name} failed`, { error: errMessage(e) });
    }
  }

  private save(): void {
    this.state?.save({ cursor: this.cursor, tracked: [...this.tracked.values()].map((t) => ({ trader: t.trader, markets: [...t.markets] })) });
  }

  private syncEvents(): Promise<void> {
    return this.poller.poll();
  }

  private async checkLiquidations(): Promise<void> {
    const before = this.trackedSignature();
    try {
      await this.checkAll();
    } finally {
      if (this.trackedSignature() !== before) this.save();
    }
  }

  private trackedSignature(): string {
    return [...this.tracked].map(([k, v]) => `${k}:${[...v.markets].join(",")}`).join("|");
  }

  private async checkAll(): Promise<void> {
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
          let liquidatable: boolean;
          try {
            liquidatable = await this.chain.isLiquidatable(entry.trader);
          } catch (e) {
            // The account views revert when the oracle fails for ANY market the account is
            // in. The contract can still liquidate a market whose own price is fresh, so
            // try exactly those; `liquidate` is simulated first and simply refuses if
            // the account is healthy.
            this.onRpcError?.(e);
            await this.liquidateBlind(entry.trader, marketId, size);
            continue;
          }
          if (!liquidatable) break;
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

  /** Liquidation attempt without knowing whether the account is liquidatable (views unavailable). */
  private async liquidateBlind(trader: Address, marketId: number, size: bigint): Promise<void> {
    try {
      await this.chain.indexPrice(marketId);
    } catch {
      return; // this market's own price is unavailable: nothing can be done here
    }
    try {
      await this.chain.liquidate(trader, marketId, size);
      this.log.info("liquidated while account views were unavailable", { trader, marketId, size });
      return;
    } catch {
      // not liquidatable, or the keeper cannot margin the whole position
    }
    try {
      const affordable = await this.affordableSize(marketId);
      if (affordable === 0n || affordable >= size) return;
      await this.chain.liquidate(trader, marketId, affordable);
      this.log.info("liquidated partially while account views were unavailable", { trader, marketId, size: affordable });
    } catch {
      // as above
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
    // The contract compares against block time; a new block cannot be older than
    // either the latest block or (on a live chain) the wall clock.
    const blockTime = await this.chain.blockTimestamp();
    const wall = BigInt(this.now());
    const now = blockTime > wall ? blockTime : wall;
    for (const marketId of this.marketIds) {
      try {
        const last = await this.chain.lastFundingTime(marketId);
        if (now < last + BigInt(this.fundingIntervalSec)) continue;
        await this.chain.updateFunding(marketId);
        this.log.info("funding updated", { marketId });
      } catch (e) {
        this.log.warn("updateFunding failed", { marketId, error: errMessage(e) });
      }
    }
  }
}
