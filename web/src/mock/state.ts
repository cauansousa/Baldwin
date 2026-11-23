// In-memory fake exchange used only when VITE_MOCK=1 (development).
// Prices here are generated with Math.random — this is demo data, not money math.

import { WAD } from "@shared";
import type { BookLevel, OpenOrder, OrderBook, Trade } from "../api/types";
import { mulBps, notionalUsdc, unrealizedPnlUsdc } from "../lib/risk";

export const MOCK_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

const CENT = WAD / 100n;
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const wad = (value: number, decimals = 4) => (BigInt(Math.round(value * 10 ** decimals)) * WAD) / 10n ** BigInt(decimals);

export interface MockMarket {
  marketId: number;
  symbol: string;
  priceCents: number; // index price
  markOffsetCents: number;
  tickCents: number;
  baseSize: number; // typical book level size
  initialMarginBps: number;
  maintenanceMarginBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  liquidationPenaltyBps: number;
  minOrderSize: bigint;
  trades: Trade[];
}

function market(
  marketId: number,
  symbol: string,
  price: number,
  tickCents: number,
  baseSize: number,
  minOrderSize: number,
): MockMarket {
  return {
    marketId,
    symbol,
    priceCents: Math.round(price * 100),
    markOffsetCents: tickCents * 3,
    tickCents,
    baseSize,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    makerFeeBps: 2,
    takerFeeBps: 5,
    liquidationPenaltyBps: 250,
    minOrderSize: wad(minOrderSize),
    trades: [],
  };
}

export const markets: MockMarket[] = [
  market(0, "BTC-USD", 97_432.5, 50, 0.4, 0.001),
  market(1, "ETH-USD", 3_415.2, 5, 6, 0.01),
  market(2, "SOL-USD", 187.64, 1, 90, 0.1),
];

export const account = {
  walletUsdc: usdc(25_000),
  allowance: 0n,
  balance: usdc(12_500),
  positions: new Map<number, { size: bigint; entryNotional: bigint }>([
    [0, { size: wad(0.35), entryNotional: usdc(0.35 * 96_200) }],
    [1, { size: -wad(4.2), entryNotional: usdc(4.2 * 3_480) }],
  ]),
};

let orderSeq = 0;
const fakeHash = () => `0x${(++orderSeq).toString(16).padStart(64, "a")}` as `0x${string}`;

export const openOrders: OpenOrder[] = [
  {
    orderHash: fakeHash(),
    order: {
      trader: MOCK_ACCOUNT,
      marketId: 0,
      isBuy: true,
      reduceOnly: false,
      size: wad(0.1),
      limitPrice: wad(96_500, 2),
      nonce: 1n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    },
    status: "partially_filled",
    filledSize: wad(0.015),
    pendingSize: wad(0.01),
    remainingSize: wad(0.075),
    postOnly: true,
    ioc: false,
  },
  {
    orderHash: fakeHash(),
    order: {
      trader: MOCK_ACCOUNT,
      marketId: 1,
      isBuy: true,
      reduceOnly: true,
      size: wad(2),
      limitPrice: wad(3_360, 2),
      nonce: 2n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    },
    status: "open",
    filledSize: 0n,
    pendingSize: 0n,
    remainingSize: wad(2),
    postOnly: false,
    ioc: false,
  },
  {
    // Fully matched, part still awaiting settlement: listed, but nothing left to cancel.
    orderHash: fakeHash(),
    order: {
      trader: MOCK_ACCOUNT,
      marketId: 2,
      isBuy: true,
      reduceOnly: false,
      size: wad(12),
      limitPrice: wad(187.7, 2),
      nonce: 3n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    },
    status: "pending_settlement",
    filledSize: wad(4),
    pendingSize: wad(8),
    remainingSize: 0n,
    postOnly: false,
    ioc: true,
  },
];

export const newOrderHash = fakeHash;

export const getMarket = (marketId: number) => markets.find((m) => m.marketId === marketId);
export const indexPrice = (m: MockMarket) => BigInt(m.priceCents) * CENT;
export const markPrice = (m: MockMarket) => BigInt(m.priceCents + m.markOffsetCents) * CENT;

export function accountValue(): bigint {
  let value = account.balance;
  for (const [marketId, pos] of account.positions) {
    const m = getMarket(marketId);
    if (m) value += unrealizedPnlUsdc(pos.size, pos.entryNotional, indexPrice(m));
  }
  return value;
}

export function marginRequirement(): { initial: bigint; maintenance: bigint } {
  let initial = 0n;
  let maintenance = 0n;
  for (const [marketId, pos] of account.positions) {
    const m = getMarket(marketId);
    if (!m) continue;
    const notional = notionalUsdc(pos.size, indexPrice(m));
    initial += mulBps(notional, m.initialMarginBps);
    maintenance += mulBps(notional, m.maintenanceMarginBps);
  }
  return { initial, maintenance };
}

export function freeCollateral(): bigint {
  const free = accountValue() - marginRequirement().initial;
  return free > 0n ? free : 0n;
}

export function buildBook(m: MockMarket, depth: number): OrderBook {
  const side = (direction: 1 | -1): BookLevel[] =>
    Array.from({ length: depth }, (_, i) => {
      const cents = m.priceCents - (m.priceCents % m.tickCents) + direction * (i + 1) * m.tickCents;
      const size = m.baseSize * (0.25 + Math.random() * (1 + i * 0.35));
      return { price: BigInt(cents) * CENT, size: wad(size) };
    });
  return { bids: side(-1), asks: side(1) };
}

let tradeSeq = 0;
export function makeTrade(m: MockMarket, timestampMs: number): Trade {
  const takerIsBuy = Math.random() > 0.5;
  const cents = m.priceCents - (m.priceCents % m.tickCents) + (takerIsBuy ? m.tickCents : -m.tickCents);
  return {
    id: `mock-${++tradeSeq}`,
    price: BigInt(cents) * CENT,
    size: wad(m.baseSize * (0.02 + Math.random() * 0.6)),
    takerIsBuy,
    timestampMs,
  };
}

/** Random-walks every index price a little; called once per second. */
function tick() {
  for (const m of markets) {
    const step = Math.round((Math.random() - 0.5) * 6) * m.tickCents;
    m.priceCents = Math.max(m.tickCents * 10, m.priceCents + step);
  }
}

const now = Date.now();
for (const m of markets) {
  m.trades = Array.from({ length: 40 }, (_, i) => makeTrade(m, now - i * 7_300));
}
setInterval(tick, 1000);
