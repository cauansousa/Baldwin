import { describe, expect, it } from "vitest";
import { DATA_MESSAGE_TYPES } from "./http";
import { isCancellable, normalizeCancelResult, normalizeHealth, normalizePostOrderResult, mergeTrades, normalizeMarkets, normalizeOpenOrders, normalizeOrderBook, normalizeTrades, tryNormalizeOrderBook } from "./normalize";

describe("engine payload normalization", () => {
  it("sorts the book and drops empty levels", () => {
    const book = normalizeOrderBook({
      bids: [{ price: "99", size: "1" }, { price: "100", size: "2" }, { price: "98", size: "0" }],
      asks: [["102", "1"], ["101", "3"]],
    });
    expect(book.bids.map((l) => l.price)).toEqual([100n, 99n]);
    expect(book.asks.map((l) => l.price)).toEqual([101n, 102n]);
    expect(tryNormalizeOrderBook({ side: "bid", price: "1", size: "1" })).toBeNull();
  });

  it("normalizes trades (seconds or milliseconds) newest first", () => {
    const trades = normalizeTrades([
      { price: "1", size: "2", takerIsBuy: true, timestamp: 1_800_000_000 },
      { price: "3", size: "4", takerIsBuy: false, timestamp: 1_800_000_001_000 },
    ]);
    expect(trades.map((t) => t.timestampMs)).toEqual([1_800_000_001_000, 1_800_000_000_000]);
    expect(normalizeTrades({ price: "1", size: "2", takerIsBuy: true, timestamp: 5 })).toHaveLength(1);
    expect(normalizeTrades({ trades: [] })).toEqual([]);
  });

  it("merges trades without duplicates and caps the list", () => {
    const t = (id: string, ms: number) => ({ id, price: 1n, size: 1n, takerIsBuy: true, timestampMs: ms });
    const merged = mergeTrades([t("a", 1), t("b", 2)], [t("b", 2), t("c", 3)], 2);
    expect(merged.map((x) => x.id)).toEqual(["c", "b"]);
  });

  const order = { trader: "0xabc", marketId: 0, isBuy: true, reduceOnly: false, size: "10", limitPrice: "5", nonce: "1", expiry: "9" };

  it("reads the engine order view: confirmed, pending and remaining are separate", () => {
    const [view] = normalizeOpenOrders([
      { orderHash: "0x3", order, status: "partially_filled", remaining: "6", pending: "3", filled: "1", postOnly: true, ioc: false },
    ]);
    expect(view).toMatchObject({ status: "partially_filled", filledSize: 1n, pendingSize: 3n, remainingSize: 6n, postOnly: true });
    expect(isCancellable(view!)).toBe(true);
  });

  it("orders with nothing resting, or closed by the engine, are not cancellable", () => {
    const [settling, closed] = normalizeOpenOrders([
      { orderHash: "0x4", order, status: "pending_settlement", remaining: "0", pending: "10", filled: "0" },
      { orderHash: "0x5", order, status: "cancelled", remaining: "0", pending: "4", filled: "2", reason: "cancelled by trader" },
    ]);
    expect(settling?.filledSize).toBe(0n); // pending is NOT reported as executed
    expect(settling?.pendingSize).toBe(10n);
    expect(isCancellable(settling!)).toBe(false);
    expect(isCancellable(closed!)).toBe(false);
  });

  it("accepts nested or flat open orders, wrapped lists, and derives missing fields", () => {
    const [nested] = normalizeOpenOrders([{ orderHash: "0x1", order, filledSize: "4" }]);
    expect(nested).toMatchObject({ filledSize: 4n, pendingSize: 0n, remainingSize: 6n, status: "partially_filled" });
    const [flat] = normalizeOpenOrders({ orders: [{ orderHash: "0x2", ...order, remainingSize: "10" }] });
    expect(flat).toMatchObject({ filledSize: 0n, remainingSize: 10n, status: "open" });
    expect(flat?.order.size).toBe(10n);
  });

  it("only snapshot/update WS messages carry data (acks are ignored)", () => {
    expect(DATA_MESSAGE_TYPES.has("snapshot")).toBe(true);
    expect(DATA_MESSAGE_TYPES.has("update")).toBe(true);
    for (const t of ["subscribed", "unsubscribed", "pong", "error"]) expect(DATA_MESSAGE_TYPES.has(t)).toBe(false);
  });

  it("reads the chain section of GET /health", () => {
    const health = normalizeHealth({
      ok: false,
      settlement: { stalled: true },
      chain: {
        paused: true,
        markets: [
          { marketId: 0, indexPrice: "100", band: { lo: "95", hi: "105" } },
          { marketId: 1, indexPrice: null, band: null },
        ],
      },
    });
    expect(health).toEqual({
      ok: false,
      recovering: false,
      stalled: true,
      paused: true,
      markets: [
        { marketId: 0, indexPrice: 100n, band: { lower: 95n, upper: 105n } },
        { marketId: 1, indexPrice: null, band: null },
      ],
    });
    // Engine without a chain reader, or an unexpected body: nothing is assumed.
    const blank = { ok: true, recovering: false, stalled: false, paused: undefined, markets: [] };
    expect(normalizeHealth({ ok: true, chain: null })).toEqual(blank);
    expect(normalizeHealth("nope")).toEqual(blank);
    // Recovering makes ok false, but that is not a settlement stall.
    expect(normalizeHealth({ ok: false, recovering: true, settlement: { recovering: true, stalled: false } })).toMatchObject({
      ok: false,
      recovering: true,
      stalled: false,
    });
    expect(normalizeHealth({ ok: false })).toMatchObject({ recovering: false, stalled: true });
  });

  it("reads POST /orders answers, including the idempotent duplicate", () => {
    const fresh = normalizePostOrderResult({
      orderHash: "0x1",
      status: "partially_filled",
      fills: [{ makerOrderHash: "0xa", takerOrderHash: "0x1", price: "5", size: "2", status: "pending" }],
      remaining: "8",
      pending: "2",
      filled: "0",
    });
    expect(fresh).toMatchObject({ status: "partially_filled", duplicate: false, remaining: 8n, pending: 2n, filled: 0n });
    expect(fresh.fills).toEqual([{ price: 5n, size: 2n }]);
    const again = normalizePostOrderResult({ orderHash: "0x1", status: "open", fills: [], remaining: "8", pending: "0", filled: "2", duplicate: true });
    expect(again).toMatchObject({ duplicate: true, status: "open", remaining: 8n, filled: 2n, fills: [] });
  });

  it("reads DELETE /orders answers: a cancel of an order the engine never saw is still a 200", () => {
    expect(normalizeCancelResult({ orderHash: "0x1", status: "cancelled", known: false })).toEqual({ status: "cancelled", known: false });
    expect(normalizeCancelResult({ orderHash: "0x1", status: "cancelled", remaining: "0" })).toEqual({ status: "cancelled", known: true });
  });

  it("normalizes markets", () => {
    expect(normalizeMarkets([{ marketId: 1, symbol: "ETH-USD" }, { marketId: 0, symbol: "BTC-USD", indexPrice: "1" }])).toEqual([
      { marketId: 0, symbol: "BTC-USD" },
      { marketId: 1, symbol: "ETH-USD" },
    ]);
  });
});
