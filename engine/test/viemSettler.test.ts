import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { exchangeAbi } from "../src/abi.ts";
import { hashOrder } from "../src/signing.ts";
import { BatchRevertedError, type Batch } from "../src/settlement/types.ts";
import { parseSettlementLogs, ViemSettler, type RpcLog, type RpcReceipt, type SettlerRpc } from "../src/settlement/viemSettler.ts";
import type { KeyValueStore } from "../src/store/types.ts";
import type { Address, Hex, Logger, Match } from "../src/types.ts";
import { alice, bob, carol, DOMAIN, makeOrder, MARKET, signOrder, wad } from "./helpers.ts";

const EXCHANGE = DOMAIN.verifyingContract;
const operator = carol;

async function makeMatch(id: string, size = 1): Promise<Match> {
  const maker = makeOrder(alice, false, 100, size);
  const taker = makeOrder(bob, true, 101, size);
  return {
    id,
    marketId: MARKET.marketId,
    maker,
    makerSig: await signOrder(alice, maker),
    makerHash: hashOrder(DOMAIN, maker),
    taker,
    takerSig: await signOrder(bob, taker),
    takerHash: hashOrder(DOMAIN, taker),
    fillSize: wad(size),
    price: maker.limitPrice,
  };
}

function fillLog(m: Match, address: Address = EXCHANGE): RpcLog {
  return {
    address,
    topics: encodeEventTopics({ abi: exchangeAbi, eventName: "Fill", args: { marketId: m.marketId, maker: m.maker.trader, taker: m.taker.trader } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [m.makerHash, m.takerHash, m.taker.isBuy, m.fillSize, m.price, 1n, 2n],
    ),
  };
}

function failLog(index: number, m: Match, reason: Hex): RpcLog {
  return {
    address: EXCHANGE,
    topics: encodeEventTopics({ abi: exchangeAbi, eventName: "MatchFailed", args: { index: BigInt(index) } }) as Hex[],
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }], [m.makerHash, m.takerHash, reason]),
  };
}

/** A receipt as tests write it; FakeRpc.mine assigns the block. */
type TestReceipt = Pick<RpcReceipt, "status" | "logs">;

/** Minimal chain: one account, a mempool, and receipts the test decides on. */
class FakeRpc implements SettlerRpc {
  minedNonce = 7;
  /** What "pending" reports; tests may make it lag. */
  pendingNonce: number | null = null;
  sent: Hex[] = [];
  receipts = new Map<Hex, RpcReceipt>();
  head = 100n;
  async blockNumber() {
    return this.head;
  }
  fees = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
  gasEstimate = 200_000n;
  estimateError: Error | null = null;
  /** Called on every broadcast; may throw, and may mine by returning a receipt. */
  onSend: (raw: Hex, hash: Hex, count: number) => TestReceipt | null = () => null;

  async getNonce(_a: Address, tag: "pending" | "latest") {
    return tag === "latest" ? this.minedNonce : (this.pendingNonce ?? this.minedNonce);
  }
  async estimateGas() {
    if (this.estimateError) throw this.estimateError;
    return this.gasEstimate;
  }
  async estimateFees() {
    return this.fees;
  }
  calls: bigint[] = [];
  callError: Error | null = null;
  async call(tx: { gas: bigint }) {
    this.calls.push(tx.gas);
    if (this.callError) throw this.callError;
  }
  async sendRawTransaction(raw: Hex) {
    this.sent.push(raw);
    const { keccak256 } = await import("viem");
    const hash = keccak256(raw);
    const receipt = this.onSend(raw, hash, this.sent.length);
    if (receipt) this.mine(hash, receipt);
  }
  async getReceipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  /** On-chain filledSize per order hash. */
  filled = new Map<Hex, bigint>();
  async filledSize(hash: Hex) {
    return this.filled.get(hash) ?? 0n;
  }
  mine(hash: Hex, receipt: TestReceipt) {
    this.head++;
    this.receipts.set(hash, this.inBlock(receipt));
    this.minedNonce++;
  }
  inBlock(receipt: TestReceipt, block = this.head): RpcReceipt {
    return { ...receipt, blockNumber: block, blockHash: `0x${block.toString(16).padStart(64, "0")}` };
  }
  nonces() {
    return this.sent.map((raw) => parseTransaction(raw).nonce);
  }
}

