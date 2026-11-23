// Fixed-point helpers. Every amount in the app is a bigint:
//  - USDC amounts and account values: 6 decimals
//  - base sizes and prices: 18 decimals (WAD)
// Nothing here goes through JS floating point.

import { USDC_DECIMALS } from "@shared";

export const WAD_DECIMALS = 18;
/** Scale factor between USDC units (6 dec) and WAD-denominated USD (18 dec). */
export const USDC_TO_WAD = 10n ** BigInt(WAD_DECIMALS - USDC_DECIMALS);

export type ParseResult = { ok: true; value: bigint } | { ok: false; error: string };

const MAX_INTEGER_DIGITS = 30;

/**
 * Parses a non-negative user-typed decimal into a fixed-point bigint.
 * Accepts "." or "," as the decimal separator (pt-BR keyboards) and nothing
 * else: no signs, exponents, thousands separators or whitespace inside.
 * Input with more fractional digits than `decimals` is rejected, not rounded.
 * Error messages are user-facing (Portuguese).
 */
export function parseDecimal(input: string, decimals: number): ParseResult {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Informe um valor." };
  const match = /^(\d*)(?:[.,](\d*))?$/.exec(text);
  if (!match) return { ok: false, error: "Número inválido. Use só dígitos e um separador decimal." };
  const intPart = match[1] ?? "";
  const fracPart = match[2] ?? "";
  if (intPart === "" && fracPart === "") return { ok: false, error: "Número inválido." };
  if (intPart.length > MAX_INTEGER_DIGITS) return { ok: false, error: "Valor grande demais." };
  if (fracPart.length > decimals) {
    return { ok: false, error: `Use no máximo ${decimals} casas decimais.` };
  }
  const value = BigInt((intPart || "0") + fracPart.padEnd(decimals, "0"));
  return { ok: true, value };
}

/** Like parseDecimal but additionally rejects zero. */
export function parsePositiveDecimal(input: string, decimals: number): ParseResult {
  const res = parseDecimal(input, decimals);
  if (res.ok && res.value === 0n) return { ok: false, error: "O valor deve ser maior que zero." };
  return res;
}

export const parseWad = (input: string) => parsePositiveDecimal(input, WAD_DECIMALS);
export const parseUsdc = (input: string) => parsePositiveDecimal(input, USDC_DECIMALS);

export interface FormatOptions {
  /** Fractional digits to keep (rounded half away from zero). Default 2. */
  maxFraction?: number;
  /** Minimum fractional digits; trailing zeros beyond it are trimmed. Default = maxFraction. */
  minFraction?: number;
  /** Thousands grouping. Default true. */
  grouping?: boolean;
  /** Prefix positive values with "+". Default false. */
  showPlus?: boolean;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/** Formats a fixed-point bigint using pt-BR conventions: "1.234,56". */
export function formatUnits(value: bigint, decimals: number, opts: FormatOptions = {}): string {
  const maxFraction = Math.min(opts.maxFraction ?? 2, decimals);
  const minFraction = Math.min(opts.minFraction ?? maxFraction, maxFraction);
  const grouping = opts.grouping ?? true;

  const negative = value < 0n;
  const drop = 10n ** BigInt(decimals - maxFraction);
  // Round half away from zero at `maxFraction` digits.
  const rounded = (abs(value) + drop / 2n) / drop;
  const unit = 10n ** BigInt(maxFraction);
  let intText = (rounded / unit).toString();
  let fracText = maxFraction > 0 ? (rounded % unit).toString().padStart(maxFraction, "0") : "";
  while (fracText.length > minFraction && fracText.endsWith("0")) fracText = fracText.slice(0, -1);
  if (grouping) intText = intText.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  const isZero = rounded === 0n;
  const sign = negative && !isZero ? "-" : opts.showPlus && !isZero ? "+" : "";
  return sign + intText + (fracText ? "," + fracText : "");
}

export const formatUsdc = (value: bigint, opts: FormatOptions = {}) =>
  formatUnits(value, USDC_DECIMALS, { maxFraction: 2, ...opts });

/** Fraction digits used to display a price of this magnitude. */
export function priceFractionDigits(priceWad: bigint): number {
  const p = abs(priceWad);
  if (p >= 100n * 10n ** 18n) return 2;
  if (p >= 10n ** 18n) return 4;
  return 6;
}

export const formatPrice = (priceWad: bigint, fraction = priceFractionDigits(priceWad)) =>
  formatUnits(priceWad, WAD_DECIMALS, { maxFraction: fraction });

export const formatSize = (sizeWad: bigint, opts: FormatOptions = {}) =>
  formatUnits(sizeWad, WAD_DECIMALS, { maxFraction: 4, ...opts });

/** Rounds a fixed-point value (half up) to `fraction` fractional digits, keeping its scale. */
export function roundToFraction(value: bigint, decimals: number, fraction: number): bigint {
  if (fraction >= decimals) return value;
  const unit = 10n ** BigInt(decimals - fraction);
  return ((value + unit / 2n) / unit) * unit;
}

/** Basis points as a percentage: 1234 -> "12,34%". */
export const formatBps = (bps: bigint) => formatUnits(bps, 2, { maxFraction: 2 }) + "%";

/**
 * Exact, ungrouped decimal string suitable for pre-filling an input that is
 * later read back with parseDecimal (round-trips losslessly).
 */
export function toInputString(value: bigint, decimals: number): string {
  return formatUnits(value, decimals, { maxFraction: decimals, minFraction: 0, grouping: false });
}

/** Parses a decimal-string bigint from JSON; throws on anything else. */
export function bigintFromJson(value: unknown, field: string): bigint {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "bigint") return value;
  throw new Error(`Campo "${field}" inválido na resposta do servidor.`);
}
