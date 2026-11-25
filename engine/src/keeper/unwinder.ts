import { BPS, CANCEL_TYPES, ORDER_TYPES } from "../../../shared/src/index.ts";
import { eip712Domain, hashOrder, type Domain } from "../signing.ts";
import { errMessage, jsonReplacer, silentLogger, type Address, type Hex, type Logger, type Order } from "../types.ts";

/** What the unwinder needs from the chain. */
export interface UnwindChain {
  /** The keeper's own signed position (WAD). */
  positionSize(marketId: number): Promise<bigint>;
  /** Oracle price (WAD); rejects when unavailable. */
  indexPrice(marketId: number): Promise<bigint>;
}

/** Outcome of a request to the engine, following its error contract. */
export type EngineReply<T> =
  | { ok: true; body: T }
  /** `outcome: "unknown"` also stands for "no answer at all" (engine down, timeout). */
  | { ok: false; code: string; outcome: "not_applied" | "unknown"; message: string };

export interface EngineOrderState {
  orderHash: Hex;
  status: string;
  remaining: bigint;
  pending: bigint;
  filled: bigint;
  reason?: string;
}

/** An order as GET /orders?trader= lists it (resting or awaiting settlement). */
export interface EngineOpenOrder extends EngineOrderState {
  order: Order;
}

/** The engine's public REST API, as far as the unwinder uses it. */
export interface EngineClient {
  /** minOrderSize per market (GET /markets). */
  minOrderSizes(): Promise<EngineReply<Map<number, bigint>>>;
  /** The engine's "now" for order expiry, unix seconds (GET /health `time`). */
  time(): Promise<EngineReply<bigint>>;
  /** GET /orders?trader=: the trader's live orders. */
  openOrders(trader: Address): Promise<EngineReply<EngineOpenOrder[]>>;
  /** POST /orders. Idempotent: the identical signed order may be sent again. */
  submit(order: Order, signature: Hex): Promise<EngineReply<EngineOrderState>>;
  /** DELETE /orders/:hash with trader and nonce, so it also works for an order the engine never saw. */
  cancel(orderHash: Hex, signature: Hex, trader: Address, nonce: bigint): Promise<EngineReply<unknown>>;
}

export interface Signer {
  address: Address;
  signTypedData(args: never): Promise<Hex>;
}

export interface UnwinderOptions {
  chain: UnwindChain;
  engine: EngineClient;
  /** The keeper account. */
  account: Signer;
  domain: Domain;
  marketIds: number[];
  /**
   * How far from the index the order is priced, towards the side that gets it filled
   * (a sell below the index, a buy above). Default 10 bps. Must be inside the price band.
   */
  offsetBps?: bigint;
  /** Half-width of the contract's price band; the offset is kept below half of it. Default 500. */
  bandBps?: bigint;
  /**
   * The order is replaced when the index has moved this far from where it was priced.
   * Never more than `offsetBps`, so that a resting quote is at most twice the offset
   * through the index. Default 5 bps.
   */
  repriceBps?: bigint;
  /** Lifetime of each order, seconds. Default 300. */
  expirySec?: number;
  /** The order is replaced when it has less than this left to live. Default 120. */
  renewBeforeSec?: number;
  /** After an order ended on arrival without resting, wait this long before the next. Doubles up to 60 s. Default 5. */
  retryAfterSec?: number;
  /** Unix seconds. */
  now?: () => number;
  logger?: Logger;
}

interface Working {
  order: Order;
  hash: Hex;
  signature: Hex;
  /** Index price the order was priced from. */
  index: bigint;
  /** "resting": the engine confirmed it. "unconfirmed": sent, no definite answer yet. */
  state: "resting" | "unconfirmed";
  /** A submission ended without a definite answer: the engine may have it whatever it says later. */
  maybeLive: boolean;
}

