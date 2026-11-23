// Margin / PnL / liquidation estimates. These mirror the rules in docs/SPEC.md
// but the contract is the source of truth: everything here is a UI estimate.

import { BPS, WAD } from "@shared";
import { USDC_TO_WAD } from "./units";

const abs = (v: bigint) => (v < 0n ? -v : v);

/** |size| * price, in USDC units (6 dec), rounded down. */
export function notionalUsdc(sizeWad: bigint, priceWad: bigint): bigint {
  return (abs(sizeWad) * priceWad) / WAD / USDC_TO_WAD;
}

/** amount * bps / 10_000, rounded down. */
export function mulBps(amount: bigint, bps: bigint | number): bigint {
  return (amount * BigInt(bps)) / BPS;
}

/** Average entry price (WAD) of a position, or null when flat. */
export function entryPriceWad(entryNotionalUsdc: bigint, sizeWad: bigint): bigint | null {
  if (sizeWad === 0n) return null;
  return (entryNotionalUsdc * USDC_TO_WAD * WAD) / abs(sizeWad);
}

/** Unrealized PnL in USDC units at `priceWad` (funding not included). */
export function unrealizedPnlUsdc(sizeWad: bigint, entryNotionalUsdc: bigint, priceWad: bigint): bigint {
  if (sizeWad === 0n) return 0n;
  const value = notionalUsdc(sizeWad, priceWad);
  return sizeWad > 0n ? value - entryNotionalUsdc : entryNotionalUsdc - value;
}

export interface OrderEstimate {
  notional: bigint; // USDC units
  fee: bigint; // USDC units
  initialMargin: bigint; // USDC units
}

/** Notional, fee and initial margin of an order at its limit price. */
export function estimateOrder(p: {
  sizeWad: bigint;
  priceWad: bigint;
  initialMarginBps: bigint | number;
  feeBps: bigint | number;
}): OrderEstimate {
  const notional = notionalUsdc(p.sizeWad, p.priceWad);
  return {
    notional,
    fee: mulBps(notional, p.feeBps),
    initialMargin: mulBps(notional, p.initialMarginBps),
  };
}

/**
 * Initial-margin requirement as a fraction of account value, in bps
 * (10_000 = fully used). Null when there is a requirement but no value left.
 */
export function marginUsageBps(initialRequirement: bigint, accountValue: bigint): bigint | null {
  if (initialRequirement === 0n) return 0n;
  if (accountValue <= 0n) return null;
  return (initialRequirement * BPS) / accountValue;
}

/**
 * Estimated index price (WAD) at which a cross-margined account reaches its
 * maintenance requirement if ONLY this market moves and every other position,
 * price and funding stays as it is now.
 *
 *   accountValue(p) = accountValue + size * (p - index)
 *   maintenance(p)  = otherMaintenance + |size| * p * mmBps
 *
 * Solving accountValue(p) = maintenance(p):
 *   long : p = (notional + otherMaintenance - accountValue) / (|size| * (1 - mm))
 *   short: p = (accountValue + notional - otherMaintenance) / (|size| * (1 + mm))
 *
 * Returns null when the position is flat or no positive price liquidates it.
 */
export function estimateLiquidationPrice(p: {
  sizeWad: bigint; // signed
  indexPriceWad: bigint;
  accountValue: bigint; // USDC units, signed
  maintenanceRequirement: bigint; // USDC units, whole account
  maintenanceMarginBps: bigint | number; // of this market
}): bigint | null {
  const q = abs(p.sizeWad);
  const mm = BigInt(p.maintenanceMarginBps);
  if (q === 0n || p.indexPriceWad <= 0n || mm >= BPS) return null;

  // Work in WAD-denominated USD to keep full precision.
  const notional = (q * p.indexPriceWad) / WAD;
  const ownMaintenance = (notional * mm) / BPS;
  const totalMaintenance = p.maintenanceRequirement * USDC_TO_WAD;
  const otherMaintenance = totalMaintenance > ownMaintenance ? totalMaintenance - ownMaintenance : 0n;
  const accountValue = p.accountValue * USDC_TO_WAD;

  const isLong = p.sizeWad > 0n;
  const numerator = isLong
    ? notional + otherMaintenance - accountValue
    : accountValue + notional - otherMaintenance;
  if (numerator <= 0n) return null;
  const denominator = q * (isLong ? BPS - mm : BPS + mm);
  return (numerator * WAD * BPS) / denominator;
}