interface SetupOptions {
  maxRounds?: number;
  logger?: Logger;
  bumpAfterRounds?: number;
  maxFeePerGasCap?: bigint;
  confirmations?: number;
  store?: KeyValueStore;
  rpc?: FakeRpc;
}

/** In-memory KeyValueStore standing for the engine's durable store. */
class MemoryKv implements KeyValueStore {
  data = new Map<string, string>();
  writes = 0;
  getMeta(k: string) {
    return this.data.get(k);
  }
  setMeta(k: string, v: string) {
    this.writes++;
    this.data.set(k, v);
  }
}

function setup(opts: SetupOptions = {}) {
  const rpc = opts.rpc ?? new FakeRpc();
  const settler = new ViemSettler({
    rpc,
    account: operator,
    chainId: DOMAIN.chainId,
    exchange: EXCHANGE,
    receiptTimeoutMs: 15,
    pollIntervalMs: 1,
    maxRounds: opts.maxRounds ?? 2,
    logger: opts.logger,
    bumpAfterRounds: opts.bumpAfterRounds,
    maxFeePerGasCap: opts.maxFeePerGasCap,
    releasePolls: 3,
    confirmations: opts.confirmations,
    confirmationTimeoutMs: 200,
    store: opts.store,
  });
  return { rpc, settler };
}

const ok = (matches: Match[]): TestReceipt => ({ status: "success", logs: matches.map((m) => fillLog(m)) });

