import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildServer, type ServerOptions } from "../src/api/server.ts";
import { jsonReplacer, type Order } from "../src/types.ts";
import { alice, bob, harness, makeOrder, signCancel, signOrder, wad, type Harness, type TestAccount } from "./helpers.ts";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(opts: ServerOptions = {}, h: Harness = harness()) {
  app = await buildServer(h.engine, opts);
  return { app, h };
}

const wire = (order: Order) => JSON.parse(JSON.stringify(order, jsonReplacer));

async function post(a: FastifyInstance, account: TestAccount, isBuy: boolean, price: number, size: number, extra: Record<string, unknown> = {}) {
  const order = makeOrder(account, isBuy, price, size);
  const res = await a.inject({ method: "POST", url: "/orders", payload: { order: wire(order), signature: await signOrder(account, order), ...extra } });
  return { res, order, body: res.json() };
}

describe("REST API", () => {
  it("POST /orders accepts a signed order; bigints travel as decimal strings", async () => {
    const { app } = await server();
    const { res, body } = await post(app, alice, false, 100, 2);
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ status: "open", fills: [], remaining: wad(2).toString() });
    expect(body.orderHash).toMatch(/^0x[0-9a-f]{64}$/);

    const taker = await post(app, bob, true, 100, 1);
    expect(taker.body).toMatchObject({
      status: "pending_settlement",
      fills: [{ makerOrderHash: body.orderHash, takerOrderHash: taker.body.orderHash, price: wad(100).toString(), size: wad(1).toString(), status: "pending" }],
    });
  });

  it("GET /orderbook, /trades, /orders, /markets, /health", async () => {
    const { app, h } = await server({ info: { chainId: 31337 } });
    const maker = await post(app, alice, false, 100, 2);
    await post(app, alice, false, 101, 1);
    await post(app, bob, true, 99, 3);
    await post(app, bob, true, 100, 1);
    await h.engine.idle();

    const book = (await app.inject({ url: "/orderbook/1" })).json();
    expect(book).toEqual({
      marketId: 1,
      bids: [{ price: wad(99).toString(), size: wad(3).toString() }],
      asks: [{ price: wad(100).toString(), size: wad(1).toString() }, { price: wad(101).toString(), size: wad(1).toString() }],
    });
    expect((await app.inject({ url: "/orderbook/1?depth=1" })).json().asks).toHaveLength(1);

    const trades = (await app.inject({ url: "/trades/1" })).json();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ marketId: 1, price: wad(100).toString(), size: wad(1).toString(), takerIsBuy: true, maker: alice.address, taker: bob.address });
    expect(trades[0].txHash).toMatch(/^0x/);

    const open = (await app.inject({ url: `/orders?trader=${alice.address.toLowerCase()}` })).json();
    expect(open).toHaveLength(2);
    const first = open.find((o: { orderHash: string }) => o.orderHash === maker.body.orderHash);
    expect(first).toMatchObject({ status: "partially_filled", remaining: wad(1).toString(), filled: wad(1).toString(), pending: "0" });
    expect(first.order).toEqual(wire(maker.order));

    const markets = (await app.inject({ url: "/markets" })).json();
    expect(markets).toEqual([
      expect.objectContaining({ marketId: 1, symbol: "BTC-USD", active: true, minOrderSize: wad("0.01").toString(), lastPrice: wad(100).toString(), bestBid: wad(99).toString(), bestAsk: wad(100).toString() }),
    ]);

    const health = (await app.inject({ url: "/health" })).json();
    expect(health).toMatchObject({ ok: true, chainId: 31337, settlement: { queued: 0, stalled: false, settled: 1, failed: 0 } });
  });

  it("DELETE /orders/:hash cancels with a signed Cancel", async () => {
    const { app } = await server();
    const { body, order } = await post(app, alice, false, 100, 2);
    const url = `/orders/${body.orderHash}`;
    const wrong = await app.inject({ method: "DELETE", url, payload: { signature: await signCancel(bob, alice.address, order.nonce) } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("BAD_SIGNATURE");
    const res = await app.inject({ method: "DELETE", url, payload: { signature: await signCancel(alice, alice.address, order.nonce) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderHash: body.orderHash, status: "cancelled", remaining: "0" });
    expect((await app.inject({ url: "/orderbook/1" })).json().asks).toEqual([]);
    expect((await app.inject({ url: `/orders?trader=${alice.address}` })).json()).toEqual([]);

    const unknown = await app.inject({ method: "DELETE", url: `/orders/0x${"ab".repeat(32)}`, payload: { signature: await signCancel(alice, alice.address, 1n) } });
    expect(unknown.statusCode).toBe(404);
  });

  it("answers malformed input with 400 and a clear message", async () => {
    const { app } = await server();
    const order = makeOrder(alice, true, 100, 1);
    const signature = await signOrder(alice, order);
    const bad = async (payload: unknown) => {
      const res = await app.inject({ method: "POST", url: "/orders", payload: payload as object });
      expect(res.statusCode).toBe(400);
      return res.json().error.message as string;
    };
    expect(await bad({})).toMatch(/order must be an object/);
    expect(await bad({ order: wire(order) })).toMatch(/signature/);
    expect(await bad({ order: { ...wire(order), size: "1.5" }, signature })).toMatch(/order\.size/);
    expect(await bad({ order: { ...wire(order), size: "-1" }, signature })).toMatch(/order\.size/);
    expect(await bad({ order: { ...wire(order), size: "0x10" }, signature })).toMatch(/order\.size/);
    expect(await bad({ order: { ...wire(order), size: 1e30 }, signature })).toMatch(/order\.size/);
    expect(await bad({ order: { ...wire(order), limitPrice: (2n ** 256n).toString() }, signature })).toMatch(/out of range/);
    expect(await bad({ order: { ...wire(order), expiry: (2n ** 64n).toString() }, signature })).toMatch(/order\.expiry/);
    expect(await bad({ order: { ...wire(order), trader: "0x1234" }, signature })).toMatch(/order\.trader/);
    expect(await bad({ order: { ...wire(order), isBuy: "true" }, signature })).toMatch(/order\.isBuy/);
    expect(await bad({ order: { ...wire(order), marketId: 2 ** 32 }, signature })).toMatch(/order\.marketId/);
    expect(await bad({ order: { ...wire(order), extra: 1 }, signature })).toMatch(/unknown field/);
    expect(await bad({ order: wire(order), signature: "0x1234" })).toMatch(/signature/);
    expect(await bad({ order: wire(order), signature, ioc: "yes" })).toMatch(/ioc/);
    expect(await bad({ order: wire(order), signature, ioc: true, postOnly: true })).toMatch(/mutually exclusive/);

    const notJson = await app.inject({ method: "POST", url: "/orders", payload: "{oops", headers: { "content-type": "application/json" } });
    expect(notJson.statusCode).toBe(400);
    expect((await app.inject({ url: "/orders" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/orders?trader=nope" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/orderbook/abc" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/orderbook/1?depth=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/orderbook/77" })).json().error.code).toBe("UNKNOWN_MARKET");
    expect((await app.inject({ url: "/trades/1?limit=x" })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/orders/123", payload: { signature } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/nope" })).statusCode).toBe(404);
  });

  it("maps engine rejections to 4xx codes", async () => {
    const { app } = await server();
    const order = makeOrder(alice, true, 100, 1);
    const payload = { order: wire(order), signature: await signOrder(bob, order) };
    const forged = await app.inject({ method: "POST", url: "/orders", payload });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toEqual({ error: { code: "BAD_SIGNATURE", message: expect.any(String) } });

    const good = { order: wire(order), signature: await signOrder(alice, order) };
    expect((await app.inject({ method: "POST", url: "/orders", payload: good })).statusCode).toBe(200);
    const dup = await app.inject({ method: "POST", url: "/orders", payload: good });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("DUPLICATE_ORDER");

    const crossing = await post(app, bob, false, 100, 1, { postOnly: true });
    expect(crossing.res.statusCode).toBe(422);
    expect(crossing.body.error.code).toBe("POST_ONLY_WOULD_CROSS");
  });

  it("supports CORS, including the DELETE preflight", async () => {
    const { app } = await server({ corsOrigin: "http://localhost:5173" });
    const get = await app.inject({ url: "/markets", headers: { origin: "http://localhost:5173" } });
    expect(get.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/orders/0xabc",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "DELETE", "access-control-request-headers": "content-type" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("DELETE");
    const other = await app.inject({ url: "/markets", headers: { origin: "http://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate-limits per IP with 429 and Retry-After", async () => {
    const { app } = await server({ rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    const limited = await app.inject({ url: "/health" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await app.inject({ url: "/health", remoteAddress: "10.0.0.9" })).statusCode).toBe(200);
  });
});

describe("WebSocket API", () => {
  async function connect(a: FastifyInstance, path = "/ws") {
    await a.listen({ port: 0, host: "127.0.0.1" });
    const { port } = a.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const queue: unknown[] = [];
    const waiters: ((m: unknown) => void)[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    });
    const next = () =>
      new Promise<any>((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const t = setTimeout(() => reject(new Error("timed out waiting for a WS message")), 2000);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      });
    return { ws, next, port };
  }

  it("orderbook channel: snapshot on subscribe, then a fresh snapshot after each change", async () => {
    const { app } = await server();
    await post(app, alice, false, 100, 2);
    const { ws, next } = await connect(app);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ op: "subscribe", channel: "orderbook", marketId: 1 }));
    expect(await next()).toEqual({ type: "subscribed", channel: "orderbook", marketId: 1 });
    expect(await next()).toEqual({ type: "snapshot", channel: "orderbook", marketId: 1, data: { bids: [], asks: [{ price: wad(100).toString(), size: wad(2).toString() }] } });
    await post(app, bob, true, 99, 1);
    expect((await next()).data.bids).toEqual([{ price: wad(99).toString(), size: wad(1).toString() }]);
    ws.send(JSON.stringify({ op: "unsubscribe", channel: "orderbook", marketId: 1 }));
    expect(await next()).toMatchObject({ type: "unsubscribed" });
    await post(app, bob, true, 98, 1);
    ws.send(JSON.stringify({ op: "ping" }));
    expect(await next()).toEqual({ type: "pong" }); // no book message arrived in between
    ws.close();
  });

  it("trades channel: only on-chain confirmed fills are published", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.settler.beforeSettle = () => gate;
    const { app } = await server({}, h);
    const { ws, next } = await connect(app);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ op: "subscribe", channel: "trades", marketId: 1 }));
    expect(await next()).toMatchObject({ type: "subscribed", channel: "trades" });
    expect(await next()).toEqual({ type: "snapshot", channel: "trades", marketId: 1, data: [] });
    await post(app, alice, false, 100, 1);
    await post(app, bob, true, 100, 1); // matched, not yet settled
    ws.send(JSON.stringify({ op: "ping" }));
    expect(await next()).toEqual({ type: "pong" }); // nothing published yet
    release();
    const msg = await next();
    expect(msg).toMatchObject({ type: "update", channel: "trades", marketId: 1 });
    expect(msg.data).toEqual([expect.objectContaining({ price: wad(100).toString(), size: wad(1).toString(), takerIsBuy: true })]);
    ws.close();
  });

  it("reports protocol errors and refuses other paths", async () => {
    const { app } = await server();
    const { ws, next, port } = await connect(app);
    await new Promise((r) => ws.once("open", r));
    ws.send("not json");
    expect(await next()).toMatchObject({ type: "error" });
    ws.send(JSON.stringify({ op: "subscribe", channel: "positions", marketId: 1 }));
    expect((await next()).message).toMatch(/channel/);
    ws.send(JSON.stringify({ op: "subscribe", channel: "trades", marketId: 42 }));
    expect((await next()).message).toMatch(/marketId/);
    ws.send(JSON.stringify({ op: "hello" }));
    expect((await next()).message).toMatch(/op/);
    ws.close();
    const other = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const err = await new Promise<Error>((r) => other.once("error", r));
    expect(err.message).toMatch(/404/);
  });

  it("caps WebSocket connections per IP and in total", async () => {
    const { app } = await server({ wsMaxConnectionsPerIp: 3, wsMaxConnections: 1000 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const open = (): Promise<WebSocket | Error> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.once("open", () => resolve(ws));
        ws.once("error", (e) => resolve(e));
      });
    const first = await Promise.all([open(), open(), open(), open(), open()]); // a burst cannot overshoot either
    const ok = first.filter((x): x is WebSocket => x instanceof WebSocket);
    const refused = first.filter((x): x is Error => x instanceof Error);
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.message).toMatch(/429/);
    // a slot is freed when a connection closes
    ok[0]!.close();
    await new Promise((r) => ok[0]!.once("close", r));
    await new Promise((r) => setTimeout(r, 20));
    const again = await open();
    expect(again).toBeInstanceOf(WebSocket);
    for (const ws of [...ok, again as WebSocket]) ws.terminate();
  });

  it("caps WebSocket connections in total", async () => {
    const { app } = await server({ wsMaxConnectionsPerIp: 100, wsMaxConnections: 2 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const socks: WebSocket[] = [];
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
      socks.push(ws);
    }
    const third = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const err = await new Promise<Error>((r) => third.once("error", r));
    expect(err.message).toMatch(/503/);
    for (const ws of socks) ws.terminate();
  });
});

describe("malformed input", () => {
  it("never produces a 5xx", async () => {
    const { app } = await server({ rateLimitPerMinute: 100000 });
    const o = makeOrder(alice, true, 100, 1);
    const sig = await signOrder(alice, o);
    const j = (x: unknown) => JSON.stringify(x, jsonReplacer);
    const json = { "content-type": "application/json" };
    const cases: [string, string, string | undefined, Record<string, string>?][] = [
      ["POST", "/orders", "{", json],
      ["POST", "/orders", "null", json],
      ["POST", "/orders", "[]", json],
      ["POST", "/orders", '{"__proto__":{"a":1}}', json],
      ["POST", "/orders", '{"order":{"constructor":{"prototype":{}}},"signature":"0x"}', json],
      ["POST", "/orders", j({ order: { ...o, size: "9".repeat(78) }, signature: sig }), json],
      ["POST", "/orders", j({ order: { ...o, size: 1e30 }, signature: sig }), json],
      ["POST", "/orders", j({ order: { ...o, marketId: 1.5 }, signature: sig }), json],
      ["POST", "/orders", j({ order: { ...o, limitPrice: (2n ** 256n - 1n).toString(), size: (2n ** 256n - 1n).toString() }, signature: sig }), json],
      ["POST", "/orders", j({ order: { ...o, expiry: "0" }, signature: sig }), json],
      ["POST", "/orders", j({ order: o, signature: sig }), { "content-type": "text/plain" }],
      ["POST", "/orders", "x".repeat(20000), json],
      ["DELETE", "/orders/0x" + "ab".repeat(32), undefined],
      ["DELETE", "/orders/0x" + "ab".repeat(32), "", json],
      ["DELETE", "/orders/zz", "{}", json],
      ["GET", "/orders?trader=0x1&trader=0x2", undefined],
      ["GET", "/orderbook/1?depth=1&depth=2", undefined],
      ["GET", "/orderbook/99999999999", undefined],
      ["GET", "/trades/1?limit=0", undefined],
      ["GET", "/orderbook/%00", undefined],
    ];
    for (const [method, url, payload, headers] of cases) {
      const r = await app.inject({ method: method as "GET", url, payload, headers });
      expect(r.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
      expect(r.statusCode, `${method} ${url}`).toBeLessThan(500);
      expect(r.json().error, `${method} ${url}`).toBeDefined();
    }
  });
});