export interface UnwindMarketStatus {
  marketId: number;
  position: bigint | null;
  /** The order currently working, if any. */
  order: { orderHash: Hex; isBuy: boolean; size: bigint; limitPrice: bigint; expiry: bigint; state: "resting" | "unconfirmed" } | null;
  /** Why nothing is working although there is a position (or the last refusal). */
  note: string | null;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
/** Answers that prove an order can never be (or no longer is) live. */
const TERMINAL = new Set(["NONCE_CANCELLED", "EXPIRED", "ALREADY_FILLED", "BAD_SIGNATURE", "INVALID_ORDER", "INVALID_EXPIRY", "BELOW_MIN_SIZE", "UNKNOWN_MARKET"]);
const LIVE = new Set(["open", "partially_filled", "pending_settlement"]);

/**
 * Closes the positions the keeper took over in liquidations, by keeping ONE
 * reduce-only order per market resting in the engine like any trader would.
 *
 * Each pass, per market:
 *  1. The engine's list of the keeper's live orders is the truth about what is working.
 *     An order of the keeper there that this process is not managing (left by an
 *     earlier process, or one whose submission the engine accepted although it
 *     answered otherwise) is cancelled. A managed order that is no longer listed has
 *     ended (filled, cancelled by the engine) and is forgotten.
 *  2. The keeper's on-chain position and the index are read. No position: nothing may
 *     work. No index (oracle outage): the working order is CANCELLED - a quote must
 *     not sit there to be hit at a stale price when the feed returns.
 *  3. A working order is left alone while it still fits: the position equals what the
 *     order has left to fill (so a partial fill changes nothing, and a remainder below
 *     the minimum order size stays, since the contract lets it be filled in one piece),
 *     the index is within `repriceBps` of where it was priced, and it has
 *     `renewBeforeSec` to live. Otherwise it is cancelled and, only once the engine has
 *     confirmed the cancel, replaced: a sell for a long, a buy for a short,
 *     `reduceOnly`, the whole position, `offsetBps` through the index, expiring
 *     `expirySec` after the ENGINE's notion of now.
 *  4. It can not increase exposure: every order is reduce-only (the contract refuses a
 *     reduce-only fill that would not reduce) and never larger than the position read
 *     just before signing. With one order per market it cannot hit the engine's
 *     reduce-only cap or self-trade rule by itself.
 *
 * Engine answers follow the `outcome` contract. After a submission without a definite
 * answer the order is treated as possibly live until the engine returns its state
 * (200), an answer that proves it dead, or a confirmed cancel by nonce; a
 * `not_applied` answer to a later attempt does not prove that the first attempt did
 * not get through. An order that ends on arrival without resting (exchange paused and
 * the best maker not reduce-only, band, self-trade) is not re-posted every pass: the
 * next attempt waits, with a growing delay.
 *
 * `withdraw(marketId)` cancels the working order; the keeper calls it before it takes
 * over another position there. `shutdown()` cancels everything first thing.
 */
export class Unwinder {
  private readonly working = new Map<number, Working>();
  private readonly notes = new Map<number, string | null>();
  private readonly positions = new Map<number, bigint | null>();
  private readonly retryAt = new Map<number, { at: number; delay: number }>();
  private minSizes: Map<number, bigint> | null = null;
  private nonceCounter = 0n;
  private readonly offsetBps: bigint;
  private readonly repriceBps: bigint;
  private readonly expirySec: number;
  private readonly renewBeforeSec: number;
  private readonly retryAfterSec: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private stopped = false;
  private busy: Promise<void> | null = null;
  private engineReachable = true;
  /** Engine time minus local time, seconds, as last observed. */
  private engineLead = 0n;

  constructor(private readonly opts: UnwinderOptions) {
    const band = opts.bandBps ?? 500n;
    const offset = opts.offsetBps ?? 10n;
    // Stay well inside the band, so that an index move between pricing and matching
    // does not push the order out of it.
    this.offsetBps = offset > band / 2n ? band / 2n : offset < 0n ? 0n : offset;
    const reprice = opts.repriceBps ?? 5n;
    this.repriceBps = reprice > this.offsetBps && this.offsetBps > 0n ? this.offsetBps : reprice < 1n ? 1n : reprice;
    this.expirySec = opts.expirySec ?? 300;
    this.renewBeforeSec = opts.renewBeforeSec ?? 120;
    this.retryAfterSec = opts.retryAfterSec ?? 5;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = opts.logger ?? silentLogger;
  }

  status(): UnwindMarketStatus[] {
    return this.opts.marketIds.map((marketId) => {
      const w = this.working.get(marketId);
      return {
        marketId,
        position: this.positions.get(marketId) ?? null,
        order: w ? { orderHash: w.hash, isBuy: w.order.isBuy, size: w.order.size, limitPrice: w.order.limitPrice, expiry: w.order.expiry, state: w.state } : null,
        note: this.notes.get(marketId) ?? null,
      };
    });
  }

  /** False while the engine did not answer the last pass. */
  isEngineReachable(): boolean {
    return this.engineReachable;
  }