describe("ViemSettler", () => {
  it("sends settleMatches with the batch, and maps Fill / MatchFailed logs to per-match results", async () => {
    const { rpc, settler } = setup();
    const matches = [await makeMatch("m1"), await makeMatch("m2", 2), await makeMatch("m3")];
    rpc.onSend = () => ({ status: "success", logs: [fillLog(matches[0]!), failLog(1, matches[1]!, "0x1234"), fillLog(matches[2]!)] });
    const results = await settler.settle({ id: "b1", matches });
    expect(results.map((r) => r.status)).toEqual(["settled", "failed", "settled"]);
    expect(results[1]).toMatchObject({ reason: "0x1234" });

    expect(rpc.sent).toHaveLength(1);
    const tx = parseTransaction(rpc.sent[0]!);
    expect(tx).toMatchObject({ nonce: 7, chainId: DOMAIN.chainId, maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gas: 300_000n + 700_000n });
    expect(tx.to!.toLowerCase()).toBe(EXCHANGE.toLowerCase());
    const call = decodeFunctionData({ abi: exchangeAbi, data: tx.data! });
    expect(call.functionName).toBe("settleMatches");
    const sentMatches = call.args[0] as readonly { maker: unknown; makerSig: Hex; taker: unknown; takerSig: Hex; fillSize: bigint }[];
    expect(sentMatches).toHaveLength(3);
    expect(sentMatches[1]).toMatchObject({ maker: matches[1]!.maker, taker: matches[1]!.taker, makerSig: matches[1]!.makerSig, takerSig: matches[1]!.takerSig, fillSize: wad(2) });
  });

  it("uses consecutive nonces for consecutive batches even if the node's pending count lags", async () => {
    const { rpc, settler } = setup();
    const a = [await makeMatch("m1")];
    const b = [await makeMatch("m2")];
    rpc.onSend = (_raw, _hash, n) => ok(n === 1 ? a : b);
    await settler.settle({ id: "b1", matches: a });
    rpc.pendingNonce = 7; // stale answer
    await settler.settle({ id: "b2", matches: b });
    expect(rpc.nonces()).toEqual([7, 8]);
  });

  it("a broadcast error does not mean failure: the receipt decides, and nothing is re-signed", async () => {
    const { rpc, settler } = setup();
    const matches = [await makeMatch("m1")];
    rpc.onSend = (_raw, hash) => {
      rpc.mine(hash, ok(matches)); // the node got it ...
      throw new Error("socket hang up"); // ... but the response was lost
    };
    const results = await settler.settle({ id: "b1", matches });
    expect(results.map((r) => r.status)).toEqual(["settled"]);
    expect(rpc.sent).toHaveLength(1);
  });

  it("when broadcasting keeps failing, the batch stays bound to its nonce across retries and settles once", async () => {
    const { rpc, settler } = setup({ maxRounds: 2, bumpAfterRounds: 100 });
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    let down = true;
    rpc.onSend = () => {
      if (down) throw new Error("ECONNREFUSED");
      return ok(batch.matches);
    };
    await expect(settler.settle(batch)).rejects.toThrow(/not mined after 2 rounds: ECONNREFUSED/);
    await expect(settler.settle(batch)).rejects.not.toBeInstanceOf(BatchRevertedError);
    down = false;
    expect((await settler.settle(batch)).map((r) => r.status)).toEqual(["settled"]);
    expect(new Set(rpc.sent).size).toBe(1); // one signed transaction, re-broadcast
    expect(new Set(rpc.nonces())).toEqual(new Set([7]));
  });

  it("an accepted but unmined transaction is replaced with higher fees under the same nonce; whichever is mined counts once", async () => {
    const { rpc, settler } = setup({ maxRounds: 3, bumpAfterRounds: 1 });
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    const hashes: Hex[] = [];
    rpc.onSend = (_raw, hash, n) => {
      hashes.push(hash);
      // the third broadcast triggers mining of the FIRST transaction (the replacements lose)
      if (n === 3) rpc.mine(hashes[0]!, ok(batch.matches));
      return null;
    };
    const results = await settler.settle(batch);
    expect(results).toEqual([{ status: "settled", txHash: hashes[0] }]);
    const txs = rpc.sent.map((raw) => parseTransaction(raw));
    expect(txs.map((t) => t.nonce)).toEqual([7, 7, 7]);
    expect(txs.map((t) => t.maxFeePerGas)).toEqual([100n, 126n, 158n]);
    expect(txs.map((t) => t.maxPriorityFeePerGas)).toEqual([10n, 13n, 17n]);
    expect(new Set(txs.map((t) => t.data)).size).toBe(1);
    // and the result is remembered: asking again does not send anything
    expect(await settler.settle(batch)).toEqual(results);
    expect(rpc.sent).toHaveLength(3);
  });

  it("refuses to submit another batch while one is unresolved", async () => {
    const { settler } = setup({ maxRounds: 1 });
    const b1: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    const b2: Batch = { id: "b2", matches: [await makeMatch("m2")] };
    await expect(settler.settle(b1)).rejects.toThrow(/not mined/);
    await expect(settler.settle(b2)).rejects.toThrow(/still unresolved/);
  });

  it("a reverted transaction is reported as BatchRevertedError and the retry takes the next nonce", async () => {
    const { rpc, settler } = setup();
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    rpc.onSend = (_raw, _hash, n) => (n === 1 ? { status: "reverted", logs: [] } : ok(batch.matches));
    await expect(settler.settle(batch)).rejects.toBeInstanceOf(BatchRevertedError);
    expect((await settler.settle(batch)).map((r) => r.status)).toEqual(["settled"]);
    expect(rpc.nonces()).toEqual([7, 8]);
  });

  it("does not send anything when gas estimation says the call reverts", async () => {
    const { rpc, settler } = setup();
    rpc.estimateError = new BatchRevertedError("settleMatches would revert: NotOperator");
    await expect(settler.settle({ id: "b1", matches: [await makeMatch("m1")] })).rejects.toBeInstanceOf(BatchRevertedError);
    expect(rpc.sent).toEqual([]);
  });

  it("when the node cannot estimate gas (not a revert), a computed limit is used after an eth_call check", async () => {
    const { rpc, settler } = setup();
    const matches = [await makeMatch("m1"), await makeMatch("m2")];
    rpc.estimateError = new Error("transaction gas limit (30311717) is greater than the cap (16777216)");
    rpc.onSend = () => ok(matches);
    expect((await settler.settle({ id: "b1", matches })).map((r) => r.status)).toEqual(["settled", "settled"]);
    const gas = 200_000n + 2n * (700_000n + 500_000n);
    expect(rpc.calls).toEqual([gas]);
    expect(parseTransaction(rpc.sent[0]!).gas).toBe(gas);
    // ... and if that check says the batch reverts, nothing is sent
    const other = setup();
    other.rpc.estimateError = new Error("cannot estimate");
    other.rpc.callError = new BatchRevertedError("settleMatches would revert: NotOperator");
    await expect(other.settler.settle({ id: "b1", matches })).rejects.toBeInstanceOf(BatchRevertedError);
    expect(other.rpc.sent).toEqual([]);
  });

  it("if a foreign transaction consumed the nonce, the batch is released as definitively unsettled", async () => {
    const { rpc, settler } = setup({ maxRounds: 3 });
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    rpc.onSend = (_raw, _hash, n) => {
      if (n === 1) {
        rpc.minedNonce = 8; // someone else used nonce 7
        throw new Error("nonce too low");
      }
      return ok(batch.matches);
    };
    await expect(settler.settle(batch)).rejects.toBeInstanceOf(BatchRevertedError);
    expect((await settler.settle(batch)).map((r) => r.status)).toEqual(["settled"]);
    expect(rpc.nonces()).toEqual([7, 8]);
  });

  it("S1: a transaction whose broadcast call errored client-side is still fee-bumped under the same nonce", async () => {
    const { rpc, settler } = setup({ maxRounds: 3, bumpAfterRounds: 2 });
    const matches = [await makeMatch("m1")];
    rpc.onSend = (_r, _h, n) => {
      // 1st: the HTTP call times out although the node accepted the tx; afterwards: "already known".
      throw new Error(n === 1 ? "request timed out" : "already known");
    };
    for (let i = 0; i < 3; i++) await settler.settle({ id: "b1", matches }).catch(() => {});
    const txs = rpc.sent.map((raw) => parseTransaction(raw));
    expect(new Set(rpc.sent).size).toBeGreaterThan(2); // replaced several times
    expect(new Set(txs.map((t) => t.nonce))).toEqual(new Set([7])); // always the same nonce
    expect(txs.at(-1)!.maxFeePerGas!).toBeGreaterThan(txs[0]!.maxFeePerGas!);
    expect(txs.at(-1)!.maxPriorityFeePerGas!).toBeGreaterThan(txs[0]!.maxPriorityFeePerGas!);
    // and once any of them is mined the batch resolves
    rpc.onSend = (_r, hash) => ok(matches);
    expect((await settler.settle({ id: "b1", matches })).map((r) => r.status)).toEqual(["settled"]);
  });

  it("never signs above the fee cap", async () => {
    const { rpc, settler } = setup({ maxRounds: 4, bumpAfterRounds: 1, maxFeePerGasCap: 130n });
    const matches = [await makeMatch("m1")];
    for (let i = 0; i < 2; i++) await settler.settle({ id: "b1", matches }).catch(() => {});
    const fees = rpc.sent.map((raw) => parseTransaction(raw).maxFeePerGas);
    expect(rpc.sent.length).toBe(8);
    expect(new Set(fees)).toEqual(new Set([100n, 126n])); // 158 would exceed the cap: keep re-broadcasting 126
    // a first attempt is clamped as well
    const capped = setup({ maxFeePerGasCap: 60n });
    capped.rpc.onSend = () => ok(matches);
    await capped.settler.settle({ id: "b1", matches });
    expect(parseTransaction(capped.rpc.sent[0]!)).toMatchObject({ maxFeePerGas: 60n, maxPriorityFeePerGas: 10n });
  });

  it("S2: nonce gone and receipt not served, but the orders were filled on-chain => the batch is NOT released", async () => {
    const { rpc, settler } = setup({ maxRounds: 1 });
    const matches = [await makeMatch("m1")];
    let hidden: { hash: Hex; receipt: RpcReceipt } | null = null as { hash: Hex; receipt: RpcReceipt } | null;
    rpc.onSend = (_raw, hash, n) => {
      if (n === 1) {
        // Mined: the nonce advances and filledSize moves, but this backend does not serve the receipt yet.
        rpc.minedNonce++;
        rpc.filled.set(matches[0]!.makerHash, matches[0]!.fillSize);
        rpc.filled.set(matches[0]!.takerHash, matches[0]!.fillSize);
        hidden = { hash, receipt: rpc.inBlock(ok(matches)) };
        return null;
      }
      throw new Error("nonce too low");
    };
    const first = await settler.settle({ id: "b1", matches }).catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(BatchRevertedError);
    expect(first.message).toMatch(/appears mined/);
    // still unresolved a round later
    expect(await settler.settle({ id: "b1", matches }).catch((e) => e)).not.toBeInstanceOf(BatchRevertedError);
    rpc.receipts.set(hidden!.hash, hidden!.receipt); // the receipt becomes visible
    const done = await settler.settle({ id: "b1", matches });
    expect(done).toEqual([{ status: "settled", txHash: hidden!.hash }]);
    expect(new Set(rpc.nonces())).toEqual(new Set([7])); // nothing was ever signed for another nonce
  });

  it("a receipt that shows up during the extra polls is used instead of releasing the batch", async () => {
    const { rpc, settler } = setup({ maxRounds: 1 });
    const matches = [await makeMatch("m1")];
    rpc.onSend = (_raw, hash) => {
      rpc.minedNonce++;
      setTimeout(() => rpc.receipts.set(hash, rpc.inBlock(ok(matches))), 16); // just after the normal wait ends
      return null;
    };
    expect((await settler.settle({ id: "b1", matches })).map((r) => r.status)).toEqual(["settled"]);
  });

  it("rejects concurrent use", async () => {
    const { rpc, settler } = setup();
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    rpc.onSend = () => ok(batch.matches);
    const first = settler.settle(batch);
    await expect(settler.settle(batch)).rejects.toThrow(/concurrently/);
    await first;
  });
});

