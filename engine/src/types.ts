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

export const consoleLogger: Logger = {
  info: (msg, ctx) => console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg, ...ctx }, jsonReplacer)),
  warn: (msg, ctx) => console.warn(JSON.stringify({ level: "warn", time: new Date().toISOString(), msg, ...ctx }, jsonReplacer)),
  error: (msg, ctx) => console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), msg, ...ctx }, jsonReplacer)),
};

export function errMessage(e: unknown): string {
  if (e instanceof Error) return (e as { shortMessage?: string }).shortMessage ?? e.message;
  return String(e);
}
