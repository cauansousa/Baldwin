import { CANCEL_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, ORDER_TYPES, type Order } from "@shared";

export const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;

/**
 * Nonce unique per trader: millisecond timestamp in the high bits, 64 random
 * bits below. Roughly time-ordered, and collision-free across tabs/devices
 * for practical purposes.
 */
export function generateNonce(
  nowMs: number = Date.now(),
  random: bigint = randomUint64(),
): bigint {
  return (BigInt(Math.trunc(nowMs)) << 64n) | (random & 0xffff_ffff_ffff_ffffn);
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
