// Randomised end-to-end invariants (ported from the independent review's fuzz run).
import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { EngineError } from "../src/engine/engine.ts";
import type { Match } from "../src/types.ts";
import { alice, bob, carol, harness, makeOrder, signCancel, signOrder } from "./helpers.ts";

const ERR = parseAbi(["error InsufficientMargin(address trader)", "error OnlyReducingAllowed()"]);
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

describe("fuzz", () => {
  it("book, records and settlement stay consistent under random orders, cancels, expiries and on-chain failures", async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const h = harness({ maxBatchSize: 3, expiryBufferSec: 0, faultThreshold: 1_000_000 });
      const accts = [alice, bob, carol];
      const hashes: { hash: `0x${string}`; acct: typeof alice; nonce: bigint }[] = [];
      h.settler.failWhen = (m) => {
        const x = r();
        if (x < 0.12) return encodeErrorResult({ abi: ERR, errorName: "InsufficientMargin", args: [m.maker.trader] });
        if (x < 0.24) return encodeErrorResult({ abi: ERR, errorName: "InsufficientMargin", args: [m.taker.trader] });
        if (x < 0.32) return "0xdeadbeef";
        if (x < 0.4) return encodeErrorResult({ abi: ERR, errorName: "OnlyReducingAllowed" });
        return null;
      };
      h.settler.beforeSettle = async () => {
        if (r() < 0.1) throw new Error("rpc flake");
        await new Promise((res) => setImmediate(res));
      };
      for (let step = 0; step < 60; step++) {
        const x = r();
        try {
          if (x < 0.75) {
            const a = accts[Math.floor(r() * 3)]!;
            const o = makeOrder(a, r() < 0.5, 95 + Math.floor(r() * 10), (1 + Math.floor(r() * 5)) / 10, r() < 0.2 ? { expiry: BigInt(h.clock.now + 1 + Math.floor(r() * 5)) } : {});
            const flags = r() < 0.15 ? { postOnly: true } : r() < 0.3 ? { ioc: true } : {};
            const res = await h.engine.submit({ order: o, signature: await signOrder(a, o), ...flags });
            hashes.push({ hash: res.orderHash, acct: a, nonce: o.nonce });
          } else if (x < 0.9 && hashes.length) {
            const t = hashes[Math.floor(r() * hashes.length)]!;
            await h.engine.cancel(t.hash, await signCancel(t.acct, t.acct.address, t.nonce));
          } else {
            h.clock.now += 1;
            h.engine.sweepExpired();
          }
        } catch (e) {
          if (!(e instanceof EngineError)) throw e;
        }
        if (r() < 0.3) await new Promise((res) => setImmediate(res));
      }
      await h.engine.idle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eng = h.engine as any;
      const book = eng.books.get(1);
      const bb = book.bestBid();
      const ba = book.bestAsk();
      const live = (o: { expiry: bigint }) => o.expiry === 0n || o.expiry > BigInt(h.clock.now);
      if (bb && ba && live(bb) && live(ba) && bb.price >= ba.price) problems.push(`seed ${seed}: crossed book`);
      for (const rec of eng.orders.values()) {
        const inBook = book.get(rec.hash)?.remaining ?? 0n;
        const settled = h.settler.filled.get(rec.hash) ?? 0n;
        const bad: string[] = [];
        if (inBook !== rec.remaining) bad.push(`book ${inBook} != rec.remaining ${rec.remaining}`);
        if (rec.pending !== 0n) bad.push(`pending ${rec.pending} after idle`);
        if (rec.filled !== settled) bad.push(`filled ${rec.filled} != settled ${settled}`);
        if (rec.remaining + rec.filled > rec.order.size) bad.push("over size");
        if (rec.remaining < 0n || rec.pending < 0n) bad.push("negative");
        if (rec.userCancelled && rec.remaining > 0n) bad.push("cancelled order still resting");
        if (rec.closed && rec.remaining > 0n) bad.push("closed order still resting");
        if (rec.ioc && rec.remaining > 0n) bad.push("IOC order resting");
        if (rec.postOnly && h.settler.settled.some((m: Match) => m.takerHash === rec.hash)) bad.push("post-only settled as taker");
        if (bad.length) problems.push(`seed ${seed} ${rec.hash.slice(0, 10)}: ${bad.join("; ")}`);
      }
      for (const m of h.settler.settled) if (m.maker.trader === m.taker.trader) problems.push(`seed ${seed}: self-trade settled`);
      if (eng.queue.length || eng.current) problems.push(`seed ${seed}: queue not drained`);
    }
    expect(problems).toEqual([]);
  }, 60_000);
});