  /** One pass over all markets. Never rejects; passes do not overlap. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.busy ??= this.pass().finally(() => (this.busy = null));
    return this.busy;
  }

  private async pass(): Promise<void> {
    // What the engine has for the keeper right now, and what time it thinks it is.
    const [listed, time] = await Promise.all([this.opts.engine.openOrders(this.opts.account.address), this.opts.engine.time()]);
    this.engineReachable = listed.ok;
    if (time.ok) this.engineLead = time.body - BigInt(this.now());
    for (const marketId of this.opts.marketIds) {
      if (this.stopped) return;
      try {
        await this.tickMarket(marketId, listed.ok ? listed.body.filter((o) => o.order.marketId === marketId) : null);
      } catch (e) {
        this.note(marketId, `error: ${errMessage(e)}`);
        this.log.warn("unwind: market pass failed", { marketId, error: errMessage(e) });
      }
    }
  }

  /** Cancel the working order of a market (before the keeper's position there changes). */
  async withdraw(marketId: number): Promise<void> {
    const w = this.working.get(marketId);
    if (!w) return;
    if (await this.cancel(marketId, w)) this.log.info("unwind: order withdrawn", { marketId, orderHash: w.hash });
    else throw new Error("the engine did not confirm the cancel");
  }

  /** Cancel every working order, at once, and stop placing new ones. Never rejects. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.working].map(async ([marketId, w]) => {
        const done = await this.cancel(marketId, w).catch(() => false);
        this.log.info(done ? "unwind: order cancelled on shutdown" : "unwind: could not cancel on shutdown; the order expires by itself", {
          marketId,
          orderHash: w.hash,
          expiry: w.order.expiry,
        });
      }),
    );
  }

  // ------------------------------------------------------------------ internals

  private note(marketId: number, text: string | null): void {
    this.notes.set(marketId, text);
  }

  /** The engine's "now" (its clock may run ahead of ours when chain time does). */
  private engineNow(): bigint {
    return BigInt(this.now()) + (this.engineLead > 0n ? this.engineLead : 0n);
  }

  private async tickMarket(marketId: number, listed: EngineOpenOrder[] | null): Promise<void> {
    let w = this.working.get(marketId);
    const now = this.engineNow();

    // 1a. Orders of the keeper in the engine that nobody here is managing must go.
    if (listed) {
      for (const o of listed) {
        if (w && o.orderHash.toLowerCase() === w.hash.toLowerCase()) continue;
        const done = await this.cancelOrder(o.order);
        this.log.warn(done ? "unwind: cancelled an order of the keeper that was not being managed" : "unwind: could not cancel an unmanaged order", {
          marketId,
          orderHash: o.orderHash,
        });
        if (!done) return; // nothing new while an unmanaged order may still be working
      }
    }
    const live = w && listed ? listed.find((o) => o.orderHash.toLowerCase() === w!.hash.toLowerCase()) : undefined;

    // 1b. An order without a definite answer: find out, with the identical signed order.
    if (w && w.state === "unconfirmed") {
      if (w.order.expiry <= now) {
        this.working.delete(marketId); // it can no longer be accepted or filled
        w = undefined;
      } else {
        await this.send(marketId, w);
        w = this.working.get(marketId);
        if (w?.state === "unconfirmed") return; // still unresolved: nothing else may be placed meanwhile
        if (w) return; // confirmed just now; it is judged on the next pass, against the engine's list
      }
    } else if (w && listed && !live) {
      // 1c. The engine no longer lists it: it was filled, or the engine closed it.
      this.log.info("unwind: order is no longer live in the engine", { marketId, orderHash: w.hash });
      this.working.delete(marketId);
      w = undefined;
    }

    const position = await this.opts.chain.positionSize(marketId);
    this.positions.set(marketId, position);
    if (position === 0n) {
      if (w && !(await this.cancel(marketId, w))) return;
      this.note(marketId, null);
      return;
    }

    let index: bigint;
    try {
      index = await this.opts.chain.indexPrice(marketId);
    } catch {
      // No price. A resting quote would be hit at a stale price the moment the feed is
      // back (the engine resumes matching before this process looks again): take it out.
      if (w && !(await this.cancel(marketId, w))) {
        this.note(marketId, "index price unavailable; cancel not confirmed");
        return;
      }
      this.note(marketId, "index price unavailable");
      return;
    }

    if (w) {
      const wrongSide = w.order.isBuy !== position < 0n;
      // What the order has left to fill, by the engine's count (resting + matched but
      // unsettled). If the engine's list is not available, by the order's size.
      const unfilled = live ? live.remaining + live.pending : w.order.size;
      const fits = !wrongSide && abs(position) === unfilled;
      const moved = abs(index - w.index) * BPS > w.index * this.repriceBps;
      const stale = w.order.expiry - now < BigInt(this.renewBeforeSec);
      if (fits && !moved && !stale) {
        this.note(marketId, null);
        return; // still the right order
      }
      // A fill that is matched but not settled: the position is about to change. Wait
      // for it rather than cancel and re-post around it.
      if (!wrongSide && live && live.pending > 0n && !moved && !stale) return;
      if (!(await this.cancel(marketId, w))) return; // replace only after a confirmed cancel
    }

    const retry = this.retryAt.get(marketId);
    if (retry && this.now() < retry.at) return;

    const minSize = await this.minOrderSize(marketId);
    if (minSize === null) {
      this.note(marketId, "engine unreachable");
      return;
    }
    const size = abs(position);
    if (size < minSize) {
      this.note(marketId, `position ${size} is below the minimum order size ${minSize}; it cannot be closed with a new order`);
      return;
    }
    await this.place(marketId, position, index);
  }

