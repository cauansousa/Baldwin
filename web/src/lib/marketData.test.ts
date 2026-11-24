import { describe, expect, it } from "vitest";
import { mergeMarketFigures, missingReads, type EngineMarketStats } from "./marketData";

const full: EngineMarketStats = {
  indexPrice: 100n,
  lastPrice: 102n,
  markTwap: 101n,
  currentFundingRate: -5n,
  lastFundingTime: 1_800_000_000n,
  nextFundingTime: 1_800_003_600n,
  openInterestLong: 7n,
  openInterestShort: 8n,
};

describe("missingReads", () => {
  it("reads nothing from the chain when the engine supplies everything", () => {
    expect(missingReads(full)).toEqual([]);
  });
  it("reads everything when the engine supplies nothing", () => {
    const all = ["indexPrice", "markPrice", "markTwap", "currentFundingRate", "lastFundingTime", "openInterest"];
    expect(missingReads(undefined)).toEqual(all);
    expect(missingReads({})).toEqual(all);
  });
  it("reads only what is missing", () => {
    expect(missingReads({ ...full, indexPrice: undefined, openInterestShort: undefined })).toEqual(["indexPrice", "openInterest"]);
    // Either the next time or the last accrual is enough for the countdown.
    expect(missingReads({ ...full, lastFundingTime: undefined })).toEqual([]);
    expect(missingReads({ ...full, nextFundingTime: undefined })).toEqual([]);
    expect(missingReads({ ...full, nextFundingTime: undefined, lastFundingTime: undefined })).toEqual(["lastFundingTime"]);
    // A zero funding rate is a real value, not a missing one.
    expect(missingReads({ ...full, currentFundingRate: 0n })).toEqual([]);
  });
});

describe("mergeMarketFigures", () => {
  it("prefers the engine and falls back to the chain field by field", () => {
    expect(mergeMarketFigures(full, { indexPrice: 1n, markPrice: 2n, markTwap: 3n, fundingRate: 4n })).toEqual({
      indexPrice: 100n,
      markPrice: 102n,
      markTwap: 101n,
      fundingRate: -5n,
      nextFundingTime: 1_800_003_600n,
      openInterest: { longs: 7n, shorts: 8n },
    });
    expect(
      mergeMarketFigures(
        { indexPrice: 100n },
        { markPrice: 2n, markTwap: 3n, fundingRate: 4n, lastFundingTime: 1000n, openInterest: { longs: 5n, shorts: 6n } },
      ),
    ).toEqual({
      indexPrice: 100n,
      markPrice: 2n,
      markTwap: 3n,
      fundingRate: 4n,
      nextFundingTime: 4600n, // chain fallback: last accrual + the contract's 1 h interval
      openInterest: { longs: 5n, shorts: 6n },
    });
  });

  it("uses the engine's nextFundingTime rather than last + 1 h when it has one", () => {
    expect(mergeMarketFigures({ lastFundingTime: 1000n, nextFundingTime: 9999n }, undefined).nextFundingTime).toBe(9999n);
    expect(mergeMarketFigures({ lastFundingTime: 1000n }, undefined).nextFundingTime).toBe(4600n);
    expect(mergeMarketFigures({}, {}).nextFundingTime).toBeUndefined();
  });

  it("treats a zero TWAP as unavailable and hides the rate without an index price", () => {
    // Without an index the contract returns 0 for both; neither is a real figure.
    const noIndex = mergeMarketFigures({}, { indexPrice: 0n, markTwap: 0n, fundingRate: 0n, markPrice: 0n });
    expect(noIndex.indexPrice).toBeUndefined();
    expect(noIndex.markTwap).toBeUndefined();
    expect(noIndex.fundingRate).toBeUndefined();
    expect(noIndex.markPrice).toBeUndefined();
    // With an index, a zero rate is real (e.g. no fills in the current period).
    expect(mergeMarketFigures({ indexPrice: 100n, currentFundingRate: 0n, markTwap: 100n }, undefined).fundingRate).toBe(0n);
  });
});
