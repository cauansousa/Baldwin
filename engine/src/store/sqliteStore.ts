import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { jsonReplacer, type Address, type Hex, type Order } from "../types.ts";
import type { Commit, EngineStore, Snapshot, StoredMatch, StoredOrder, StoredTrade } from "./types.ts";

const SCHEMA = `
create table if not exists meta (k text primary key, v text not null) strict;
create table if not exists orders (
  hash text primary key,
  expiry integer not null,
  order_json text not null,
  signature text not null,
  post_only integer not null,
  ioc integer not null,
  seq text not null,
  created_at integer not null,
  remaining text not null,
  pending text not null,
  filled text not null,
  user_cancelled integer not null,
  strikes integer not null,
  closed_status text,
  closed_reason text
) strict;
create table if not exists matches (
  id text primary key,
  n integer not null,
  market_id integer not null,
  maker_hash text not null,
  taker_hash text not null,
  fill_size text not null,
  price text not null,
  batch_id text
) strict;
create table if not exists trades (n integer primary key autoincrement, market_id integer not null, json text not null) strict;
create table if not exists dead_nonces (trader text not null, nonce text not null, expiry integer not null, primary key (trader, nonce)) strict;
create table if not exists min_nonces (trader text primary key, nonce text not null) strict;
`;

const BIG_ORDER_FIELDS = new Set(["size", "limitPrice", "nonce", "expiry"]);
const BIG_TRADE_FIELDS = new Set(["price", "size"]);
const sqlInt = (x: bigint) => (x > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(x));

/**
 * Engine state in one SQLite file (Node's built-in `node:sqlite`, no native build).
 *
 * journal_mode=WAL with synchronous=FULL: every commit is fsync'd before it returns
 * and is atomic - after a crash (also in the middle of a write) the database is at
 * the last completed commit; a torn tail of the write-ahead log is discarded by SQLite.
 */
export class SqliteStore implements EngineStore {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  /**
   * @param exclusive hold the file exclusively for the life of this connection, so
   *   that a second engine process pointed at the same file fails at once instead of
   *   corrupting the first one's view. The engine process sets this.
   */
  constructor(path: string, opts: { exclusive?: boolean } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // A short busy timeout: the engine is the only writer, so waiting long is never right.
    this.db.exec("pragma busy_timeout = 250;");
    if (opts.exclusive) this.db.exec("pragma locking_mode = exclusive;");
    this.db.exec("pragma journal_mode = wal; pragma synchronous = full;");
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  private tx(fn: () => void): void {
    this.db.exec("begin immediate");
    try {
      fn();
      this.db.exec("commit");
    } catch (e) {
      try {
        this.db.exec("rollback");
      } catch {
        // already rolled back
      }
      throw e;
    }
  }

  // ------------------------------------------------------------- engine state

  load(): Snapshot {
    const orders = (this.stmt("select * from orders").all() as Record<string, unknown>[]).map((r): StoredOrder => {
      const order = JSON.parse(r.order_json as string, (k, v) => (BIG_ORDER_FIELDS.has(k) ? BigInt(v) : v)) as Order;
      return {
        hash: r.hash as Hex,
        order,
        signature: r.signature as Hex,
        postOnly: r.post_only === 1,
        ioc: r.ioc === 1,
        seq: BigInt(r.seq as string),
        createdAt: r.created_at as number,
        remaining: BigInt(r.remaining as string),
        pending: BigInt(r.pending as string),
        filled: BigInt(r.filled as string),
        userCancelled: r.user_cancelled === 1,
        strikes: r.strikes as number,
        ...(r.closed_status ? { closed: { status: r.closed_status as "cancelled", reason: (r.closed_reason as string) ?? "" } } : {}),
      };
    });
    const matches = (this.stmt("select * from matches order by n").all() as Record<string, unknown>[]).map(
      (r): StoredMatch => ({
        id: r.id as string,
        marketId: r.market_id as number,
        makerHash: r.maker_hash as Hex,
        takerHash: r.taker_hash as Hex,
        fillSize: BigInt(r.fill_size as string),
        price: BigInt(r.price as string),
        batchId: (r.batch_id as string | null) ?? null,
      }),
    );
    const trades = (this.stmt("select json from trades order by n").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json, (k, v) => (BIG_TRADE_FIELDS.has(k) ? BigInt(v) : v)) as StoredTrade,
    );
    const minValidNonces = (this.stmt("select trader, nonce from min_nonces").all() as { trader: string; nonce: string }[]).map((r) => ({
      trader: r.trader as Address,
      nonce: BigInt(r.nonce),
    }));
    const deadNonces = (this.stmt("select trader, nonce, expiry from dead_nonces").all() as { trader: string; nonce: string; expiry: number }[]).map((r) => ({
      trader: r.trader as Address,
      nonce: BigInt(r.nonce),
      expiry: BigInt(r.expiry),
    }));
    return { orders, matches, trades, minValidNonces, deadNonces };
  }

