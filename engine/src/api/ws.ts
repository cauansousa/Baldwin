import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Engine, Trade } from "../engine/engine.ts";
import { jsonReplacer } from "../types.ts";
import type { RateLimiter } from "./rateLimit.ts";

/**
 * WS /ws protocol (all messages JSON, bigints as decimal strings).
 *
 * client -> server
 *   { "op": "subscribe" | "unsubscribe", "channel": "orderbook" | "trades", "marketId": 0 }
 *   { "op": "ping" }
 * server -> client
 *   { "type": "subscribed" | "unsubscribed", "channel", "marketId" }
 *   { "type": "snapshot", "channel": "orderbook", "marketId", "data": { "bids": [{price,size}], "asks": [...] } }
 *       sent on subscribe and again (full book, top 50 levels) after every change
 *   { "type": "snapshot", "channel": "trades", "marketId", "data": Trade[] }   recent trades, newest first
 *   { "type": "update",   "channel": "trades", "marketId", "data": Trade[] }   new on-chain confirmed trades
 *   { "type": "pong" } / { "type": "error", "message" }
 */

const BOOK_DEPTH = 50;
const MAX_BUFFERED = 1024 * 1024;
const MAX_MESSAGES_PER_10S = 100;
const CHANNELS = ["orderbook", "trades"] as const;
type Channel = (typeof CHANNELS)[number];

interface Client {
  ws: WebSocket;
  ip: string;
  subs: Set<string>;
  alive: boolean;
  msgCount: number;
}

const subKey = (channel: Channel, marketId: number) => `${channel}:${marketId}`;

export function attachWebSocket(server: Server, engine: Engine, opts: { limiter: RateLimiter; trustProxy: boolean; maxConnections: number; maxConnectionsPerIp: number },
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set<Client>();
  const perIp = new Map<string, number>();
  let total = 0;

  const clientIp = (req: IncomingMessage): string => {
    const fwd = opts.trustProxy ? req.headers["x-forwarded-for"] : undefined;
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    return first || req.socket.remoteAddress || "unknown";
  };

  const onUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const ip = clientIp(req);
    if (!opts.limiter.take(ip)) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    if ((perIp.get(ip) ?? 0) >= opts.maxConnectionsPerIp) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    if (total >= opts.maxConnections) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    // Counted here, before the asynchronous handshake, so a burst cannot overshoot.
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    total++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      total--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, ip));
  };
  server.on("upgrade", onUpgrade);

  const send = (c: Client, msg: unknown) => {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) {
      c.ws.terminate(); // slow consumer
      return;
    }
    c.ws.send(JSON.stringify(msg, jsonReplacer));
  };

  const bookSnapshot = (marketId: number) => {
    const { bids, asks } = engine.getOrderBook(marketId, BOOK_DEPTH);
    return { type: "snapshot", channel: "orderbook", marketId, data: { bids, asks } };
  };

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, ip: string) => {
    const c: Client = { ws, ip, subs: new Set(), alive: true, msgCount: 0 };
    clients.add(c);
    ws.on("pong", () => (c.alive = true));
    ws.on("close", () => clients.delete(c));
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw, isBinary) => {
      if (++c.msgCount > MAX_MESSAGES_PER_10S) return ws.close(1008, "too many messages");
      let msg: unknown;
      try {
        if (isBinary) throw new Error("binary");
        msg = JSON.parse(raw.toString());
      } catch {
        return send(c, { type: "error", message: "messages must be JSON text" });
      }
      const m = (typeof msg === "object" && msg !== null ? msg : {}) as Record<string, unknown>;
      if (m.op === "ping") return send(c, { type: "pong" });
      if (m.op !== "subscribe" && m.op !== "unsubscribe") {
        return send(c, { type: "error", message: 'op must be "subscribe", "unsubscribe" or "ping"' });
      }
      if (!CHANNELS.includes(m.channel as Channel)) {
        return send(c, { type: "error", message: 'channel must be "orderbook" or "trades"' });
      }
      const channel = m.channel as Channel;
      const marketId = typeof m.marketId === "string" && /^[0-9]{1,10}$/.test(m.marketId) ? Number(m.marketId) : m.marketId;
      if (typeof marketId !== "number" || !Number.isInteger(marketId) || !engine.hasMarket(marketId)) {
        return send(c, { type: "error", message: "unknown marketId" });
      }
      const key = subKey(channel, marketId);
      if (m.op === "unsubscribe") {
        c.subs.delete(key);
        return send(c, { type: "unsubscribed", channel, marketId });
      }
      c.subs.add(key);
      send(c, { type: "subscribed", channel, marketId });
      if (channel === "orderbook") send(c, bookSnapshot(marketId));
      else send(c, { type: "snapshot", channel: "trades", marketId, data: engine.getTrades(marketId, 50) });
    });
  });

  // Coalesce book changes: at most one snapshot per market per event-loop turn.
  const dirty = new Set<number>();
  let flushScheduled = false;
  const onBook = (marketId: number) => {
    dirty.add(marketId);
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      for (const id of dirty) {
        const key = subKey("orderbook", id);
        let snapshot: unknown;
        for (const c of clients) if (c.subs.has(key)) send(c, (snapshot ??= bookSnapshot(id)));
      }
      dirty.clear();
    });
  };
  const onTrade = (trade: Trade) => {
    const key = subKey("trades", trade.marketId);
    const msg = { type: "update", channel: "trades", marketId: trade.marketId, data: [trade] };
    for (const c of clients) if (c.subs.has(key)) send(c, msg);
  };
  engine.on("book", onBook);
  engine.on("trade", onTrade);

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.msgCount = 0;
      c.ws.ping();
    }
  }, 10_000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      engine.off("book", onBook);
      engine.off("trade", onTrade);
      server.off("upgrade", onUpgrade);
      for (const c of clients) c.ws.terminate();
      wss.close();
    },
  };
}
