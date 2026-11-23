import type { EngineApi, OrderBook } from "../api/types";
import { EngineError } from "../lib/errors";
import { buildBook, getMarket, makeTrade, markets, newOrderHash, openOrders } from "./state";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireMarket(marketId: number) {
  const m = getMarket(marketId);
  if (!m) throw new EngineError(404, "unknown market");
  return m;
}

/** Fake engine: same interface as the HTTP client, backed by mock/state.ts. */
export const mockEngine: EngineApi = {
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
    if (size < m.minOrderSize) throw new EngineError(400, "order size below market minimum");
    if (!/^0x[0-9a-f]{128}(1b|1c)$/i.test(req.signature)) throw new EngineError(400, "signature must be a 65-byte hex string with v = 27/28");
    const orderHash = newOrderHash();
    if (req.ioc) return { orderHash, status: "cancelled", reason: "IOC order: nothing to match", fills: [] };
    openOrders.unshift({
      orderHash,
      order: {
        ...req.order,
        size,
        limitPrice: BigInt(req.order.limitPrice),
        nonce: BigInt(req.order.nonce),
        expiry: BigInt(req.order.expiry),
      },
      status: "open",
      filledSize: 0n,
      pendingSize: 0n,
      remainingSize: size,
      postOnly: req.postOnly === true,
      ioc: false,
    });
    return { orderHash, status: "open", fills: [] };
  },
  async cancelOrder(orderHash) {
    await sleep(300);
    const index = openOrders.findIndex((o) => o.orderHash === orderHash);
    if (index < 0) throw new EngineError(404, "order not found");
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
