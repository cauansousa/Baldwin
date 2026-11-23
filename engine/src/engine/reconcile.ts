import { decodeErrorResult, isAddressEqual, parseAbi } from "viem";
import { BPS, WAD } from "../../../shared/src/index.ts";
import type { ChainReader } from "../chain/types.ts";
import type { MarketConfig, Match, Order, Hex } from "../types.ts";

/** WAD base size x WAD price -> USDC units (6 decimals), rounded down. */
export function notionalUsdc(size: bigint, price: bigint): bigint {
  return (size * price) / WAD / 10n ** 12n;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/** True if trading `size` in the order's direction strictly reduces `position` without flipping it. */
export function isReducing(position: bigint, isBuy: boolean, size: bigint): boolean {
  if (position === 0n || size === 0n) return false;
  const opposite = isBuy ? position < 0n : position > 0n;
  return opposite && size <= abs(position);
}

export interface SideVerdict {
  atFault: boolean;
  reason?: string;
}

export interface Verdict {
  maker: SideVerdict;
  taker: SideVerdict;
}

export const UNATTRIBUTED: Verdict = { maker: { atFault: false }, taker: { atFault: false } };

/**
 * Custom errors of the current Exchange implementation that name the trader at fault.
 * They are not part of IExchange, so this is strictly opportunistic: revert data that
 * does not decode to one of these falls through to the view-based diagnosis.
 */
const TRADER_ERRORS = parseAbi([
  "error InsufficientMargin(address trader)",
  "error NegativeAccountValue(address trader)",
  "error ReduceOnlyViolated(address trader)",
]);

const TRADER_ERROR_TEXT: Record<(typeof TRADER_ERRORS)[number]["name"], string> = {
  InsufficientMargin: "insufficient margin",
  NegativeAccountValue: "fill would leave the account with negative value",
  ReduceOnlyViolated: "reduce-only order would not reduce the position",
};

/** Exact attribution from the revert data, when it names one of the two traders. */
export function attributeFromRevert(match: Match, reason: Hex): Verdict | null {
  let err;
  try {
    err = decodeErrorResult({ abi: TRADER_ERRORS, data: reason });
  } catch {
    return null;
  }
  const trader = err.args[0];
  const text = TRADER_ERROR_TEXT[err.errorName];
  // The contract stops at the first failing check, so the other side is not implicated.
  if (isAddressEqual(trader, match.maker.trader)) return { maker: { atFault: true, reason: text }, taker: { atFault: false } };
  if (isAddressEqual(trader, match.taker.trader)) return { maker: { atFault: false }, taker: { atFault: true, reason: text } };
  return null;
}

/**
 * Work out which side(s) made a match fail on-chain, from contract views. Used when
 * the revert data does not name a trader; these checks hold for any IExchange.
 *
 * Definitive: nonce cancelled on-chain, order has less unfilled size on-chain than
 * the fill, order expired by block time.
 * Heuristic: reduce-only fill that would not reduce; fill that increases exposure
 * while free collateral is below the estimated initial margin for it. The margin
 * estimate is evaluated on post-batch state and can be wrong in either direction;
 * being wrong only costs an order its place in the book, never a wrong settlement.
 *
 * Neither side at fault => unattributed (paused exchange, stale oracle, open-interest
 * cap, ...); the engine applies its unattributed-failure policy.
 */
export async function classifyFailure(match: Match, market: MarketConfig, chain: ChainReader): Promise<Verdict> {
  const blockTime = await chain.blockTimestamp();
  const indexPrice = await chain.indexPrice(match.marketId).catch(() => match.price);
  const side = (order: Order, hash: Hex, feeBps: bigint) =>
    diagnoseSide(order, hash, match.fillSize, match.price, feeBps, market, indexPrice, blockTime, chain);
  const [maker, taker] = await Promise.all([
    side(match.maker, match.makerHash, market.makerFeeBps),
    side(match.taker, match.takerHash, market.takerFeeBps),
  ]);
  return { maker, taker };
}

async function diagnoseSide(
  order: Order,
  hash: Hex,
  fillSize: bigint,
  fillPrice: bigint,
  feeBps: bigint,
  market: MarketConfig,
  indexPrice: bigint,
  blockTime: bigint,
  chain: ChainReader,
): Promise<SideVerdict> {
  if (await chain.isCancelled(order.trader, order.nonce)) return { atFault: true, reason: "order cancelled on-chain" };
  const filled = await chain.filledSize(hash);
  if (filled + fillSize > order.size) return { atFault: true, reason: "order already filled on-chain" };
  if (order.expiry !== 0n && order.expiry <= blockTime) return { atFault: true, reason: "order expired on-chain" };

  const position = await chain.positionSize(order.trader, order.marketId);
  if (isReducing(position, order.isBuy, fillSize)) return { atFault: false };
  if (order.reduceOnly) return { atFault: true, reason: "reduce-only order would not reduce the position" };

  const newPosition = position + (order.isBuy ? fillSize : -fillSize);
  const addedExposure = abs(newPosition) > abs(position) ? abs(newPosition) - abs(position) : 0n;
  const adversePrice = order.isBuy
    ? fillPrice > indexPrice ? fillPrice - indexPrice : 0n
    : indexPrice > fillPrice ? indexPrice - fillPrice : 0n;
  const required =
    (notionalUsdc(addedExposure, indexPrice) * market.initialMarginBps) / BPS +
    (notionalUsdc(fillSize, fillPrice) * feeBps) / BPS +
    notionalUsdc(fillSize, adversePrice);
  const free = await chain.freeCollateral(order.trader);
  if (free < required) return { atFault: true, reason: "insufficient margin" };
  return { atFault: false };
}
