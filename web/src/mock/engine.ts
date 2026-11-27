import type { EngineApi, OrderBook } from "../api/types";
import { EngineError } from "../lib/errors";
import { account, buildBook, fundingRate, getMarket, indexPrice, lastFundingTime, markPrice, protocol, makeTrade, markets, newOrderHash, openOrders } from "./state";

/**
 * Failure injection for POST /orders, from the page URL, consumed one per call:
 *   ?mockSubmit=timeout,unknown   order registered, then a timeout / "state unknown" 503
 *   ?mockSubmit=lost              request lost (order not registered), reported as a timeout
 *   ?mockSubmit=refused           503 SHUTTING_DOWN (definitely not accepted)
 *   ?mockSubmit=closed            accepted, closed at once by the engine, answer lost; the retry
 *                                 gets 200 `duplicate: true` with status "cancelled"
 * Cancels: ?mockCancel=fail (500, outcome unknown) or ?mockCancel=notfound (404), one per call.
 */
const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const submitFaults = (params.get("mockSubmit") ?? "").split(",").filter(Boolean);
const cancelFaults = (params.get("mockCancel") ?? "").split(",").filter(Boolean);

/** Orders the (mock) engine accepted and then closed, by nonce. */
const closedOrders = new Map<bigint, { orderHash: `0x${string}`; status: string; reason: string }>();

/** Nonces cancelled off-chain at the (mock) engine. */
const deadNonces = new Set<bigint>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireMarket(marketId: number) {
  const m = getMarket(marketId);
  if (!m) throw new EngineError(404, "unknown market");
  return m;
}

/** Fake engine: same interface as the HTTP client, backed by mock/state.ts. */
export const mockEngine: EngineApi = {
  async getHealth() {
    const figures = params.get("mockEngineStats") === "0" ? {} : { insuranceFund: protocol.insuranceFund, totalBadDebt: protocol.totalBadDebt };
    // ?mockOiCap=1: the first market has reached its open-interest cap.
    const capped = params.has("mockOiCap");
    return {
      ok: true,
      time: Math.floor(Date.now() / 1000),
      recovering: false,
      stalled: false,
      paused: false,
      markets: markets.map((m, i) => ({ marketId: m.marketId, indexPrice: indexPrice(m), band: null, openInterestCapReached: capped && i === 0 })),
      ...figures,
    };
  },
  async getMarkets() {
    // ?mockEngineStats=0: the engine reports no figures, so everything is read from the (mock) chain.
    if (params.get("mockEngineStats") === "0") return markets.map(({ marketId, symbol }) => ({ marketId, symbol, stats: {} }));
    return markets.map((m) => {
      const openInterest = BigInt(Math.round(m.openInterest * 1000)) * 10n ** 15n;
      return {
        marketId: m.marketId,
        symbol: m.symbol,
        stats: {
          indexPrice: indexPrice(m),
          lastPrice: markPrice(m),
          markTwap: (indexPrice(m) + markPrice(m)) / 2n,
          currentFundingRate: fundingRate(m),
          lastFundingTime: lastFundingTime(),
          nextFundingTime: lastFundingTime() + 3600n,
          openInterestLong: openInterest,
          openInterestShort: openInterest,
        },
      };
    });
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
    const closed = closedOrders.get(nonce);
    if (closed) {
      // A known closed order: 200 with its real status, not an error.
      return { orderHash: closed.orderHash, status: closed.status, reason: closed.reason, fills: [], duplicate: true, remaining: 0n, pending: 0n, filled: 0n };
    }
    if (existing) {
      return {
        orderHash: existing.orderHash,
        status: existing.status,
        fills: [],
        duplicate: true,
        remaining: existing.remainingSize,
        pending: existing.pendingSize,
        filled: existing.filledSize,
      };
    }
    if (size < m.minOrderSize) throw new EngineError(400, "Tamanho abaixo do mínimo do mercado.", "BELOW_MIN_SIZE", "not_applied");
    if (!/^0x[0-9a-f]{128}(1b|1c)$/i.test(req.signature)) throw new EngineError(400, "signature must be a 65-byte hex string with v = 27/28");
    if (nonce < account.minValidNonce || account.cancelledNonces.has(nonce) || deadNonces.has(nonce)) {
      throw new EngineError(409, "O nonce desta ordem já foi cancelado. Envie uma nova ordem.", "NONCE_CANCELLED", "not_applied");
    }
    const fault = submitFaults.shift();
    if (fault === "refused") throw new EngineError(503, "O motor está reiniciando e não aceitou a ordem. Tente de novo em instantes.", "SHUTTING_DOWN", "not_applied");
    if (fault === "closed") {
      // Accepted and immediately closed by the engine; the answer is lost.
      closedOrders.set(nonce, {
        orderHash: req.orderHash ?? newOrderHash(),
        status: "cancelled",
        reason: "open-interest cap reached: only fills that do not add open interest can trade",
      });
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    if (fault === "lost") throw new DOMException("The operation timed out.", "TimeoutError"); // never reached the engine
    const orderHash = req.orderHash ?? newOrderHash();
    const amounts = { duplicate: false, remaining: size, pending: 0n, filled: 0n };
    if (req.ioc) return { orderHash, status: "cancelled", reason: "IOC order: nothing to match", fills: [], ...amounts, remaining: 0n };
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
    if (fault === "unknown") throw new EngineError(503, "O motor processou a ordem mas não conseguiu gravá-la; não se sabe se ela foi aceita.", "STATE_UNKNOWN", "unknown");
    return { orderHash, status: "open", fills: [], ...amounts };
  },
  async cancelOrder(orderHash, _signature, _trader, nonce) {
    await sleep(300);
    const fault = cancelFaults.shift();
    if (fault === "fail") throw new EngineError(500, "Erro interno do motor. Tente de novo em instantes.", "INTERNAL", "unknown");
    if (fault === "notfound") throw new EngineError(404, "Ordem não encontrada no motor.", "NOT_FOUND", "not_applied");
    // Like the real engine: the nonce is dead from now on, whether or not the order was known.
    deadNonces.add(nonce);
    const index = openOrders.findIndex((o) => o.orderHash === orderHash);
    if (index < 0) return { status: "cancelled", known: false };
    openOrders.splice(index, 1);
    return { status: "cancelled", known: true };
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
