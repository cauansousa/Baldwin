// Tolerant decoding of engine JSON into the UI types. All bigints arrive as
// decimal strings (docs/SPEC.md).

import { bigintFromJson } from "../lib/units";
import type { BookLevel, CancelResult, EngineHealth, MarketInfo, OpenOrder, OrderBook, PostOrderResult, Trade } from "./types";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accepts either a bare array or an object wrapping it under one of `keys`. */
function unwrapList(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    for (const key of keys) {
      const inner = value[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  throw new Error("Resposta inesperada do motor de ordens.");
}

export function normalizeHealth(value: unknown): EngineHealth {
  const v = isObject(value) ? value : {};
  const chain = isObject(v.chain) ? v.chain : undefined;
  const nullable = (x: unknown, field: string) => (x === null || x === undefined ? null : bigintFromJson(x, field));
  const markets = (Array.isArray(chain?.markets) ? chain.markets : []).filter(isObject).flatMap((m) => {
    try {
      const band = isObject(m.band)
        ? { lower: bigintFromJson(m.band.lo ?? m.band.lower, "band.lo"), upper: bigintFromJson(m.band.hi ?? m.band.upper, "band.hi") }
        : null;
      return [{ marketId: Number(m.marketId), indexPrice: nullable(m.indexPrice, "indexPrice"), band }];
    } catch {
      return [];
    }
  });
  const settlement = isObject(v.settlement) ? v.settlement : {};
  const recovering = v.recovering === true || settlement.recovering === true;
  return {
    ok: v.ok !== false,
    recovering,
    stalled: typeof settlement.stalled === "boolean" ? settlement.stalled : v.ok === false && !recovering,
    paused: typeof chain?.paused === "boolean" ? chain.paused : undefined,
    insuranceFund: optionalBigint(v.insuranceFund),
    totalBadDebt: optionalBigint(v.totalBadDebt),
    markets,
  };
}

export function normalizeMarkets(value: unknown): MarketInfo[] {
  return unwrapList(value, ["markets", "data"])
    .filter(isObject)
    .map((m) => ({
      marketId: Number(m.marketId ?? m.id),
      symbol: String(m.symbol ?? `#${String(m.marketId ?? m.id)}`),
    }))
    .filter((m) => Number.isInteger(m.marketId) && m.marketId >= 0)
    .sort((a, b) => a.marketId - b.marketId);
}

function normalizeLevel(value: unknown): BookLevel | null {
  let price: unknown;
  let size: unknown;
  if (Array.isArray(value)) [price, size] = value;
  else if (isObject(value)) {
    price = value.price;
    size = value.size ?? value.quantity;
  } else return null;
  try {
    const level = { price: bigintFromJson(price, "price"), size: bigintFromJson(size, "size") };
    return level.size > 0n && level.price > 0n ? level : null;
  } catch {
    return null;
  }
}

/** Returns null when the payload does not carry both sides of a book. */
export function tryNormalizeOrderBook(value: unknown): OrderBook | null {
  if (!isObject(value) || !Array.isArray(value.bids) || !Array.isArray(value.asks)) return null;
  const side = (levels: unknown[]) => levels.map(normalizeLevel).filter((l): l is BookLevel => l !== null);
  const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    bids: side(value.bids).sort((a, b) => cmp(b.price, a.price)),
    asks: side(value.asks).sort((a, b) => cmp(a.price, b.price)),
  };
}

export function normalizeOrderBook(value: unknown): OrderBook {
  const book = tryNormalizeOrderBook(value);
  if (!book) throw new Error("Resposta inesperada do motor de ordens (livro).");
  return book;
}

function normalizeTrade(value: unknown): Trade | null {
  if (!isObject(value)) return null;
  try {
    const price = bigintFromJson(value.price, "price");
    const size = bigintFromJson(value.size ?? value.fillSize, "size");
    const rawTime = Number(value.timestamp ?? value.time ?? value.ts ?? 0);
    // Seconds vs milliseconds: anything before year ~2001 in ms is seconds.
    const timestampMs = !Number.isFinite(rawTime) ? 0 : rawTime < 1e12 ? rawTime * 1000 : rawTime;
    const takerIsBuy =
      typeof value.takerIsBuy === "boolean"
        ? value.takerIsBuy
        : typeof value.isBuy === "boolean"
          ? value.isBuy
          : String(value.side ?? "").toLowerCase() === "buy";
    const id = String(value.id ?? value.tradeId ?? `${timestampMs}:${price}:${size}:${takerIsBuy ? "b" : "s"}`);
    return { id, price, size, takerIsBuy, timestampMs };
  } catch {
    return null;
  }
}

/** Accepts one trade or a list; result is newest first. */
export function normalizeTrades(value: unknown): Trade[] {
  const list = Array.isArray(value) || (isObject(value) && Array.isArray(value.trades)) ? unwrapList(value, ["trades"]) : [value];
  return list
    .map(normalizeTrade)
    .filter((t): t is Trade => t !== null)
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

/** Merges new trades into an existing newest-first list, de-duplicated and capped. */
export function mergeTrades(existing: Trade[], incoming: Trade[], cap = 60): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const t of [...incoming, ...existing]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  // Stable sort keeps arrival order for trades sharing a timestamp.
  return out.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, cap);
}

