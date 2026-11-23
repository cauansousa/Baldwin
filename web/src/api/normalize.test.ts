import { describe, expect, it } from "vitest";
import { mergeTrades, normalizeMarkets, normalizeOpenOrders, normalizeOrderBook, normalizeTrades, tryNormalizeOrderBook } from "./normalize";

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

  it("accepts nested or flat open orders and wrapped lists", () => {
    const order = { trader: "0xabc", marketId: 0, isBuy: true, reduceOnly: false, size: "10", limitPrice: "5", nonce: "1", expiry: "0" };
    const [nested] = normalizeOpenOrders([{ orderHash: "0x1", order, filledSize: "4" }]);
    expect(nested?.filledSize).toBe(4n);
    const [flat] = normalizeOpenOrders({ orders: [{ orderHash: "0x2", ...order, remainingSize: "7" }] });
    expect(flat?.filledSize).toBe(3n);
    expect(flat?.order.size).toBe(10n);
    // Engine shape: remaining / pending / filled — "executed" counts pending matches too.
    const [view] = normalizeOpenOrders([{ orderHash: "0x3", order, remaining: "6", pending: "3", filled: "1", postOnly: true, ioc: false }]);
    expect(view?.filledSize).toBe(4n);
    expect(view?.postOnly).toBe(true);
  });

  it("normalizes markets", () => {
    expect(normalizeMarkets([{ marketId: 1, symbol: "ETH-USD" }, { marketId: 0, symbol: "BTC-USD", indexPrice: "1" }])).toEqual([
      { marketId: 0, symbol: "BTC-USD" },
      { marketId: 1, symbol: "ETH-USD" },
    ]);
  });
});
