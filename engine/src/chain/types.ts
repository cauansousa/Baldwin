import type { Address, Hex, MarketConfig } from "../types.ts";

/**
 * Read-only view of the Exchange contract. Used for the optional pre-trade check
 * and for attributing on-chain match failures. Injectable so tests can fake it.
 */
export interface ChainReader {
  isCancelled(trader: Address, nonce: bigint): Promise<boolean>;
  /** Base size (WAD) of the order already settled on-chain. */
  filledSize(orderHash: Hex): Promise<bigint>;
  /** USDC units (6 decimals). */
  freeCollateral(trader: Address): Promise<bigint>;
  /** Signed base size (WAD): >0 long, <0 short. */
  positionSize(trader: Address, marketId: number): Promise<bigint>;
  /** Oracle price (WAD). May reject if the oracle is stale. */
  indexPrice(marketId: number): Promise<bigint>;
  /** Timestamp of the latest block, unix seconds. */
  blockTimestamp(): Promise<bigint>;
  paused(): Promise<boolean>;
  /** Half-width of the fill-price band around the index, in bps (immutable on-chain). */
  maxPriceDeviationBps(): Promise<bigint>;
  /** Base WAD per side. */
  openInterest(marketId: number): Promise<{ longs: bigint; shorts: bigint }>;
  /** Current market parameters. */
  getMarket(marketId: number): Promise<MarketConfig>;
}
