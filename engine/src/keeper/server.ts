import { createServer, type Server } from "node:http";
import type { Metrics } from "../metrics.ts";
import { jsonReplacer } from "../types.ts";

/**
 * Tiny observability endpoint for the keeper: `GET /health` (JSON) and `GET /metrics`
 * (Prometheus text). No dependencies, read-only, meant for a private interface.
 */
export function keeperServer(opts: { health: () => { ok: boolean } & Record<string, unknown>; metrics: Metrics }): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" }).end('{"error":{"code":"METHOD_NOT_ALLOWED"}}');
      return;
    }
    try {
      if (path === "/health") {
        const body = opts.health();
        res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(body, jsonReplacer));
      } else if (path === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(opts.metrics.render());
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"code":"NOT_FOUND"}}');
      }
    } catch {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"code":"INTERNAL"}}');
    }
  });
}
