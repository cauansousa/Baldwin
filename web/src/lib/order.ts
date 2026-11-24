import { CANCEL_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, ORDER_TYPES, type Order } from "@shared";

export const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;
/**
 * Longest expiry the engine accepts at intake (7 days). The contract itself
 * allows up to maxOrderLifetime() = 30 days; both reject an expiry of 0.
 */
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

const DAY_MS = 86_400_000n;

/**
 * Highest value the contract accepts in `cancelAllOrders` (it reverts with
 * NonceTooHigh above it): ((chain time + 1 day) in ms) << 64. Order nonces are
 * kept within the same range so a later bulk cancel can always cover them.
 */
export function nonceUpperBound(chainTimeSec: bigint): bigint {
  return (chainTimeSec * 1000n + DAY_MS) << 64n;
}

/** A usable nonce cannot be produced or cancelled within the contract's bounds; message is user-facing. */
export class NonceRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonceRangeError";
  }
}

/**
 * Nonce for a new order: time-based like generateNonce, but never below
 * `minValidNonce` (raised by `cancelAllOrders`; nonces below it are dead) and
 * never beyond `upperBound`'s millisecond. Throws NonceRangeError instead of
 * returning a nonce that would be refused.
 */
export function nextNonce(
  minValidNonce: bigint,
  upperBound: bigint,
  nowMs: number = Date.now(),
  random: bigint = randomUint64(),
): bigint {
  const low = random & UINT64_MASK;
  let nonce = generateNonce(nowMs, low);
  if (nonce < minValidNonce) {
    // Clock behind the on-chain minimum (or right after a bulk cancel): move up to it.
    nonce = ((minValidNonce >> 64n) << 64n) | low;
    if (nonce < minValidNonce) nonce = (((minValidNonce >> 64n) + 1n) << 64n) | low;
  }
  if (nonce >> 64n > upperBound >> 64n) {
    throw new NonceRangeError(
      BigInt(Math.trunc(nowMs)) > upperBound >> 64n
        ? "O relógio deste dispositivo está mais de um dia adiantado em relação à rede. Acerte a data e a hora para enviar ordens."
        : "O mínimo de nonce desta conta já está no limite aceito pelo contrato. Novas ordens só serão possíveis mais tarde.",
    );
  }
  return nonce;
}

export interface BulkCancelPlan {
  /** Argument for `cancelAllOrders`. */
  value: bigint;
  /**
   * False when the contract's bound forced a value that does not exceed every
   * nonce this client may have signed (device clock far ahead of the chain).
   */
  coversAllSigned: boolean;
}

/**
 * Value for `cancelAllOrders`. Every nonce below it dies, so it must be
 * strictly above (a) the current on-chain minimum, which the contract
 * requires, (b) the highest nonce this client is known to have signed, and
 * (c) anything it could have signed up to `nowMs`. It is capped at
 * `upperBound`; if even `currentMin + 1` exceeds the cap nothing can be done
 * and NonceRangeError is thrown.
 */
export function planBulkCancel(p: {
  currentMinValidNonce: bigint;
  highestSignedNonce: bigint;
  upperBound: bigint;
  nowMs?: number;
}): BulkCancelPlan {
  const nowMs = p.nowMs ?? Date.now();
  let wanted = (BigInt(Math.trunc(nowMs)) + 1n) << 64n;
  if (p.highestSignedNonce + 1n > wanted) wanted = p.highestSignedNonce + 1n;
  if (p.currentMinValidNonce + 1n > wanted) wanted = p.currentMinValidNonce + 1n;
  if (wanted <= p.upperBound) return { value: wanted, coversAllSigned: true };
  if (p.upperBound <= p.currentMinValidNonce) {
    throw new NonceRangeError(
      "O mínimo de nonce desta conta já está no limite aceito pelo contrato; não é possível subi-lo agora. Cancele as ordens uma a uma on-chain.",
    );
  }
  return { value: p.upperBound, coversAllSigned: false };
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
