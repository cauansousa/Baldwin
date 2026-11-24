import { BPS, ORDER_TYPES, CANCEL_TYPES } from "../../../shared/src/index.ts";
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

/** The engine's public REST API, as far as the unwinder uses it. */
export interface EngineClient {
  /** minOrderSize per market (GET /markets). */
  minOrderSizes(): Promise<EngineReply<Map<number, bigint>>>;
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
  /** The order is replaced when the index has moved this far from where it was priced. Default 20 bps. */
  repriceBps?: bigint;
  /** Lifetime of each order, seconds. Default 300. */
  expirySec?: number;
  /** The order is replaced when it has less than this left to live. Default 120. */
  renewBeforeSec?: number;
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
  /** On-chain position when it was signed. */
  position: bigint;
  /** "resting": the engine confirmed it. "unconfirmed": sent, no definite answer yet. */
  state: "resting" | "unconfirmed";
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

/**
 * Closes the positions the keeper took over in liquidations, by keeping ONE
 * reduce-only order per market resting in the engine like any trader would.
 *
 * Policy, per market and tick:
 *  - The keeper's on-chain position is read first. No position: any working order is
 *    cancelled. A position: the order closes it - a sell for a long, a buy for a short,
 *    `reduceOnly`, size = the whole position, priced `offsetBps` through the index
 *    (attractive, but well inside the price band), expiring after `expirySec`.
 *  - A working order is left alone while the position is unchanged, the index is within
 *    `repriceBps` of where the order was priced, and it has `renewBeforeSec` to live.
 *    Otherwise it is cancelled first and, only once the engine has confirmed the
 *    cancel, replaced. There is never more than one order per market, so the
 *    engine's reduce-only cap (orders may not exceed the position) and its self-trade
 *    rule can not be hit by the unwinder itself.
 *  - It can not increase exposure: every order is reduce-only (the contract refuses a
 *    reduce-only fill that would not reduce) and never larger than the position read
 *    just before signing.
 *  - Engine answers follow the `outcome` contract. `not_applied`: nothing happened, try
 *    again next tick with a fresh order. `unknown`, or no answer at all: the SAME signed
 *    order is sent again (the engine is idempotent by order hash) until there is a
 *    definite answer or it has expired.
 *  - `withdraw(marketId)` cancels the working order; the keeper calls it before it
 *    takes over another position in that market, because that changes the position
 *    the order was sized for (a reduce-only order that no longer reduces would fail
 *    on-chain and count against the keeper in the engine's suspension logic).
 *  - `shutdown()` cancels everything.
 * A position smaller than the market's minimum order size cannot be closed this way
 * (the contract rejects orders below the minimum); it is reported and left.
 */
export class Unwinder {
  private readonly working = new Map<number, Working>();
  private readonly notes = new Map<number, string | null>();
  private readonly positions = new Map<number, bigint | null>();
  private minSizes: Map<number, bigint> | null = null;
  private nonceCounter = 0n;
  private readonly offsetBps: bigint;
  private readonly repriceBps: bigint;
  private readonly expirySec: number;
  private readonly renewBeforeSec: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private stopped = false;

