// Combines what the engine reports on GET /markets with contract reads.
// The engine mirrors a number of contract views so that the page needs fewer
// RPC calls; a field the engine reports as null (or does not send) is read
// from the contract instead.

import { FUNDING_INTERVAL_SECONDS } from "./funding";

/** Contract figures as the engine last read them. `undefined` = not reported, read the chain. */
export interface EngineMarketStats {
  indexPrice?: bigint; // WAD
  lastPrice?: bigint; // WAD, last confirmed fill
  markTwap?: bigint; // WAD
  /**
   * WAD per hour, positive = longs pay. The contract's view is authoritative
   * (0 while paused or for an inactive market). `null` = the engine says it is
   * unavailable: shown as "—", never as 0 and never derived from the TWAP.
   */
  currentFundingRate?: bigint | null;
  lastFundingTime?: bigint; // unix seconds
  nextFundingTime?: bigint; // unix seconds
  openInterestLong?: bigint; // base, WAD
  openInterestShort?: bigint;
}

/** The same figures read from the contract (only those that were requested). */
export interface ChainMarketReads {
  indexPrice?: bigint;
  markPrice?: bigint;
  markTwap?: bigint;
  fundingRate?: bigint;
  lastFundingTime?: bigint;
  openInterest?: { longs: bigint; shorts: bigint };
}

export type MarketRead = "indexPrice" | "markPrice" | "markTwap" | "currentFundingRate" | "lastFundingTime" | "openInterest";

/** Contract views that still have to be read because the engine did not supply them. */
export function missingReads(stats: EngineMarketStats | undefined): MarketRead[] {
  const s = stats ?? {};
  const missing: MarketRead[] = [];
  if (s.indexPrice === undefined) missing.push("indexPrice");
  if (s.lastPrice === undefined) missing.push("markPrice");
  if (s.markTwap === undefined) missing.push("markTwap");
  if (s.currentFundingRate === undefined) missing.push("currentFundingRate");
  // The countdown needs either the engine's next time or the last accrual.
  if (s.nextFundingTime === undefined && s.lastFundingTime === undefined) missing.push("lastFundingTime");
  if (s.openInterestLong === undefined || s.openInterestShort === undefined) missing.push("openInterest");
  return missing;
}

export interface MarketFigures {
  indexPrice?: bigint;
  markPrice?: bigint;
  /** Undefined when unavailable (the contract returns 0 without an index price). */
  markTwap?: bigint;
  /** Undefined when the index price is unavailable (the contract then reports 0, which is not a real rate). */
  fundingRate?: bigint;
  nextFundingTime?: bigint;
  openInterest?: { longs: bigint; shorts: bigint };
}

const positive = (v: bigint | undefined) => (v !== undefined && v > 0n ? v : undefined);

/** Engine value where present, contract read otherwise. */
export function mergeMarketFigures(stats: EngineMarketStats | undefined, chain: ChainMarketReads | undefined): MarketFigures {
  const s = stats ?? {};
  const c = chain ?? {};
  const indexPrice = positive(s.indexPrice) ?? positive(c.indexPrice);
  const lastFundingTime = positive(s.lastFundingTime) ?? positive(c.lastFundingTime);
  const openInterest =
    s.openInterestLong !== undefined && s.openInterestShort !== undefined
      ? { longs: s.openInterestLong, shorts: s.openInterestShort }
      : c.openInterest;
  return {
    indexPrice,
    markPrice: positive(s.lastPrice) ?? positive(c.markPrice),
    markTwap: positive(s.markTwap) ?? positive(c.markTwap),
    fundingRate:
      s.currentFundingRate === null || indexPrice === undefined
        ? undefined
        : s.currentFundingRate !== undefined
          ? s.currentFundingRate
          : c.fundingRate,
    nextFundingTime:
      positive(s.nextFundingTime) ?? (lastFundingTime !== undefined ? lastFundingTime + FUNDING_INTERVAL_SECONDS : undefined),
    openInterest,
  };
}
