import { describe, expect, it } from "vitest";
import {
  estimateNextFundingUsdc,
  formatCountdown,
  formatFundingRate,
  fundingDirection,
  nextFundingTime,
  pendingFundingUsdc,
} from "./funding";

const WAD = 10n ** 18n;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const wad = (n: number) => (BigInt(Math.round(n * 1e6)) * WAD) / 1_000_000n;

describe("pending funding", () => {
  it("a long owes when the cumulative index rose since its snapshot, a short is owed", () => {
    // Index moved by $12.50 per unit of base.
    expect(pendingFundingUsdc(wad(2), wad(100), wad(112.5))).toBe(usdc(25));
    expect(pendingFundingUsdc(-wad(2), wad(100), wad(112.5))).toBe(-usdc(25));
  });
  it("reverses when the index fell, and is zero when flat or unchanged", () => {
    expect(pendingFundingUsdc(wad(0.35), wad(10), -wad(10))).toBe(-usdc(7));
    expect(pendingFundingUsdc(0n, 0n, wad(50))).toBe(0n);
    expect(pendingFundingUsdc(wad(3), wad(7), wad(7))).toBe(0n);
  });
  it("works with negative snapshots", () => {
    expect(pendingFundingUsdc(wad(1), -wad(5), -wad(2))).toBe(usdc(3));
  });
});

describe("next funding estimate", () => {
  const rate = WAD / 10_000n; // 0.01% per hour
  it("is notional * rate: longs pay when the rate is positive", () => {
    // 0.5 BTC at 100,000 = 50,000 notional; 0.01% = 5 USDC.
    expect(estimateNextFundingUsdc(wad(0.5), wad(100_000), rate)).toBe(usdc(5));
    expect(estimateNextFundingUsdc(-wad(0.5), wad(100_000), rate)).toBe(-usdc(5));
    expect(estimateNextFundingUsdc(wad(0.5), wad(100_000), -rate)).toBe(-usdc(5));
    expect(estimateNextFundingUsdc(-wad(0.5), wad(100_000), -rate)).toBe(usdc(5));
  });
  it("is zero for a zero rate or a flat position", () => {
    expect(estimateNextFundingUsdc(wad(1), wad(100), 0n)).toBe(0n);
    expect(estimateNextFundingUsdc(0n, wad(100), rate)).toBe(0n);
  });
});

describe("rate display", () => {
  it("formats the hourly rate as a signed percentage", () => {
    expect(formatFundingRate(WAD / 10_000n)).toBe("+0,0100%");
    expect(formatFundingRate(-(WAD / 8_000n))).toBe("-0,0125%");
    expect(formatFundingRate(0n)).toBe("0,0000%");
    expect(formatFundingRate(WAD / 100n)).toBe("+1,0000%");
  });
  it("says who pays", () => {
    expect(fundingDirection(1n)).toBe("longs_pay");
    expect(fundingDirection(-1n)).toBe("shorts_pay");
    expect(fundingDirection(0n)).toBe("none");
  });
});

describe("countdown", () => {
  it("counts down to one interval after the last accrual", () => {
    const last = 1_800_000_000n;
    expect(nextFundingTime(last)).toBe(last + 3600n);
    expect(formatCountdown(nextFundingTime(last), last)).toBe("1:00:00");
    expect(formatCountdown(nextFundingTime(last), last + 1n)).toBe("59:59");
    expect(formatCountdown(nextFundingTime(last), last + 3535n)).toBe("01:05");
  });
  it("is null once funding is due", () => {
    expect(formatCountdown(100n, 100n)).toBeNull();
    expect(formatCountdown(100n, 5000n)).toBeNull();
  });
});
