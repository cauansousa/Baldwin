import { EngineError, parseEngineError } from "../lib/errors";
import {
  normalizeHealth,
  normalizeMarkets,
  normalizeOpenOrders,
  normalizeOrderBook,
  normalizePostOrderResult,
  normalizeTrades,
  tryNormalizeOrderBook,
} from "./normalize";
import type { EngineApi, FeedHandlers } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** WS message types that carry data; anything else typed (acks, pong, error) is ignored. */
export const DATA_MESSAGE_TYPES = new Set(["snapshot", "update"]);

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const { message, code } = parseEngineError(res.status, body, text);
    throw new EngineError(res.status, message, code);
  }
  return body;
}

export function wsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/i, "ws") + "/ws";
}

/**
 * Live feed over WS /ws with automatic reconnect (exponential backoff).
 * Subscriptions are re-sent on every (re)connect. Messages are matched by
 * `channel` and `marketId`; the payload may be inline or under `data`.
 */
function openFeed(baseUrl: string, marketId: number, handlers: FeedHandlers): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(baseUrl));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      for (const channel of ["orderbook", "trades"] as const) {
        ws.send(JSON.stringify({ op: "subscribe", channel, marketId }));
      }
      handlers.onStatus(true);
    };
    ws.onmessage = (event) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m.marketId !== undefined && Number(m.marketId) !== marketId) return;
      // Acknowledgements ("subscribed", "pong", ...) carry no market data.
      if (typeof m.type === "string" && !DATA_MESSAGE_TYPES.has(m.type)) return;
      const payload = m.data ?? m;
      if (m.channel === "orderbook") {
        // Anything that is not a full snapshot (e.g. a delta) triggers a REST re-fetch.
        handlers.onBook(tryNormalizeOrderBook(payload));
      } else if (m.channel === "trades") {
        const trades = normalizeTrades(payload);
        if (trades.length > 0) handlers.onTrades(trades);
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      handlers.onStatus(false);
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    attempt++;
    timer = setTimeout(connect, delay);
  };

  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    const ws = socket;
    socket = null;
    ws?.close();
  };
}

export function createHttpEngine(baseUrl: string): EngineApi {
  return {
    async getHealth() {
      return normalizeHealth(await request(baseUrl, "/health"));
    },
    async getMarkets() {
      return normalizeMarkets(await request(baseUrl, "/markets"));
    },
    async getOrderBook(marketId, depth) {
      return normalizeOrderBook(await request(baseUrl, `/orderbook/${marketId}?depth=${depth}`));
    },
    async getTrades(marketId) {
      return normalizeTrades(await request(baseUrl, `/trades/${marketId}`));
    },
    async getOpenOrders(trader) {
      return normalizeOpenOrders(await request(baseUrl, `/orders?trader=${trader}`));
    },
    async postOrder(req) {
      return normalizePostOrderResult(
        await request(baseUrl, "/orders", { method: "POST", body: JSON.stringify(req) }),
      );
    },
    async cancelOrder(orderHash, signature) {
      await request(baseUrl, `/orders/${orderHash}`, { method: "DELETE", body: JSON.stringify({ signature }) });
    },
    openFeed: (marketId, handlers) => openFeed(baseUrl, marketId, handlers),
  };
}
