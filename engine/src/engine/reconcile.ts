import { decodeErrorResult, isAddressEqual } from "viem";
import { BPS, WAD } from "../../../shared/src/index.ts";
import { exchangeAbi } from "../abi.ts";
import type { Band } from "../book/orderbook.ts";
import type { ChainReader } from "../chain/types.ts";
import type { Hex, MarketConfig, Match, Order } from "../types.ts";

/** WAD base size x WAD price -> USDC units (6 decimals), rounded down. */
export function notionalUsdc(size: bigint, price: bigint): bigint {
  return (size * price) / WAD / 10n ** 12n;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/** Inclusive fill-price band: |price - index| * BPS <= index * deviationBps. */
export function priceBand(index: bigint, deviationBps: bigint): Band {
  const d = (index * deviationBps) / BPS;
  return { lo: index - d, hi: index + d };
}

/** True if trading `size` in the order's direction strictly reduces `position` without flipping it. */
export function isReducing(position: bigint, isBuy: boolean, size: bigint): boolean {
  if (position === 0n || size === 0n) return false;
  const opposite = isBuy ? position < 0n : position > 0n;
  return opposite && size <= abs(position);
}

export interface SideVerdict {
  atFault: boolean;
  reason?: string;
  /**
   * Set when the failure is the trader's own doing and says something about their
   * other orders: "margin" (cannot fund position-increasing fills) or "reduce_only"
   * (nothing left to reduce on that side). Unset for orders that were merely
   * cancelled, filled or expired on-chain: those are removed without blame.
   */
  kind?: "margin" | "reduce_only";
}

export interface Verdict {
  maker: SideVerdict;
  taker: SideVerdict;
  /**
   * Set when the match failed because of a condition that is nobody's fault (paused
   * exchange, stale oracle, price band, open-interest cap, ...). Then neither side is
   * at fault and makers get no strike.
   */
  global?: string;
  /** With `global`: restore both sides and let them match again (FillTooSmall). */
  rematch?: boolean;
}

export const UNATTRIBUTED: Verdict = { maker: { atFault: false }, taker: { atFault: false } };

type ErrorName = Extract<(typeof exchangeAbi)[number], { type: "error" }>["name"];

const TRADER_ERROR_TEXT: Partial<Record<ErrorName, [string, "margin" | "reduce_only"]>> = {
  InsufficientMargin: ["insufficient margin", "margin"],
  NegativeAccountValue: ["fill would leave the account with negative value", "margin"],
  ReduceOnlyViolated: ["reduce-only order would not reduce the position", "reduce_only"],
};

const GLOBAL_ERROR_TEXT: Partial<Record<ErrorName, string>> = {
  PriceOutOfBand: "fill price outside the oracle price band",
  StalePrice: "oracle price is stale",
  OnlyReducingAllowed: "exchange paused or market inactive",
  OpenInterestCapExceeded: "open-interest cap reached",
  SequencerDown: "L2 sequencer is down",
  SequencerGracePeriodNotOver: "L2 sequencer just came back (grace period)",
  FeedStale: "oracle feed is stale",
  InvalidAnswer: "oracle feed returned an invalid answer",
  FeedNotSet: "oracle feed is not configured",
};

/**
 * Attribution from the revert data alone (errors as declared in the shared ABI): a
 * named trader, or a recognised global condition. Anything else (OrderIsCancelled,
 * OrderExpired, unknown data, ...) returns null and is diagnosed from contract views.
 */
export function attributeFromRevert(match: Match, reason: Hex): Verdict | null {
  let err;
  try {
    err = decodeErrorResult({ abi: exchangeAbi, data: reason });
  } catch {
    return null;
  }
  // A sub-minimum fill only fails when an earlier fill of the order it was meant to
  // complete has failed. Nobody's fault; matching the pair again uses the right size.
  if (err.errorName === "FillTooSmall") return { ...UNATTRIBUTED, global: "fill below the minimum size", rematch: true };
  const global = GLOBAL_ERROR_TEXT[err.errorName];
  if (global) return { ...UNATTRIBUTED, global };
  const named = TRADER_ERROR_TEXT[err.errorName];
  const trader = err.args?.[0];
  if (!named || typeof trader !== "string") return null;
  const at: SideVerdict = { atFault: true, reason: named[0], kind: named[1] };
  // The contract stops at the first failing check, so the other side is not implicated.
  if (isAddressEqual(trader as Hex, match.maker.trader)) return { maker: at, taker: { atFault: false } };
  if (isAddressEqual(trader as Hex, match.taker.trader)) return { maker: { atFault: false }, taker: at };
  return null;
}

/**
 * Work out why a match failed on-chain from contract views, for revert data that
 * names nobody. In this order:
 *
 *  1. Definitive per-order causes: nonce cancelled on-chain, less unfilled size
 *     on-chain than the fill, expired by block time. If either side has one, exactly
 *     those sides are at fault and the other side is innocent - no guessing.
 *  2. Global conditions: exchange paused, index price unreadable (stale or broken
 *     oracle), fill price outside the band, open-interest cap. Nobody is at fault.
 *  3. Heuristic, only when 1 and 2 found nothing: a reduce-only fill that would not
 *     reduce; a fill that increases exposure while free collateral is below the
 *     estimated initial margin for it. Evaluated on post-batch state, so it can be
 *     wrong; being wrong only costs an order its place in the book.
 *
 * Nothing found => unattributed.
 */
export async function classifyFailure(match: Match, market: MarketConfig, chain: ChainReader): Promise<Verdict> {
  const blockTime = await chain.blockTimestamp();
  const [makerDef, takerDef] = await Promise.all([
    definitiveCause(match.maker, match.makerHash, match.fillSize, blockTime, chain),
    definitiveCause(match.taker, match.takerHash, match.fillSize, blockTime, chain),
  ]);
  if (makerDef || takerDef) {
    return {
      maker: makerDef ? { atFault: true, reason: makerDef } : { atFault: false },
      taker: takerDef ? { atFault: true, reason: takerDef } : { atFault: false },
    };
  }

  if (await chain.paused()) return { ...UNATTRIBUTED, global: "exchange paused" };
  let indexPrice: bigint;
  try {
    indexPrice = await chain.indexPrice(match.marketId);
  } catch {
    return { ...UNATTRIBUTED, global: "index price unavailable" };
  }
  const band = priceBand(indexPrice, await chain.maxPriceDeviationBps());
  if (match.price < band.lo || match.price > band.hi) return { ...UNATTRIBUTED, global: "fill price outside the oracle price band" };
  const oi = await chain.openInterest(match.marketId);
  if (oi.longs + match.fillSize > market.maxOpenInterest) return { ...UNATTRIBUTED, global: "open-interest cap reached" };

  try {
    const [maker, taker] = await Promise.all([
      marginHeuristic(match.maker, match.fillSize, match.price, market.makerFeeBps, market, indexPrice, chain),
      marginHeuristic(match.taker, match.fillSize, match.price, market.takerFeeBps, market, indexPrice, chain),
    ]);
    return { maker, taker };
  } catch {
    // Account views revert when the oracle fails for any market the account is in
    // (stale feed, sequencer down). The fill needed those prices too: a global condition.
    return { ...UNATTRIBUTED, global: "account views unavailable (oracle)" };
  }
}

async function definitiveCause(order: Order, hash: Hex, fillSize: bigint, blockTime: bigint, chain: ChainReader): Promise<string | null> {
  if (await chain.isCancelled(order.trader, order.nonce)) return "order cancelled on-chain";
  if ((await chain.filledSize(hash)) + fillSize > order.size) return "order already filled on-chain";
  if (order.expiry !== 0n && order.expiry <= blockTime) return "order expired on-chain";
  return null;
}

async function marginHeuristic(
  order: Order,
  fillSize: bigint,
  fillPrice: bigint,
  feeBps: bigint,
  market: MarketConfig,
  indexPrice: bigint,
  chain: ChainReader,
): Promise<SideVerdict> {
  const position = await chain.positionSize(order.trader, order.marketId);
  if (isReducing(position, order.isBuy, fillSize)) return { atFault: false };
  if (order.reduceOnly) return { atFault: true, reason: "reduce-only order would not reduce the position", kind: "reduce_only" };

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
  if (free < required) return { atFault: true, reason: "insufficient margin", kind: "margin" };
  return { atFault: false };
}

/** An order (or the open part of one) as seen by the aggregate pre-trade margin check. */
export interface OpenExposure {
  marketId: number;
  isBuy: boolean;
  /** Quantity that can still reach the chain: resting + matched-but-unsettled. */
  size: bigint;
  limitPrice: bigint;
}

export interface MarginMarket {
  index: bigint;
  band: Band | undefined;
  position: bigint;
  initialMarginBps: bigint;
  takerFeeBps: bigint;
}

/**
 * Conservative collateral (USDC units) a trader needs for all of `orders` together,
 * to be compared with on-chain free collateral. Per market:
 *   - worst-case exposure if all buys or all sells fill: max(|P + buys|, |P - sells|);
 *     initial margin is charged on the increase over |P|, at the index price;
 *   - if exposure can increase, also taker fees on every order at its worst fill
 *     price and the immediate loss of filling there instead of at the index
 *     (worst fill price = limit clamped into the band).
 * A market whose orders can only reduce the position needs nothing.
 */
export function requiredCollateral(orders: OpenExposure[], markets: Map<number, MarginMarket>): bigint {
  let total = 0n;
  for (const [marketId, m] of markets) {
    const mine = orders.filter((o) => o.marketId === marketId);
    let buys = 0n;
    let sells = 0n;
    for (const o of mine) {
      if (o.isBuy) buys += o.size;
      else sells += o.size;
    }
    const worst = abs(m.position + buys) > abs(m.position - sells) ? abs(m.position + buys) : abs(m.position - sells);
    const added = worst - abs(m.position);
    if (added <= 0n) continue;
    total += (notionalUsdc(added, m.index) * m.initialMarginBps) / BPS;
    for (const o of mine) {
      let price = o.limitPrice;
      if (m.band) {
        if (o.isBuy && price > m.band.hi) price = m.band.hi;
        if (!o.isBuy && price < m.band.lo) price = m.band.lo;
      }
      const adverse = o.isBuy ? (price > m.index ? price - m.index : 0n) : m.index > price ? m.index - price : 0n;
      // +1 per term: the contract rounds notional and fees up.
      total += (notionalUsdc(o.size, price) * m.takerFeeBps) / BPS + notionalUsdc(o.size, adverse) + 2n;
    }
  }
  return total;
}