  private async place(marketId: number, position: bigint, index: bigint): Promise<void> {
    const isBuy = position < 0n; // buy back a short, sell a long
    const now = this.engineNow();
    const limitPrice = isBuy ? index + (index * this.offsetBps) / BPS : index - (index * this.offsetBps) / BPS;
    const order: Order = {
      trader: this.opts.account.address,
      marketId,
      isBuy,
      reduceOnly: true,
      size: abs(position),
      limitPrice,
      // millisecond timestamp in the high bits, as the exchange expects of nonces
      nonce: ((BigInt(this.now()) * 1000n) << 64n) | (this.nonceCounter++ & 0xffff_ffffn),
      expiry: now + BigInt(this.expirySec),
    };
    const signature = await this.opts.account.signTypedData({
      domain: eip712Domain(this.opts.domain),
      types: ORDER_TYPES,
      primaryType: "Order",
      message: order,
    } as never);
    const w: Working = { order, hash: hashOrder(this.opts.domain, order), signature, index, state: "unconfirmed", maybeLive: false };
    this.working.set(marketId, w);
    await this.send(marketId, w);
  }

  /** Submit (or re-submit) `w` and record what the engine said. */
  private async send(marketId: number, w: Working): Promise<void> {
    const reply = await this.opts.engine.submit(w.order, w.signature);
    if (!reply.ok) {
      if (reply.outcome === "unknown") {
        // Engine down, timeout, STATE_UNKNOWN: it may or may not have the order. Keep it
        // and send the very same order again next pass.
        w.maybeLive = true;
        this.note(marketId, `no definite answer from the engine (${reply.code}); will resubmit the same order`);
        return;
      }
      if (w.maybeLive && !TERMINAL.has(reply.code)) {
        // "Not applied" - to THIS attempt. An earlier one had no definite answer and may
        // have got through all the same (the engine might be unable to say so right
        // now). Only a confirmed cancel by nonce settles it; until then it stays ours.
        if (await this.cancel(marketId, w)) this.note(marketId, `engine refused the order (${reply.code}); earlier attempt cancelled by nonce`);
        else this.note(marketId, `engine refused the order (${reply.code}) but an earlier attempt may be live; still resolving`);
        return;
      }
      // Definitely not accepted, now or before (halted, paused, recovering, rate-limited, ...).
      this.working.delete(marketId);
      this.note(marketId, `engine refused the order: ${reply.code}`);
      this.log.info("unwind: order refused", { marketId, code: reply.code, message: reply.message });
      return;
    }
    const s = reply.body;
    if (LIVE.has(s.status)) {
      if (w.state !== "resting") {
        this.log.info("unwind: order working", { marketId, orderHash: w.hash, isBuy: w.order.isBuy, size: w.order.size, limitPrice: w.order.limitPrice, status: s.status });
      }
      w.state = "resting";
      w.maybeLive = false;
      this.retryAt.delete(marketId);
      this.note(marketId, null);
      return;
    }
    // filled, or closed by the engine at once (band, self-trade, pause): nothing is working.
    this.working.delete(marketId);
    if (s.status === "filled") {
      this.retryAt.delete(marketId);
      this.note(marketId, null);
    } else {
      // Do not post the same doomed order again every pass.
      const delay = Math.min(60, (this.retryAt.get(marketId)?.delay ?? this.retryAfterSec / 2) * 2);
      this.retryAt.set(marketId, { at: this.now() + delay, delay });
      this.note(marketId, `order ended ${s.status}${s.reason ? `: ${s.reason}` : ""}; next attempt in ${delay} s`);
    }
    this.log.info("unwind: order ended", { marketId, orderHash: w.hash, status: s.status, reason: s.reason ?? null });
  }