  constructor(private readonly opts: UnwinderOptions) {
    const band = opts.bandBps ?? 500n;
    const offset = opts.offsetBps ?? 10n;
    // Stay well inside the band, so that an index move between pricing and matching
    // does not push the order out of it.
    this.offsetBps = offset > band / 2n ? band / 2n : offset < 0n ? 0n : offset;
    this.repriceBps = opts.repriceBps ?? 20n;
    this.expirySec = opts.expirySec ?? 300;
    this.renewBeforeSec = opts.renewBeforeSec ?? 120;
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

  /** One pass over all markets. Never rejects. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    for (const marketId of this.opts.marketIds) {
      try {
        await this.tickMarket(marketId);
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

  /** Cancel every working order and stop placing new ones. Never rejects. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const [marketId, w] of [...this.working]) {
      const done = await this.cancel(marketId, w).catch(() => false);
      this.log.info(done ? "unwind: order cancelled on shutdown" : "unwind: could not cancel on shutdown; the order expires by itself", {
        marketId,
        orderHash: w.hash,
        expiry: w.order.expiry,
      });
    }
  }

  // ------------------------------------------------------------------ internals

  private note(marketId: number, text: string | null): void {
    this.notes.set(marketId, text);
  }

  private async tickMarket(marketId: number): Promise<void> {
    const position = await this.opts.chain.positionSize(marketId);
    this.positions.set(marketId, position);
    let w = this.working.get(marketId);
    const now = BigInt(this.now());

    // An order without a definite answer: ask again with the identical signed order.
    if (w && w.state === "unconfirmed") {
      if (w.order.expiry <= now) {
        this.working.delete(marketId); // it can no longer be accepted or filled
        w = undefined;
      } else {
        await this.send(marketId, w);
        w = this.working.get(marketId);
        if (w?.state === "unconfirmed") return; // still no answer: nothing else may be placed meanwhile
      }
    }

    if (position === 0n) {
      if (w && !(await this.cancel(marketId, w))) return;
      this.note(marketId, null);
      return;
    }

    let index: bigint;
    try {
      index = await this.opts.chain.indexPrice(marketId);
    } catch {
      // No price: the market is halted in the engine as well. Leave things as they are.
      this.note(marketId, "index price unavailable");
      return;
    }

    if (w) {
      const moved = abs(index - w.index) * BPS > w.index * this.repriceBps;
      const stale = w.order.expiry - now < BigInt(this.renewBeforeSec);
      if (position === w.position && !moved && !stale) return; // still the right order
      if (!(await this.cancel(marketId, w))) return; // replace only after a confirmed cancel
    }

    const minSize = await this.minOrderSize(marketId);
    if (minSize === null) {
      this.note(marketId, "engine unreachable");
      return;
    }
    const size = abs(position);
    if (size < minSize) {
      this.note(marketId, `position ${size} is below the minimum order size ${minSize}; it cannot be closed with an order`);
      return;
    }
    await this.place(marketId, position, index);
  }

  private async place(marketId: number, position: bigint, index: bigint): Promise<void> {
    const isBuy = position < 0n; // buy back a short, sell a long
    const now = BigInt(this.now());
    const limitPrice = isBuy ? index + (index * this.offsetBps) / BPS : index - (index * this.offsetBps) / BPS;
    const order: Order = {
      trader: this.opts.account.address,
      marketId,
      isBuy,
      reduceOnly: true,
      size: abs(position),
      limitPrice,
      // millisecond timestamp in the high bits, as the exchange expects of nonces
      nonce: ((now * 1000n) << 64n) | (this.nonceCounter++ & 0xffff_ffffn),
      expiry: now + BigInt(this.expirySec),
    };
    const signature = await this.opts.account.signTypedData({
      domain: eip712Domain(this.opts.domain),
      types: ORDER_TYPES,
      primaryType: "Order",
      message: order,
    } as never);
    const w: Working = { order, hash: hashOrder(this.opts.domain, order), signature, index, position, state: "unconfirmed" };
    this.working.set(marketId, w);
    await this.send(marketId, w);
  }

  /** Submit (or re-submit) `w` and record what the engine said. */
  private async send(marketId: number, w: Working): Promise<void> {
    const reply = await this.opts.engine.submit(w.order, w.signature);
    if (!reply.ok) {
      if (reply.outcome === "unknown") {
        // Engine down, timeout, STATE_UNKNOWN: it may or may not have the order. Keep it
        // and send the very same order again next tick.
        this.note(marketId, `no definite answer from the engine (${reply.code}); will resubmit the same order`);
        return;
      }
      // Definitely not accepted (halted, paused, recovering, rate-limited, ...).
      this.working.delete(marketId);
      this.note(marketId, `engine refused the order: ${reply.code}`);
      this.log.info("unwind: order refused", { marketId, code: reply.code, message: reply.message });
      return;
    }
    const s = reply.body;
    if (s.status === "open" || s.status === "partially_filled" || s.status === "pending_settlement") {
      if (w.state !== "resting") {
        this.log.info("unwind: order working", { marketId, orderHash: w.hash, isBuy: w.order.isBuy, size: w.order.size, limitPrice: w.order.limitPrice, status: s.status });
      }
      w.state = "resting";
      this.note(marketId, null);
      return;
    }
    // filled, or closed by the engine at once (band, self-trade, expired): nothing is working.
    this.working.delete(marketId);
    this.note(marketId, s.status === "filled" ? null : `order ended ${s.status}${s.reason ? `: ${s.reason}` : ""}`);
    this.log.info("unwind: order ended", { marketId, orderHash: w.hash, status: s.status, reason: s.reason ?? null });
  }

  /** True once the engine has confirmed that the order is cancelled (or can never be accepted). */
  private async cancel(marketId: number, w: Working): Promise<boolean> {
    const signature = await this.opts.account.signTypedData({
      domain: eip712Domain(this.opts.domain),
      types: CANCEL_TYPES,
      primaryType: "Cancel",
      message: { trader: w.order.trader, nonce: w.order.nonce },
    } as never);
    const reply = await this.opts.engine.cancel(w.hash, signature, w.order.trader, w.order.nonce);
    if (!reply.ok) {
      // Past its expiry nothing can happen to it any more, whatever the engine says.
      if (w.order.expiry <= BigInt(this.now())) {
        this.working.delete(marketId);
        return true;
      }
      this.note(marketId, `cancel not confirmed (${reply.code})`);
      return false;
    }
    this.working.delete(marketId);
    return true;
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
  return {
    minOrderSizes: () =>
      call("/markets", { method: "GET" }, (j) => new Map((j as { marketId: number; minOrderSize: string }[]).map((m) => [m.marketId, BigInt(m.minOrderSize)]))),
    submit: (order, signature) =>
      call("/orders", { method: "POST", ...post({ order, signature }) }, (j) => {
        const o = j as { orderHash: Hex; status: string; remaining: string; pending: string; filled: string; reason?: string };
        return { orderHash: o.orderHash, status: o.status, remaining: BigInt(o.remaining), pending: BigInt(o.pending), filled: BigInt(o.filled), ...(o.reason ? { reason: o.reason } : {}) };
      }),
    cancel: (orderHash, signature, trader, nonce) => call(`/orders/${orderHash}`, { method: "DELETE", ...post({ signature, trader, nonce }) }, (j) => j),
  };
}
