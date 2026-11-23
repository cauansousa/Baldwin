import { describe, expect, it } from "vitest";
import {
  entryPriceWad,
  estimateLiquidationPrice,
  estimateOrder,
  marginUsageBps,
  mulBps,
  notionalUsdc,
  unrealizedPnlUsdc,
} from "./risk";

const WAD = 10n ** 18n;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const wad = (n: number) => (BigInt(Math.round(n * 1e6)) * WAD) / 1_000_000n;

describe("notional / fees / margin", () => {
  it("computes notional in USDC units", () => {
    expect(notionalUsdc(wad(0.35), wad(97_432.5))).toBe(usdc(34_101.375));
    expect(notionalUsdc(-wad(4.2), wad(3_415.2))).toBe(usdc(14_343.84));
    expect(notionalUsdc(0n, wad(100))).toBe(0n);
  });

  it("rounds sub-unit notional down", () => {
    // 1 wei of base at $1 is far below one USDC unit.
    expect(notionalUsdc(1n, WAD)).toBe(0n);
  });

  it("estimates fee and initial margin for an order", () => {
    const est = estimateOrder({ sizeWad: wad(2), priceWad: wad(3_000), initialMarginBps: 1000, feeBps: 5 });
    expect(est.notional).toBe(usdc(6_000));
    expect(est.fee).toBe(usdc(3));
    expect(est.initialMargin).toBe(usdc(600));
  });

  it("mulBps floors", () => {
    expect(mulBps(999n, 5)).toBe(0n);
    expect(mulBps(10_000n, 5)).toBe(5n);
  });

  it("margin usage", () => {
    expect(marginUsageBps(usdc(500), usdc(2_000))).toBe(2_500n);
    expect(marginUsageBps(0n, 0n)).toBe(0n);
    expect(marginUsageBps(usdc(1), 0n)).toBeNull();
    expect(marginUsageBps(usdc(1), -usdc(5))).toBeNull();
    expect(marginUsageBps(usdc(3_000), usdc(2_000))).toBe(15_000n);
  });
});

describe("entry price and PnL", () => {
  it("derives the entry price from entryNotional / |size|", () => {
    expect(entryPriceWad(usdc(33_670), wad(0.35))).toBe(wad(96_200));
    expect(entryPriceWad(usdc(14_616), -wad(4.2))).toBe(wad(3_480));
    expect(entryPriceWad(0n, 0n)).toBeNull();
  });

  it("long gains when price rises, short gains when it falls", () => {
    expect(unrealizedPnlUsdc(wad(1), usdc(10_000), wad(10_500))).toBe(usdc(500));
    expect(unrealizedPnlUsdc(wad(1), usdc(10_000), wad(9_000))).toBe(-usdc(1_000));
    expect(unrealizedPnlUsdc(-wad(2), usdc(20_000), wad(9_000))).toBe(usdc(2_000));
    expect(unrealizedPnlUsdc(-wad(2), usdc(20_000), wad(10_250))).toBe(-usdc(500));
    expect(unrealizedPnlUsdc(0n, 0n, wad(1))).toBe(0n);
  });
});

