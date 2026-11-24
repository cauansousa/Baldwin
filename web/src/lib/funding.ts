// Funding maths, mirroring Exchange.sol. Everything shown from these is an
// estimate except `pendingFundingUsdc`, which is what the contract will settle
// for funding already accrued in the cumulative index.

import { WAD } from "@shared";
import { USDC_TO_WAD, formatUnits } from "./units";

/** Exchange.FUNDING_INTERVAL: funding accrues at most once per hour. */
export const FUNDING_INTERVAL_SECONDS = 3600n;

/** Truncating division is fine for display, but keep it symmetric around zero. */
const divTrunc = (a: bigint, b: bigint) => a / b;

/**
 * Funding accrued in the cumulative index but not yet settled into the
 * balance, in USDC units. Positive = the trader owes it (it is subtracted from
 * account value); negative = the trader is owed.
 *   size (WAD, signed) * (cumulative - snapshot) (USD-WAD per unit of base)
 */
export function pendingFundingUsdc(sizeWad: bigint, lastCumulativeFunding: bigint, cumulativeFunding: bigint): bigint {
  return divTrunc(sizeWad * (cumulativeFunding - lastCumulativeFunding), WAD * USDC_TO_WAD);
}

/**
 * Estimated payment at the next accrual if the rate, the index price and the
 * position stay as they are and exactly one interval is applied, in USDC
 * units. Positive = the trader pays. `ratePerHourWad`: 1e18 = 100% per hour,
 * positive = longs pay shorts.
 */
export function estimateNextFundingUsdc(sizeWad: bigint, indexPriceWad: bigint, ratePerHourWad: bigint): bigint {
  return divTrunc(sizeWad * indexPriceWad * ratePerHourWad, WAD * WAD * USDC_TO_WAD);
}

export type FundingDirection = "longs_pay" | "shorts_pay" | "none";

export function fundingDirection(ratePerHourWad: bigint): FundingDirection {
  return ratePerHourWad > 0n ? "longs_pay" : ratePerHourWad < 0n ? "shorts_pay" : "none";
}

/** "+0,0125%" — the hourly rate as a signed percentage. */
export function formatFundingRate(ratePerHourWad: bigint): string {
  // WAD -> percent: 1e18 = 100%, i.e. 16 decimals.
  return `${formatUnits(ratePerHourWad, 16, { maxFraction: 4, showPlus: true })}%`;
}

/** Earliest time (unix seconds) at which the next accrual can happen. */
export function nextFundingTime(lastFundingTimeSec: bigint): bigint {
  return lastFundingTimeSec + FUNDING_INTERVAL_SECONDS;
}

/** "mm:ss" (or "h:mm:ss") until `targetSec`; null once it is due. */
export function formatCountdown(targetSec: bigint, nowSec: bigint): string | null {
  const left = targetSec - nowSec;
  if (left <= 0n) return null;
  const pad = (n: bigint) => n.toString().padStart(2, "0");
  const h = left / 3600n;
  const m = (left % 3600n) / 60n;
  const s = left % 60n;
  return h > 0n ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