  /** True once the engine has confirmed that the working order is cancelled (or can never be accepted). */
  private async cancel(marketId: number, w: Working): Promise<boolean> {
    if (await this.cancelOrder(w.order)) {
      this.working.delete(marketId);
      return true;
    }
    // Past its expiry nothing can happen to it any more, whatever the engine says.
    if (w.order.expiry <= this.engineNow()) {
      this.working.delete(marketId);
      return true;
    }
    this.note(marketId, "cancel not confirmed");
    return false;
  }

  /** Cancel by nonce (works for orders the engine knows and for ones it never saw). */
  private async cancelOrder(order: Order): Promise<boolean> {
    const signature = await this.opts.account.signTypedData({
      domain: eip712Domain(this.opts.domain),
      types: CANCEL_TYPES,
      primaryType: "Cancel",
      message: { trader: order.trader, nonce: order.nonce },
    } as never);
    const reply = await this.opts.engine.cancel(hashOrder(this.opts.domain, order), signature, order.trader, order.nonce);
    return reply.ok;
  }

  private async minOrderSize(marketId: number): Promise<bigint | null> {
    if (!this.minSizes) {
      const reply = await this.opts.engine.minOrderSizes();
      if (!reply.ok) return null;
      this.minSizes = reply.body;
    }
    return this.minSizes.get(marketId) ?? null;
  }
}

/** EngineClient over HTTP (`fetch`), with a timeout per request. */
export function httpEngineClient(baseUrl: string, timeoutMs = 5000): EngineClient {
  const url = baseUrl.replace(/\/+$/, "");
  async function call<T>(path: string, init: RequestInit, parse: (json: unknown) => T): Promise<EngineReply<T>> {
    let res: Response;
    let json: unknown;
    try {
      res = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      json = await res.json();
    } catch (e) {
      // No (complete) answer: for a request that changes state this is "unknown".
      return { ok: false, code: "NO_ANSWER", outcome: "unknown", message: errMessage(e) };
    }
    if (res.ok) return { ok: true, body: parse(json) };
    const err = (json as { error?: { code?: string; message?: string; outcome?: string } }).error ?? {};
    // An error without the outcome field (a proxy in between, an old engine) is treated as unknown for 5xx.
    const outcome = err.outcome === "not_applied" || err.outcome === "unknown" ? err.outcome : res.status >= 500 ? "unknown" : "not_applied";
    return { ok: false, code: err.code ?? `HTTP_${res.status}`, outcome, message: err.message ?? "" };
  }
  const post = (body: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body, jsonReplacer) });
  type WireState = { orderHash: Hex; status: string; remaining: string; pending: string; filled: string; reason?: string };
  const state = (o: WireState): EngineOrderState => ({
    orderHash: o.orderHash,
    status: o.status,
    remaining: BigInt(o.remaining),
    pending: BigInt(o.pending),
    filled: BigInt(o.filled),
    ...(o.reason ? { reason: o.reason } : {}),
  });
  type WireOrder = Omit<Order, "size" | "limitPrice" | "nonce" | "expiry"> & { size: string; limitPrice: string; nonce: string; expiry: string };
  return {
    minOrderSizes: () =>
      call("/markets", { method: "GET" }, (j) => new Map((j as { marketId: number; minOrderSize: string }[]).map((m) => [m.marketId, BigInt(m.minOrderSize)]))),
    // /health answers 200 whatever it reports
    time: () => call("/health", { method: "GET" }, (j) => BigInt((j as { time: string }).time)),
    openOrders: (trader) =>
      call(`/orders?trader=${trader}`, { method: "GET" }, (j) =>
        (j as (WireState & { order: WireOrder })[]).map((o) => ({
          ...state(o),
          order: { ...o.order, size: BigInt(o.order.size), limitPrice: BigInt(o.order.limitPrice), nonce: BigInt(o.order.nonce), expiry: BigInt(o.order.expiry) },
        })),
      ),
    submit: (order, signature) => call("/orders", { method: "POST", ...post({ order, signature }) }, (j) => state(j as WireState)),
    cancel: (orderHash, signature, trader, nonce) => call(`/orders/${orderHash}`, { method: "DELETE", ...post({ signature, trader, nonce }) }, (j) => j),
  };
}
