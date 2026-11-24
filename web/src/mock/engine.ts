import type { EngineApi, OrderBook } from "../api/types";
import { EngineError } from "../lib/errors";
import { account, buildBook, getMarket, makeTrade, markets, newOrderHash, openOrders } from "./state";

/**
 * Failure injection for POST /orders, from the page URL, consumed one per call:
 *   ?mockSubmit=timeout,unknown   order registered, then a timeout / "state unknown" 503
 *   ?mockSubmit=lost              request lost (order not registered), reported as a timeout
 *   ?mockSubmit=refused           503 SHUTTING_DOWN (definitely not accepted)
 * Cancels can be made to fail once with ?mockCancel=fail.
 */
const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const submitFaults = (params.get("mockSubmit") ?? "").split(",").filter(Boolean);
const cancelFaults = (params.get("mockCancel") ?? "").split(",").filter(Boolean);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireMarket(marketId: number) {
  const m = getMarket(marketId);
  if (!m) throw new EngineError(404, "unknown market");
  return m;
}

/** Fake engine: same interface as the HTTP client, backed by mock/state.ts. */
export const mockEngine: EngineApi = {
  async getHealth() {
    return { ok: true, paused: false, markets: [] };
  },
  async getMarkets() {
    return markets.map(({ marketId, symbol }) => ({ marketId, symbol }));
  },
  async getOrderBook(marketId, depth): Promise<OrderBook> {
    return buildBook(requireMarket(marketId), depth);
  },
  async getTrades(marketId) {
    return requireMarket(marketId).trades;
  },
  async getOpenOrders(trader) {
    return openOrders.filter((o) => o.order.trader.toLowerCase() === trader.toLowerCase());
  },
  async postOrder(req) {
    await sleep(400);
    const m = requireMarket(req.order.marketId);
    const size = BigInt(req.order.size);
    const nonce = BigInt(req.order.nonce);
    // Idempotent by order identity, like the real engine: a resubmission returns the current state.
    const existing = openOrders.find((o) => o.order.nonce === nonce && o.order.trader.toLowerCase() === req.order.trader.toLowerCase());
    if (existing) return { orderHash: existing.orderHash, status: existing.status, fills: [] };
    if (size < m.minOrderSize) throw new EngineError(400, "Tamanho abaixo do mínimo do mercado.", "BELOW_MIN_SIZE");
    if (!/^0x[0-9a-f]{128}(1b|1c)$/i.test(req.signature)) throw new EngineError(400, "signature must be a 65-byte hex string with v = 27/28");
    if (nonce < account.minValidNonce || account.cancelledNonces.has(nonce)) {
      throw new EngineError(409, "O nonce desta ordem já foi cancelado. Envie uma nova ordem.", "NONCE_CANCELLED");
    }
    const fault = submitFaults.shift();
    if (fault === "refused") throw new EngineError(503, "O motor está reiniciando e não aceitou a ordem. Tente de novo em instantes.", "SHUTTING_DOWN");
    if (fault === "lost") throw new DOMException("The operation timed out.", "TimeoutError"); // never reached the engine
    const orderHash = req.orderHash ?? newOrderHash();
    if (req.ioc) return { orderHash, status: "cancelled", reason: "IOC order: nothing to match", fills: [] };
    openOrders.unshift({
      orderHash,
      order: { ...req.order, size, limitPrice: BigInt(req.order.limitPrice), nonce, expiry: BigInt(req.order.expiry) },
      status: "open",
      filledSize: 0n,
      pendingSize: 0n,
      remainingSize: size,
      postOnly: req.postOnly === true,
      ioc: false,
    });
    // The order IS registered, but the caller is not told.
    if (fault === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (fault === "unknown") throw new EngineError(503, "O motor processou a ordem mas não conseguiu gravá-la; não se sabe se ela foi aceita.", "STATE_UNKNOWN");
    return { orderHash, status: "open", fills: [] };
  },
  async cancelOrder(orderHash) {
    await sleep(300);
    if (cancelFaults.shift() === "fail") throw new EngineError(503, "Erro interno do motor. Tente de novo em instantes.", "INTERNAL");
    const index = openOrders.findIndex((o) => o.orderHash === orderHash);
    if (index < 0) throw new EngineError(404, "Ordem não encontrada no motor.", "NOT_FOUND");
    openOrders.splice(index, 1);
  },
  openFeed(marketId, handlers) {
    const m = getMarket(marketId);
    const start = setTimeout(() => handlers.onStatus(true), 150);
    const timer = setInterval(() => {
      if (!m) return;
      handlers.onBook(buildBook(m, 25));
      if (Math.random() < 0.6) {
        const trade = makeTrade(m, Date.now());
        m.trades = [trade, ...m.trades].slice(0, 60);
        handlers.onTrades([trade]);
      }
    }, 1000);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  },
};
