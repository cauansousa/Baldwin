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
  /**
   * Whether `liquidate(trader, marketId, ...)` would be accepted: same valuation as the
   * contract uses there. Rejects if this market's own price is unavailable.
   */
  isLiquidatableIn(trader: Address, marketId: number): Promise<boolean>;
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

export interface KeeperStatus {
  trackedAccounts: number;
  eventCursor: bigint | null;
  eventsCaughtUp: boolean;
  liquidations: number;
  liquidationFailures: number;
  lastLiquidation: { trader: Address; marketId: number; size: bigint; at: number } | null;
  positionsInBackoff: number;
  /** Unix seconds of the last tick. */
  lastTickAt: number;
}

export interface KeeperOptions {
  chain: KeeperChain;
  marketIds: number[];
  /** First block to scan for events when no cursor is stored. Default 0. */
  startBlock?: bigint;
  /** Where the event cursor and the tracked accounts are kept across restarts. */
  state?: KeeperStateStore;
  /** Log queries stop this many blocks short of the head (see LogPoller). Default 2. */
  headLag?: bigint;
  /** Blocks re-scanned on every pass. Default 5. */
  overlap?: bigint;
  /** A position is forgotten after this many consecutive ticks reading it as zero. Default 3. */
  untrackAfterZeroReads?: number;
  /**
   * Called before a position in `marketId` is taken over, so that an order resting on
   * the keeper's existing position there can be withdrawn first (see Unwinder). A
   * failure here does not stop the liquidation.
   */
  beforeLiquidate?: (marketId: number) => Promise<void>;
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
 *  2. for every tracked account, drops positions that read as closed on several
 *     consecutive ticks, and if `isLiquidatable` (or, when that view reverts because
 *     some other feed is down, `isLiquidatableIn` for the market) calls `liquidate`
 *     on its open positions until the account is healthy again. Attempts that fail
 *     (typically: the keeper cannot margin the position) are retried with backoff.
 *     The whole position is tried first. In the current Exchange the liquidator takes
 *     the position over and must margin it, so if that fails the keeper retries with
 *     the size its own free collateral supports;
 *  3. calls `updateFunding` for every market whose on-chain `lastFundingTime` is at
 *     least one funding interval older than the latest block. The schedule lives on-chain: a restarted keeper
 *     neither skips nor repeats a round, and a failed call is retried on the next tick.
 */
export class Keeper {
  /** trader (lower-case) -> markets with a possibly open position. */
  private readonly tracked = new Map<string, { trader: Address; markets: Set<number> }>();
  private readonly poller: LogPoller<{ trader: Address; marketId: number }>;
  private readonly state: KeeperStateStore | undefined;
  private cursor: bigint | undefined;
  private ticks = 0;
  private readonly zeroReads = new Map<string, number>();
  private readonly backoff = new Map<string, { fails: number; until: number }>();
  private readonly untrackAfterZeroReads: number;
  private readonly chain: KeeperChain;
  private readonly marketIds: number[];
  private readonly maxRange: bigint;
  private readonly fundingIntervalSec: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly self: string | undefined;
  private readonly onRpcError: ((e: unknown) => void) | undefined;
  private readonly beforeLiquidate: ((marketId: number) => Promise<void>) | undefined;
  private liquidations = 0;
  private liquidationFailures = 0;
  private lastLiquidation: { trader: Address; marketId: number; size: bigint; at: number } | null = null;
  private lastTickAt = 0;