  commit(c: Commit): void {
    this.tx(() => {
      const upsert = this.stmt(
        `insert into orders (hash, expiry, order_json, signature, post_only, ioc, seq, created_at, remaining, pending, filled, user_cancelled, strikes, closed_status, closed_reason)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (hash) do update set remaining = excluded.remaining, pending = excluded.pending, filled = excluded.filled,
           user_cancelled = excluded.user_cancelled, strikes = excluded.strikes, closed_status = excluded.closed_status, closed_reason = excluded.closed_reason`,
      );
      for (const o of c.orders) {
        upsert.run(
          o.hash,
          sqlInt(o.order.expiry),
          JSON.stringify(o.order, jsonReplacer),
          o.signature,
          o.postOnly ? 1 : 0,
          o.ioc ? 1 : 0,
          o.seq.toString(),
          o.createdAt,
          o.remaining.toString(),
          o.pending.toString(),
          o.filled.toString(),
          o.userCancelled ? 1 : 0,
          o.strikes,
          o.closed?.status ?? null,
          o.closed?.reason ?? null,
        );
      }
      const addMatch = this.stmt("insert or replace into matches (id, n, market_id, maker_hash, taker_hash, fill_size, price, batch_id) values (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const m of c.addMatches) {
        addMatch.run(m.id, Number(m.id.replace(/\D/g, "")), m.marketId, m.makerHash, m.takerHash, m.fillSize.toString(), m.price.toString(), m.batchId);
      }
      if (c.batched) {
        const setBatch = this.stmt("update matches set batch_id = ? where id = ?");
        for (const id of c.batched.ids) setBatch.run(c.batched.batchId, id);
      }
      const delMatch = this.stmt("delete from matches where id = ?");
      for (const id of c.removeMatches) delMatch.run(id);
      const addTrade = this.stmt("insert into trades (market_id, json) values (?, ?)");
      for (const t of c.trades) addTrade.run(t.marketId, JSON.stringify(t, jsonReplacer));
      const setMin = this.stmt("insert into min_nonces (trader, nonce) values (?, ?) on conflict (trader) do update set nonce = excluded.nonce");
      for (const m of c.minValidNonces) setMin.run(m.trader.toLowerCase(), m.nonce.toString());
      const addDead = this.stmt(
        "insert into dead_nonces (trader, nonce, expiry) values (?, ?, ?) on conflict (trader, nonce) do update set expiry = max(expiry, excluded.expiry)",
      );
      for (const d of c.deadNonces) addDead.run(d.trader.toLowerCase(), d.nonce.toString(), sqlInt(d.expiry));
      const setMeta = this.stmt("insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v");
      for (const [k, v] of Object.entries(c.meta)) setMeta.run(k, v);
    });
  }

  pruneFinished(now: bigint, keepTrades: number): void {
    this.tx(() => {
      this.stmt(
        `delete from orders where expiry <= ? and pending = '0' and (remaining = '0' or closed_status is not null)
           and hash not in (select maker_hash from matches union select taker_hash from matches)`,
      ).run(sqlInt(now));
      this.stmt("delete from dead_nonces where expiry <= ?").run(sqlInt(now));
      this.stmt(
        `delete from trades where n in (
           select n from (select n, row_number() over (partition by market_id order by n desc) as r from trades) where r > ?)`,
      ).run(keepTrades);
    });
  }

  // ---------------------------------------------------------------- key/value

  getMeta(key: string): string | undefined {
    return (this.stmt("select v from meta where k = ?").get(key) as { v: string } | undefined)?.v;
  }

  setMeta(key: string, value: string): void {
    this.stmt("insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v").run(key, value);
  }

  /** Whether a dead nonce is on disk (for tests and inspection; the engine keeps its own set). */
  hasDeadNonce(trader: Address, nonce: bigint): boolean {
    return this.stmt("select 1 from dead_nonces where trader = ? and nonce = ?").get(trader.toLowerCase(), nonce.toString()) !== undefined;
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }
}
