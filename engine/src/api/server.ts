import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { EngineError, type Engine } from "../engine/engine.ts";
import { jsonReplacer } from "../types.ts";
import { RateLimiter } from "./rateLimit.ts";
import { parseAddress, parseCancelBody, parseIntParam, parseMarketId, parseOrderHash, parseSubmitBody, ValidationError } from "./validation.ts";
import { attachWebSocket } from "./ws.ts";

export interface ServerOptions {
  /** Allowed CORS origin; "*" allows any. Default "*". */
  corsOrigin?: string;
  /** Requests per minute per IP. Default 600. */
  rateLimitPerMinute?: number;
  /** Trust X-Forwarded-For (only behind a reverse proxy). Default false. */
  trustProxy?: boolean;
  /** WebSocket connections allowed in total (default 1000) and per IP (default 10). */
  wsMaxConnections?: number;
  wsMaxConnectionsPerIp?: number;
  /**
   * Extra fields for GET /health; a function is evaluated per request. A `warnings`
   * array in it is merged into the response's `warnings`.
   */
  info?: Record<string, unknown> | (() => Record<string, unknown>);
  logger?: boolean;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** REST + WebSocket API over an Engine. Call `app.listen` to serve; `app.close` shuts everything down. */
export async function buildServer(engine: Engine, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024, trustProxy: opts.trustProxy ?? false });
  const limiter = new RateLimiter(opts.rateLimitPerMinute ?? 600);

  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));

  const origin = opts.corsOrigin ?? "*";
  await app.register(cors, {
    origin: origin === "*" ? "*" : origin.split(",").map((s) => s.trim()),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!limiter.take(req.ip)) {
      reply.header("Retry-After", limiter.retryAfterSec(req.ip));
      return reply.code(429).send(errorBody("RATE_LIMITED", "too many requests"));
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof EngineError) return reply.code(err.httpStatus).send(errorBody(err.code, err.message));
    if (err instanceof ValidationError) return reply.code(400).send(errorBody("BAD_REQUEST", err.message));
    const e = err as { statusCode?: number; message?: string };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send(errorBody("BAD_REQUEST", e.message ?? "bad request"));
    }
    app.log.error(err);
    return reply.code(500).send(errorBody("INTERNAL", "internal error"));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody("NOT_FOUND", "no such route")));

  app.get("/health", async () => {
    const settlement = engine.settlementStatus();
    const { warnings: extra, ...info } = (typeof opts.info === "function" ? opts.info() : (opts.info ?? {})) as { warnings?: string[] };
    const warnings = [...(extra ?? [])];
    if (settlement.stalled) warnings.push(`settlement is stalled: ${settlement.lastError ?? "unknown error"}`);
    const chain = engine.chainStatus();
    if (chain?.paused) warnings.push("exchange is paused");
    for (const m of chain?.markets ?? []) if (m.indexPrice === null) warnings.push(`no index price for market ${m.marketId}: market halted`);
    return { ok: !settlement.stalled, ...info, warnings, settlement, chain };
  });

  // Prometheus text exposition format.
  app.get("/metrics", async (_req, reply) => {
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").serializer((x: unknown) => String(x)).send(engine.metrics.render());
  });

  app.get("/markets", async () => engine.getMarkets());

  app.get<{ Params: { marketId: string }; Querystring: { depth?: string } }>("/orderbook/:marketId", async (req) => {
    const marketId = parseMarketId(req.params.marketId);
    const depth = parseIntParam(req.query.depth, "depth", 50, 1, 500);
    return engine.getOrderBook(marketId, depth);
  });

  app.get<{ Params: { marketId: string }; Querystring: { limit?: string } }>("/trades/:marketId", async (req) => {
    const marketId = parseMarketId(req.params.marketId);
    const limit = parseIntParam(req.query.limit, "limit", 50, 1, 200);
    return engine.getTrades(marketId, limit);
  });

  app.get<{ Querystring: { trader?: string } }>("/orders", async (req) => {
    if (req.query.trader === undefined) throw new ValidationError("query parameter trader is required");
    return engine.getOpenOrders(parseAddress(req.query.trader, "trader"));
  });

  app.post("/orders", async (req) => engine.submit(parseSubmitBody(req.body)));

  app.delete<{ Params: { orderHash: string } }>("/orders/:orderHash", async (req) => {
    const orderHash = parseOrderHash(req.params.orderHash);
    const { signature } = parseCancelBody(req.body);
    return engine.cancel(orderHash, signature);
  });

  const ws = attachWebSocket(app.server, engine, {
    limiter,
    trustProxy: opts.trustProxy ?? false,
    maxConnections: opts.wsMaxConnections ?? 1000,
    maxConnectionsPerIp: opts.wsMaxConnectionsPerIp ?? 10,
  });
  app.addHook("onClose", async () => {
    ws.close();
    limiter.close();
  });

  return app;
}