  constructor(opts: KeeperOptions) {
    this.beforeLiquidate = opts.beforeLiquidate;
    this.chain = opts.chain;
    this.self = opts.self?.toLowerCase();
    this.onRpcError = opts.onRpcError;
    this.marketIds = opts.marketIds;
    this.maxRange = opts.maxBlockRange ?? 2000n;
    this.state = opts.state;
    this.untrackAfterZeroReads = Math.max(1, opts.untrackAfterZeroReads ?? 3);
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
      headLag: opts.headLag,
      overlap: opts.overlap,
      // A long history is read a few ranges per tick: accounts already known are
      // checked for liquidation in between, not only once the whole scan is done.
      maxRangesPerPoll: 10,
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

  /** For /health, metrics and the heartbeat log line. */
  status(): KeeperStatus {
    return {
      trackedAccounts: this.tracked.size,
      eventCursor: this.cursor ?? null,
      eventsCaughtUp: this.poller.isCaughtUp,
      liquidations: this.liquidations,
      liquidationFailures: this.liquidationFailures,
      lastLiquidation: this.lastLiquidation,
      positionsInBackoff: [...this.backoff.values()].filter((b) => b.until > this.ticks).length,
      lastTickAt: this.lastTickAt,
    };
  }

  async tick(): Promise<void> {
    this.lastTickAt = this.now();
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
    this.ticks++;
    for (const [key, entry] of this.tracked) {
      if (key === this.self) continue;
      try {
        const open: [number, bigint][] = [];
        for (const marketId of entry.markets) {
          const size = await this.chain.positionSize(entry.trader, marketId);
          const zk = `${key}:${marketId}`;
          if (size !== 0n) {
            this.zeroReads.delete(zk);
            open.push([marketId, size < 0n ? -size : size]);
            continue;
          }
          // One zero read proves nothing: the node that answered may be a block behind
          // the one that served the Fill event. Forget the position only after several.
          const zeros = (this.zeroReads.get(zk) ?? 0) + 1;
          if (zeros >= this.untrackAfterZeroReads) {
            entry.markets.delete(marketId);
            this.zeroReads.delete(zk);
          } else {
            this.zeroReads.set(zk, zeros);
          }
        }
        if (entry.markets.size === 0) {
          this.tracked.delete(key);
          continue;
        }
        for (const [marketId, size] of open) {
          const bk = `${key}:${marketId}`;
          const backoff = this.backoff.get(bk);
          if (backoff && this.ticks < backoff.until) continue;
          let liquidatable: boolean;
          try {
            liquidatable = await this.chain.isLiquidatable(entry.trader);
            if (!liquidatable) break;
          } catch (e) {
            // The account-wide view reverts when the oracle fails for ANY market the
            // account is in. `isLiquidatableIn` values the account the way `liquidate`
            // does (other markets without a price at entry) and only needs this
            // market's own price.
            this.onRpcError?.(e);
            try {
              liquidatable = await this.chain.isLiquidatableIn(entry.trader, marketId);
            } catch {
              continue; // this market's own price is unavailable: nothing can be done here now
            }
            if (!liquidatable) continue;
          }
          const done = await this.liquidate(entry.trader, marketId, size);
          if (done) {
            this.backoff.delete(bk);
          } else {
            // Could not (afford to) liquidate: do not hammer the node with the same
            // doomed attempt every tick. 2, 4, 8, ... ticks, at most 64.
            const fails = (backoff?.fails ?? 0) + 1;
            this.backoff.set(bk, { fails, until: this.ticks + Math.min(64, 2 ** fails) });
          }
        }
      } catch (e) {
        this.log.warn("liquidation check failed", { trader: entry.trader, error: errMessage(e) });
      }
    }
  }

  /** Liquidate the whole position, or as much as the keeper can margin. True if anything was liquidated. */
  private async liquidate(trader: Address, marketId: number, size: bigint): Promise<boolean> {
    const done = await this.tryLiquidate(trader, marketId, size);
    if (done === 0n) this.liquidationFailures++;
    else {
      this.liquidations++;
      this.lastLiquidation = { trader, marketId, size: done, at: this.now() };
    }
    return done !== 0n;
  }

  /** Returns the size liquidated (0 if none). */
  private async tryLiquidate(trader: Address, marketId: number, size: bigint): Promise<bigint> {
    this.log.info("liquidating", { trader, marketId, size });
    // Taking a position over changes the keeper's own position in this market: an order
    // resting on the old position must go first, or it could fail on-chain later.
    try {
      await this.beforeLiquidate?.(marketId);
    } catch (e) {
      this.log.warn("could not withdraw the unwind order before liquidating; liquidating anyway", { marketId, error: errMessage(e) });
    }
    try {
      await this.chain.liquidate(trader, marketId, size);
      return size;
    } catch (e) {
      this.log.warn("full liquidation failed", { trader, marketId, error: errMessage(e) });
    }
    try {
      const affordable = await this.affordableSize(marketId);
      if (affordable === 0n || affordable >= size) {
        this.log.warn("cannot liquidate: the keeper has no free collateral to take the position over", { trader, marketId });
        return 0n;
      }
      this.log.info("liquidating partially", { trader, marketId, size: affordable });
      await this.chain.liquidate(trader, marketId, affordable);
      return affordable;
    } catch (e) {
      this.log.warn("partial liquidation failed", { trader, marketId, error: errMessage(e) });
      return 0n;
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
    // The contract compares against block.timestamp, and it accrues nothing (a no-op
    // that still costs gas) before a full interval has passed. The latest block's
    // timestamp is a lower bound for the next block's, so "due by the latest block"
    // means the call will do something. The host clock is deliberately not used.
    const now = await this.chain.blockTimestamp();
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