describe("ViemSettler: confirmations", () => {
  it("reports the outcome only once the transaction is N blocks deep", async () => {
    const { rpc, settler } = setup({ confirmations: 3 });
    const matches = [await makeMatch("m1")];
    rpc.onSend = () => ok(matches); // mined in block 101
    let done = false;
    const p = settler.settle({ id: "b1", matches }).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // 1 confirmation
    rpc.head = 102n;
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // 2 confirmations
    rpc.head = 103n;
    expect((await p).map((r) => r.status)).toEqual(["settled"]);
    expect(rpc.sent).toHaveLength(1);
  });

  it("a transaction reorged out before it is confirmed is looked for again and its final receipt is used", async () => {
    const { rpc, settler } = setup({ confirmations: 2, maxRounds: 3 });
    const good = await makeMatch("m1");
    const matches = [good];
    let txHash!: Hex;
    rpc.onSend = (_raw, hash, n) => {
      txHash = hash;
      // first inclusion: the match settles; that block is then reorged away
      return n === 1 ? ok(matches) : null;
    };
    const p = settler.settle({ id: "b1", matches });
    await new Promise((r) => setTimeout(r, 10));
    rpc.receipts.delete(txHash); // reorg: the transaction is back in the mempool
    rpc.minedNonce--;
    rpc.head = 102n;
    await new Promise((r) => setTimeout(r, 30));
    // re-mined in the new chain, where the match fails
    rpc.head = 105n;
    rpc.minedNonce++;
    rpc.receipts.set(txHash, rpc.inBlock({ status: "success", logs: [failLog(0, good, "0x1234")] }, 104n));
    const res = await p;
    expect(res).toEqual([{ status: "failed", txHash, reason: "0x1234" }]);
    expect(new Set(rpc.nonces())).toEqual(new Set([7]));
  });
});