describe("estimateLiquidationPrice", () => {
  // Checks the defining property: at the returned price, account value equals
  // the maintenance requirement (within rounding).
  function equityGap(p: {
    sizeWad: bigint;
    indexPriceWad: bigint;
    accountValue: bigint;
    maintenanceRequirement: bigint;
    maintenanceMarginBps: number;
    liq: bigint;
  }) {
    const abs = p.sizeWad < 0n ? -p.sizeWad : p.sizeWad;
    const ownNow = mulBps(notionalUsdc(abs, p.indexPriceWad), p.maintenanceMarginBps);
    const other = p.maintenanceRequirement - ownNow;
    const valueAtLiq = p.accountValue + (p.sizeWad * (p.liq - p.indexPriceWad)) / WAD / 10n ** 12n;
    const maintenanceAtLiq = other + mulBps(notionalUsdc(abs, p.liq), p.maintenanceMarginBps);
    return valueAtLiq - maintenanceAtLiq;
  }

  it("single long", () => {
    const input = {
      sizeWad: wad(1),
      indexPriceWad: wad(10_000),
      accountValue: usdc(2_000),
      maintenanceRequirement: usdc(1_000),
      maintenanceMarginBps: 1000,
    };
    const liq = estimateLiquidationPrice(input)!;
    // (10000 - 2000) / 0.9
    expect(liq).toBe((8_000n * WAD * 10n) / 9n);
    expect(liq).toBeLessThan(input.indexPriceWad);
    const gap = equityGap({ ...input, liq });
    expect(gap >= -2n && gap <= 2n).toBe(true);
  });

  it("single short", () => {
    const input = {
      sizeWad: -wad(1),
      indexPriceWad: wad(10_000),
      accountValue: usdc(2_000),
      maintenanceRequirement: usdc(1_000),
      maintenanceMarginBps: 1000,
    };
    const liq = estimateLiquidationPrice(input)!;
    // (2000 + 10000) / 1.1
    expect(liq).toBe((12_000n * WAD * 10n) / 11n);
    expect(liq).toBeGreaterThan(input.indexPriceWad);
    const gap = equityGap({ ...input, liq });
    expect(gap >= -2n && gap <= 2n).toBe(true);
  });

  it("is exactly the index price when the account sits on its maintenance margin", () => {
    expect(
      estimateLiquidationPrice({
        sizeWad: wad(1),
        indexPriceWad: wad(10_000),
        accountValue: usdc(1_000),
        maintenanceRequirement: usdc(1_000),
        maintenanceMarginBps: 1000,
      }),
    ).toBe(wad(10_000));
  });

  it("is beyond the index price (already liquidatable) when under maintenance", () => {
    const liq = estimateLiquidationPrice({
      sizeWad: wad(1),
      indexPriceWad: wad(10_000),
      accountValue: usdc(500),
      maintenanceRequirement: usdc(1_000),
      maintenanceMarginBps: 1000,
    })!;
    expect(liq).toBeGreaterThan(wad(10_000));
  });

  it("accounts for maintenance margin held by other positions (cross margin)", () => {
    const base = {
      sizeWad: wad(0.35),
      indexPriceWad: wad(97_432.5),
      accountValue: usdc(13_203.535),
      maintenanceMarginBps: 500,
    };
    const ownMaintenance = mulBps(notionalUsdc(base.sizeWad, base.indexPriceWad), 500);
    const alone = estimateLiquidationPrice({ ...base, maintenanceRequirement: ownMaintenance })!;
    const withOther = { ...base, maintenanceRequirement: ownMaintenance + usdc(717.192) };
    const crossed = estimateLiquidationPrice(withOther)!;
    // Other positions consume margin, so liquidation comes sooner (higher price for a long).
    expect(crossed).toBeGreaterThan(alone);
    const gap = equityGap({ ...withOther, liq: crossed });
    expect(gap >= -2n && gap <= 2n).toBe(true);
  });

  it("returns null when a long is fully collateralized (no positive liquidation price)", () => {
    expect(
      estimateLiquidationPrice({
        sizeWad: wad(1),
        indexPriceWad: wad(10_000),
        accountValue: usdc(10_000),
        maintenanceRequirement: usdc(1_000),
        maintenanceMarginBps: 1000,
      }),
    ).toBeNull();
  });

  it("returns null for a flat position or degenerate inputs", () => {
    const base = { indexPriceWad: wad(100), accountValue: usdc(10), maintenanceRequirement: 0n, maintenanceMarginBps: 500 };
    expect(estimateLiquidationPrice({ ...base, sizeWad: 0n })).toBeNull();
    expect(estimateLiquidationPrice({ ...base, sizeWad: wad(1), indexPriceWad: 0n })).toBeNull();
    expect(estimateLiquidationPrice({ ...base, sizeWad: wad(1), maintenanceMarginBps: 10_000 })).toBeNull();
  });
});