function normalizeOpenOrder(value: unknown): OpenOrder | null {
  if (!isObject(value)) return null;
  const o = isObject(value.order) ? value.order : value;
  try {
    const size = bigintFromJson(o.size, "size");
    const opt = (v: unknown, field: string) => (v === undefined || v === null ? undefined : bigintFromJson(v, field));
    const filledSize = opt(value.filled, "filled") ?? opt(value.filledSize, "filledSize") ?? 0n;
    const pendingSize = opt(value.pending, "pending") ?? 0n;
    let remainingSize =
      opt(value.remaining, "remaining") ?? opt(value.remainingSize, "remainingSize") ?? size - filledSize - pendingSize;
    if (remainingSize < 0n) remainingSize = 0n;
    const status =
      typeof value.status === "string" && value.status
        ? value.status
        : remainingSize > 0n
          ? filledSize + pendingSize > 0n
            ? "partially_filled"
            : "open"
          : pendingSize > 0n
            ? "pending_settlement"
            : "filled";
    return {
      orderHash: String(value.orderHash ?? value.hash) as `0x${string}`,
      order: {
        trader: String(o.trader) as `0x${string}`,
        marketId: Number(o.marketId),
        isBuy: Boolean(o.isBuy),
        reduceOnly: Boolean(o.reduceOnly),
        size,
        limitPrice: bigintFromJson(o.limitPrice, "limitPrice"),
        nonce: bigintFromJson(o.nonce, "nonce"),
        expiry: bigintFromJson(o.expiry, "expiry"),
      },
      status,
      filledSize,
      pendingSize,
      remainingSize,
      postOnly: value.postOnly === true,
      ioc: value.ioc === true,
    };
  } catch {
    return null;
  }
}

/** Only orders that are still (partly) resting and not closed by the engine can be cancelled. */
export function isCancellable(o: OpenOrder): boolean {
  return o.remainingSize > 0n && (o.status === "open" || o.status === "partially_filled");
}

export function normalizeOpenOrders(value: unknown): OpenOrder[] {
  return unwrapList(value, ["orders", "data"])
    .map(normalizeOpenOrder)
    .filter((o): o is OpenOrder => o !== null);
}

export function normalizePostOrderResult(value: unknown): PostOrderResult {
  const v = isObject(value) ? value : {};
  const fills = (Array.isArray(v.fills) ? v.fills : []).flatMap((f) => {
    if (!isObject(f)) return [];
    try {
      return [{ price: bigintFromJson(f.price, "price"), size: bigintFromJson(f.size ?? f.fillSize, "size") }];
    } catch {
      return [];
    }
  });
  return {
    orderHash: String(v.orderHash ?? ""),
    status: String(v.status ?? ""),
    reason: typeof v.reason === "string" && v.reason ? v.reason : undefined,
    fills,
    duplicate: v.duplicate === true,
    remaining: optionalBigint(v.remaining),
    pending: optionalBigint(v.pending),
    filled: optionalBigint(v.filled),
  };
}

function optionalBigint(value: unknown): bigint | undefined {
  try {
    return value === undefined || value === null ? undefined : bigintFromJson(value, "amount");
  } catch {
    return undefined;
  }
}

export function normalizeCancelResult(value: unknown): CancelResult {
  const v = isObject(value) ? value : {};
  return { status: String(v.status ?? ""), known: v.known !== false };
}
