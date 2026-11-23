import { getAddress, isAddress } from "viem";
import type { Address, Hex, Order } from "../types.ts";

/** Malformed request; maps to HTTP 400. */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unsigned integer given as a decimal string (or a non-negative safe integer). */
export function parseUint(v: unknown, field: string, max: bigint): bigint {
  let n: bigint;
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)) n = BigInt(v);
  else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  else throw new ValidationError(`${field} must be an unsigned integer given as a decimal string`);
  if (n > max) throw new ValidationError(`${field} is out of range`);
  return n;
}

export function parseAddress(v: unknown, field: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new ValidationError(`${field} must be a 20-byte hex address`);
  return getAddress(v);
}

function parseBool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new ValidationError(`${field} must be a boolean`);
  return v;
}

function parseOptionalBool(v: unknown, field: string): boolean {
  return v === undefined ? false : parseBool(v, field);
}

export function parseSignature(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(v)) throw new ValidationError("signature must be a 65-byte hex string");
  return v as Hex;
}

export function parseOrderHash(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ValidationError("orderHash must be a 32-byte hex string");
  return v.toLowerCase() as Hex;
}

export function parseMarketId(v: unknown): number {
  return Number(parseUint(v, "marketId", UINT32_MAX));
}

const ORDER_FIELDS = ["trader", "marketId", "isBuy", "reduceOnly", "size", "limitPrice", "nonce", "expiry"];

export function parseOrder(v: unknown): Order {
  if (!isObject(v)) throw new ValidationError("order must be an object");
  for (const k of Object.keys(v)) if (!ORDER_FIELDS.includes(k)) throw new ValidationError(`order has an unknown field "${k}"`);
  return {
    trader: parseAddress(v.trader, "order.trader"),
    marketId: Number(parseUint(v.marketId, "order.marketId", UINT32_MAX)),
    isBuy: parseBool(v.isBuy, "order.isBuy"),
    reduceOnly: parseBool(v.reduceOnly, "order.reduceOnly"),
    size: parseUint(v.size, "order.size", UINT256_MAX),
    limitPrice: parseUint(v.limitPrice, "order.limitPrice", UINT256_MAX),
    nonce: parseUint(v.nonce, "order.nonce", UINT256_MAX),
    expiry: parseUint(v.expiry, "order.expiry", UINT64_MAX),
  };
}

export interface SubmitBody {
  order: Order;
  signature: Hex;
  postOnly: boolean;
  ioc: boolean;
}

export function parseSubmitBody(v: unknown): SubmitBody {
  if (!isObject(v)) throw new ValidationError("body must be a JSON object { order, signature }");
  return {
    order: parseOrder(v.order),
    signature: parseSignature(v.signature),
    postOnly: parseOptionalBool(v.postOnly, "postOnly"),
    ioc: parseOptionalBool(v.ioc, "ioc"),
  };
}

export function parseCancelBody(v: unknown): { signature: Hex } {
  if (!isObject(v)) throw new ValidationError("body must be a JSON object { signature }");
  return { signature: parseSignature(v.signature) };
}

/** Optional integer query parameter within [min, max]. */
export function parseIntParam(v: unknown, field: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  if (typeof v !== "string" || !/^[0-9]{1,9}$/.test(v)) throw new ValidationError(`${field} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}
