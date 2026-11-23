import { describe, expect, it } from "vitest";
import {
  classifyLimitPrice,
  priceBand,
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

  it("estimates fee at the limit price and initial margin at the index price", () => {
    const est = estimateOrder({
      sizeWad: wad(2),
      priceWad: wad(3_000),
      isBuy: true,
      indexPriceWad: wad(3_000),
      initialMarginBps: 1000,
      feeBps: 5,
    });
    expect(est.notional).toBe(usdc(6_000));
    expect(est.fee).toBe(usdc(3));
    expect(est.initialMargin).toBe(usdc(600));
    expect(est.priceLoss).toBe(0n);
    expect(est.totalCost).toBe(usdc(603));
  });

  it("charges the gap to the index for an aggressive limit, margin still on the index notional", () => {
    const base = { sizeWad: wad(2), indexPriceWad: wad(3_000), initialMarginBps: 1000, feeBps: 5 };
    const buy = estimateOrder({ ...base, priceWad: wad(3_100), isBuy: true });
    expect(buy.initialMargin).toBe(usdc(600)); // 10% of 2 * 3000, not of 2 * 3100
    expect(buy.fee).toBe(usdc(3.1));
    expect(buy.priceLoss).toBe(usdc(200));
    expect(buy.totalCost).toBe(usdc(803.1));
    const sell = estimateOrder({ ...base, priceWad: wad(2_950), isBuy: false });
    expect(sell.priceLoss).toBe(usdc(100));
    expect(sell.initialMargin).toBe(usdc(600));
    // Passive prices cost nothing extra.
    expect(estimateOrder({ ...base, priceWad: wad(2_900), isBuy: true }).priceLoss).toBe(0n);
    expect(estimateOrder({ ...base, priceWad: wad(3_100), isBuy: false }).priceLoss).toBe(0n);
  });

  it("rounds fee, margin and loss up, and falls back to the limit price without an index", () => {
    // 0.000001 base at $1.50 = 1.5 USDC units of notional -> ceil 2; 10% -> ceil 1; 5 bps -> ceil 1.
    const est = estimateOrder({ sizeWad: wad(0.000001), priceWad: wad(1.5), isBuy: true, initialMarginBps: 1000, feeBps: 5 });
    expect(est.notional).toBe(1n);
    expect(est.initialMargin).toBe(1n);
    expect(est.fee).toBe(1n);
    expect(est.priceLoss).toBe(0n);
    const loss = estimateOrder({
      sizeWad: wad(0.000001),
      priceWad: wad(1.5),
      indexPriceWad: wad(1),
      isBuy: true,
      initialMarginBps: 1000,
      feeBps: 0,
    });
    expect(loss.priceLoss).toBe(1n); // 0.5 unit rounds up
    expect(loss.fee).toBe(0n);
  });

  it("price band and limit classification", () => {
    const band = priceBand(wad(1_000), 500);
    expect(band).toEqual({ lower: wad(950), upper: wad(1_050) });
    expect(classifyLimitPrice(true, wad(1_000), band)).toBe("inside");
    expect(classifyLimitPrice(true, wad(1_050), band)).toBe("inside");
    expect(classifyLimitPrice(false, wad(950), band)).toBe("inside");
    // Passive side: just rests.
    expect(classifyLimitPrice(true, wad(949.99), band)).toBe("resting");
    expect(classifyLimitPrice(false, wad(1_050.01), band)).toBe("resting");
    // Aggressive side: remainder would be cancelled.
    expect(classifyLimitPrice(true, wad(1_050.01), band)).toBe("crossing");
    expect(classifyLimitPrice(false, wad(949.99), band)).toBe("crossing");
    // Bounds round inwards.
    expect(priceBand(3n, 500)).toEqual({ lower: 3n, upper: 3n });
    expect(priceBand(wad(1), 20_000).lower).toBe(0n);
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