describe("ViemSettler: restart", () => {
  it("crash between broadcast and receipt: the new process finds the transaction it already sent and signs nothing", async () => {
    const store = new MemoryKv();
    const first = setup({ store, maxRounds: 1 });
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    let sentHash!: Hex;
    first.rpc.onSend = (_raw, hash) => {
      sentHash = hash;
      return null; // in the mempool, not mined yet
    };
    await expect(first.settler.settle(batch)).rejects.toThrow(/not mined/); // ... and the process dies here
    expect(store.data.get("settler.inflight")).toContain(sentHash);

    // it is mined while the engine is down
    first.rpc.mine(sentHash, ok(batch.matches));
    const second = setup({ store, rpc: first.rpc });
    first.rpc.onSend = () => {
      throw new Error("nonce too low");
    };
    const res = await second.settler.settle(batch);
    expect(res).toEqual([{ status: "settled", txHash: sentHash }]);
    expect(new Set(first.rpc.sent).size).toBe(1); // only ever one signed transaction
  });

  it("crash after signing but before the broadcast got out: the identical transaction is sent, under the same nonce", async () => {
    const store = new MemoryKv();
    const first = setup({ store, maxRounds: 1 });
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    first.rpc.onSend = () => {
      throw new Error("ECONNRESET"); // never reached the node
    };
    await expect(first.settler.settle(batch)).rejects.toThrow();
    const lostRaw = first.rpc.sent[0]!;

    const rpc2 = new FakeRpc(); // a chain that has never seen the transaction
    rpc2.pendingNonce = 7;
    const second = setup({ store, rpc: rpc2 });
    rpc2.onSend = () => ok(batch.matches);
    expect((await second.settler.settle(batch)).map((r) => r.status)).toEqual(["settled"]);
    expect(rpc2.sent).toEqual([lostRaw]);
  });

  it("the record is written before every broadcast", async () => {
    const store = new MemoryKv();
    const { rpc, settler } = setup({ store });
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    rpc.onSend = (_raw, hash) => {
      expect(store.data.get("settler.inflight")).toContain(hash); // already durable when the node sees it
      return ok(batch.matches);
    };
    await settler.settle(batch);
    expect(rpc.sent).toHaveLength(1);
  });

  it("crash after the outcome was known but before the caller recorded it: same results from the same receipt, nothing re-sent", async () => {
    const store = new MemoryKv();
    const first = setup({ store });
    const m1 = await makeMatch("m1");
    const m2 = await makeMatch("m2");
    const batch: Batch = { id: "b1", matches: [m1, m2] };
    first.rpc.onSend = () => ({ status: "success", logs: [fillLog(m1), failLog(1, m2, "0xbeef")] });
    const before = await first.settler.settle(batch);

    const second = setup({ store, rpc: first.rpc });
    first.rpc.onSend = () => {
      throw new Error("must not broadcast");
    };
    expect(await second.settler.settle(batch)).toEqual(before);
    expect(first.rpc.sent).toHaveLength(1);
    // the next batch then gets the next nonce
    const next: Batch = { id: "b2", matches: [await makeMatch("m3")] };
    first.rpc.onSend = () => ok(next.matches);
    first.rpc.pendingNonce = 7; // stale node
    await second.settler.settle(next);
    expect(first.rpc.nonces()).toEqual([7, 8]);
  });

  it("refuses to continue if the recorded batch is not the one it is asked to settle", async () => {
    const store = new MemoryKv();
    const first = setup({ store, maxRounds: 1 });
    await first.settler.settle({ id: "b1", matches: [await makeMatch("m1")] }).catch(() => {});
    const second = setup({ store, rpc: first.rpc });
    await expect(second.settler.settle({ id: "b1", matches: [await makeMatch("other")] })).rejects.toThrow(/does not match/);
  });
});

describe("parseSettlementLogs", () => {
  it("ignores logs of other contracts and unknown events", async () => {
    const m = await makeMatch("m1");
    const errors: string[] = [];
    const logger: Logger = { info() {}, warn() {}, error: (msg) => errors.push(msg) };
    const foreign = fillLog(await makeMatch("x"), bob.address);
    const unknown: RpcLog = { address: EXCHANGE, topics: [`0x${"11".repeat(32)}`], data: "0x" };
    const res = parseSettlementLogs([m], [foreign, unknown, fillLog(m)], EXCHANGE, "0xabc", logger);
    expect(res).toEqual([{ status: "settled", txHash: "0xabc" }]);
    expect(errors).toEqual([]);
  });

  it("flags a receipt whose Fill events do not match the batch, without throwing", async () => {
    const m = await makeMatch("m1");
    const errors: string[] = [];
    const logger: Logger = { info() {}, warn() {}, error: (msg) => errors.push(msg) };
    const res = parseSettlementLogs([m], [], EXCHANGE, "0xabc", logger);
    expect(res.map((r) => r.status)).toEqual(["settled"]);
    expect(errors).toHaveLength(1);
  });
});
