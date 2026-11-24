import { CANCEL_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, ORDER_TYPES, type Order } from "@shared";

export const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;
/** The contract rejects orders without an expiry or expiring more than 7 days ahead. */
export const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Some wallets (hardware, WalletConnect) return the recovery byte as 0/1.
 * The engine and the contract only accept 27/28, so map it; anything that is
 * not a 65-byte signature is returned untouched for the engine to reject.
 */
export function normalizeSignature(signature: `0x${string}`): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return signature;
  const v = signature.slice(-2).toLowerCase();
  if (v === "00") return `${signature.slice(0, -2)}1b` as `0x${string}`;
  if (v === "01") return `${signature.slice(0, -2)}1c` as `0x${string}`;
  return signature;
}

const UINT64_MASK = 0xffff_ffff_ffff_ffffn;

/**
 * Nonce unique per trader: millisecond timestamp in the high bits, 64 random
 * bits below. Roughly time-ordered, and collision-free across tabs/devices
 * for practical purposes.
 */
export function generateNonce(nowMs: number = Date.now(), random: bigint = randomUint64()): bigint {
  return (BigInt(Math.trunc(nowMs)) << 64n) | (random & UINT64_MASK);
}

/**
 * Nonce for a new order that the contract will accept: like generateNonce, but
 * never below `minValidNonce` (raised by `cancelAllOrders`; nonces below it are
 * dead). Matters right after a bulk cancel, or if this device's clock is behind.
 */
export function nextNonce(minValidNonce: bigint, nowMs: number = Date.now(), random: bigint = randomUint64()): bigint {
  const nonce = generateNonce(nowMs, random);
  if (nonce >= minValidNonce) return nonce;
  return (((minValidNonce >> 64n) + 1n) << 64n) | (random & UINT64_MASK);
}

/**
 * Value for `cancelAllOrders`: strictly above every nonce this app could have
 * produced up to `nowMs` (those are below (nowMs + 1) << 64) and strictly above
 * the current on-chain minimum, which the contract requires.
 */
export function bulkCancelNonce(currentMinValidNonce: bigint, nowMs: number = Date.now()): bigint {
  const aboveAllSigned = (BigInt(Math.trunc(nowMs)) + 1n) << 64n;
  return aboveAllSigned > currentMinValidNonce ? aboveAllSigned : currentMinValidNonce + 1n;
}

// Highest minimum this tab has set on-chain, per trader. Covers the moment
// between a confirmed bulk cancel and the next successful chain read.
const localNonceFloor = new Map<string, bigint>();

export function rememberNonceFloor(trader: string, minValidNonce: bigint): void {
  const key = trader.toLowerCase();
  if (minValidNonce > (localNonceFloor.get(key) ?? 0n)) localNonceFloor.set(key, minValidNonce);
}

export function knownNonceFloor(trader: string): bigint {
  return localNonceFloor.get(trader.toLowerCase()) ?? 0n;
}

function randomUint64(): bigint {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return (BigInt(words[0] ?? 0) << 32n) | BigInt(words[1] ?? 0);
}

export function defaultExpiry(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + DEFAULT_EXPIRY_SECONDS);
}

export function eip712Domain(chainId: number, exchange: `0x${string}`) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: exchange,
  } as const;
}

export function orderTypedData(chainId: number, exchange: `0x${string}`, order: Order) {
  return {
    domain: eip712Domain(chainId, exchange),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  } as const;
}

export function cancelTypedData(chainId: number, exchange: `0x${string}`, trader: `0x${string}`, nonce: bigint) {
  return {
    domain: eip712Domain(chainId, exchange),
    types: CANCEL_TYPES,
    primaryType: "Cancel",
    message: { trader, nonce },
  } as const;
}

/** JSON wire form of an order: bigints as decimal strings. */
export interface OrderJson {
  trader: `0x${string}`;
  marketId: number;
  isBuy: boolean;
  reduceOnly: boolean;
  size: string;
  limitPrice: string;
  nonce: string;
  expiry: string;
}

export function orderToJson(order: Order): OrderJson {
  return {
    trader: order.trader,
    marketId: order.marketId,
    isBuy: order.isBuy,
    reduceOnly: order.reduceOnly,
    size: order.size.toString(),
    limitPrice: order.limitPrice.toString(),
    nonce: order.nonce.toString(),
    expiry: order.expiry.toString(),
  };
}
