import { describe, expect, it } from "vitest";
import {
  bigintFromJson,
  formatBps,
  formatPrice,
  formatSize,
  formatUnits,
  formatUsdc,
  parseDecimal,
  parseUsdc,
  parseWad,
  roundToFraction,
  toInputString,
} from "./units";

const WAD = 10n ** 18n;
const value = (r: ReturnType<typeof parseDecimal>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
};

describe("parseDecimal", () => {
  it("parses integers and decimals exactly", () => {
    expect(value(parseDecimal("1", 18))).toBe(WAD);
    expect(value(parseDecimal("0.1", 18))).toBe(WAD / 10n);
    expect(value(parseDecimal("97432.5", 18))).toBe(974325n * 10n ** 17n);
    expect(value(parseDecimal("123.456789", 6))).toBe(123_456_789n);
    expect(value(parseDecimal("0", 6))).toBe(0n);
  });

  it("does not suffer from float rounding", () => {
    // 0.1 + 0.2 !== 0.3 in floats; fixed-point must be exact.
    expect(value(parseDecimal("0.1", 18)) + value(parseDecimal("0.2", 18))).toBe(value(parseDecimal("0.3", 18)));
    expect(value(parseDecimal("9007199254740993.000000000000000001", 18))).toBe(9007199254740993000000000000000001n);
  });

  it("accepts a comma as the decimal separator", () => {
    expect(value(parseDecimal("1,5", 6))).toBe(1_500_000n);
    expect(value(parseDecimal(" 2,25 ", 18))).toBe(225n * 10n ** 16n);
  });

  it("accepts leading/trailing separator forms", () => {
    expect(value(parseDecimal(".5", 6))).toBe(500_000n);
    expect(value(parseDecimal("5.", 6))).toBe(5_000_000n);
    expect(value(parseDecimal("007", 6))).toBe(7_000_000n);
  });

  it("accepts exactly `decimals` fractional digits and rejects more", () => {
    expect(value(parseDecimal("0.000001", 6))).toBe(1n);
    expect(parseDecimal("0.0000001", 6).ok).toBe(false);
    expect(parseDecimal("1.0000000000000000001", 18).ok).toBe(false);
  });

  it.each(["", "   ", ".", ",", "abc", "1e5", "-1", "+1", "1.2.3", "1.234,56", "1 000", "0x10", "1_000", "NaN", "Infinity", "١٢"])(
    "rejects %j",
    (input) => {
      expect(parseDecimal(input, 18).ok).toBe(false);
    },
  );

  it("rejects absurdly large input", () => {
    expect(parseDecimal("9".repeat(31), 18).ok).toBe(false);
    expect(parseDecimal("9".repeat(30), 18).ok).toBe(true);
  });

  it("parseWad / parseUsdc reject zero", () => {
    expect(parseWad("0").ok).toBe(false);
    expect(parseUsdc("0,00").ok).toBe(false);
    expect(value(parseUsdc("10.5"))).toBe(10_500_000n);
    expect(value(parseWad("0.001"))).toBe(10n ** 15n);
  });
});

describe("formatUnits", () => {
  it("formats with pt-BR separators", () => {
    expect(formatUsdc(1_234_567_890_000n)).toBe("1.234.567,89");
    expect(formatUsdc(0n)).toBe("0,00");
    expect(formatUsdc(999_999n)).toBe("1,00");
    expect(formatUsdc(1_000n)).toBe("0,00");
  });

  it("rounds half away from zero", () => {
    expect(formatUsdc(1_005_000n)).toBe("1,01");
    expect(formatUsdc(1_004_999n)).toBe("1,00");
    expect(formatUsdc(-1_005_000n)).toBe("-1,01");
  });

  it("handles negatives and the plus sign", () => {
    expect(formatUsdc(-431_375_000n)).toBe("-431,38");
    expect(formatUsdc(431_375_000n, { showPlus: true })).toBe("+431,38");
    expect(formatUsdc(-1n)).toBe("0,00"); // no "-0,00"
    expect(formatUsdc(0n, { showPlus: true })).toBe("0,00");
  });

  it("trims trailing zeros down to minFraction", () => {
    expect(formatUnits(1_500_000n, 6, { maxFraction: 6, minFraction: 0 })).toBe("1,5");
    expect(formatUnits(2_000_000n, 6, { maxFraction: 6, minFraction: 0 })).toBe("2");
    expect(formatUnits(2_000_000n, 6, { maxFraction: 6, minFraction: 2 })).toBe("2,00");
  });

  it("can disable grouping", () => {
    expect(formatUnits(1_234_567_000_000n, 6, { grouping: false })).toBe("1234567,00");
  });

  it("formats prices by magnitude and sizes with 4 decimals", () => {
    expect(formatPrice(974325n * 10n ** 17n)).toBe("97.432,50");
    expect(formatPrice(34152n * 10n ** 14n)).toBe("3,4152");
    expect(formatPrice(123456n * 10n ** 9n)).toBe("0,000123");
    expect(formatSize(35n * 10n ** 16n)).toBe("0,3500");
  });

  it("formats bps as a percentage", () => {
    expect(formatBps(3669n)).toBe("36,69%");
    expect(formatBps(10_000n)).toBe("100,00%");
  });
});

describe("toInputString", () => {
  it("round-trips through parseDecimal without loss", () => {
    for (const v of [1n, 10n ** 18n, 350_000_000_000_000_001n, 123_456_789_012_345_678_901_234n]) {
      expect(value(parseDecimal(toInputString(v, 18), 18))).toBe(v);
    }
    expect(toInputString(8_359_120_000n, 6)).toBe("8359,12");
    expect(toInputString(35n * 10n ** 16n, 18)).toBe("0,35");
  });
});

describe("roundToFraction", () => {
  it("rounds to the given number of fractional digits", () => {
    expect(roundToFraction(1_234_567n, 6, 2)).toBe(1_230_000n);
    expect(roundToFraction(1_235_000n, 6, 2)).toBe(1_240_000n);
    expect(roundToFraction(1_234_567n, 6, 6)).toBe(1_234_567n);
  });
});

describe("bigintFromJson", () => {
  it("accepts decimal strings and safe integers", () => {
    expect(bigintFromJson("123456789012345678901234567890", "x")).toBe(123456789012345678901234567890n);
    expect(bigintFromJson("-5", "x")).toBe(-5n);
    expect(bigintFromJson(42, "x")).toBe(42n);
  });
  it.each([["1.5"], ["0x10"], [""], [1.5], [null], [undefined], [{}], [2 ** 60]])("rejects %j", (bad) => {
    expect(() => bigintFromJson(bad, "x")).toThrow();
  });
});
