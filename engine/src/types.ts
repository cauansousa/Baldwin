import type { Order } from "../../shared/src/index.ts";

export type { Order };
export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** Static market parameters the engine needs (read from the contract at startup). */
export interface MarketConfig {
  marketId: number;
  symbol: string;
  active: boolean;
  minOrderSize: bigint;
  /** Base WAD, per side. */
  maxOpenInterest: bigint;
  initialMarginBps: bigint;
  maintenanceMarginBps: bigint;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
}

/** One fill to be settled on-chain; mirrors IExchange.Match. */
export interface Match {
  /** Engine-local unique id. */
  id: string;
  marketId: number;
  maker: Order;
  makerSig: Hex;
  makerHash: Hex;
  taker: Order;
  takerSig: Hex;
  takerHash: Hex;
  fillSize: bigint;
  /** Maker's limit price. */
  price: bigint;
}

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** JSON.stringify replacer: bigints as decimal strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export type LogLevel = "info" | "warn" | "error" | "silent";
const LEVELS: Record<LogLevel, number> = { info: 0, warn: 1, error: 2, silent: 3 };

/**
 * Structured logs: one JSON object per line with `level`, `time`, `msg`, an optional
 * `component`, and the context fields. info goes to stdout, warn and error to stderr.
 */
export function createLogger(minLevel: LogLevel = "info", component?: string): Logger {
  const write = (level: "info" | "warn" | "error") => (msg: string, ctx?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), ...(component ? { component } : {}), msg, ...ctx }, jsonReplacer);
    (level === "info" ? process.stdout : process.stderr).write(line + "\n");
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

export const consoleLogger: Logger = createLogger("info");

export function errMessage(e: unknown): string {
  if (e instanceof Error) return (e as { shortMessage?: string }).shortMessage ?? e.message;
  return String(e);
}
