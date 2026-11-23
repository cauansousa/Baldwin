// Tolerant decoding of engine JSON into the UI types. All bigints arrive as
// decimal strings (docs/SPEC.md).

import { bigintFromJson } from "../lib/units";
import type { BookLevel, MarketInfo, OpenOrder, OrderBook, PostOrderResult, Trade } from "./types";

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
    // Prefer "what is no longer resting" (includes matches awaiting settlement).
    let filledSize = 0n;
    if (value.remaining !== undefined) filledSize = size - bigintFromJson(value.remaining, "remaining");
    else if (value.remainingSize !== undefined) filledSize = size - bigintFromJson(value.remainingSize, "remainingSize");
    else if (value.filledSize !== undefined) filledSize = bigintFromJson(value.filledSize, "filledSize");
    else if (value.filled !== undefined) filledSize = bigintFromJson(value.filled, "filled");
    if (filledSize < 0n) filledSize = 0n;
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
      filledSize,
      postOnly: value.postOnly === true,
      ioc: value.ioc === true,
    };
  } catch {
    return null;
  }
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
  };
}
