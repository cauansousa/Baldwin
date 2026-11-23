import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { exchangeAbi } from "../src/abi.ts";
import { hashOrder } from "../src/signing.ts";
import { BatchRevertedError, type Batch } from "../src/settlement/types.ts";
import { parseSettlementLogs, ViemSettler, type RpcLog, type RpcReceipt, type SettlerRpc } from "../src/settlement/viemSettler.ts";
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

/** Minimal chain: one account, a mempool, and receipts the test decides on. */
class FakeRpc implements SettlerRpc {
  minedNonce = 7;
  /** What "pending" reports; tests may make it lag. */
  pendingNonce: number | null = null;
  sent: Hex[] = [];
  receipts = new Map<Hex, RpcReceipt>();
  fees = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
  gasEstimate = 200_000n;
  estimateError: Error | null = null;
  /** Called on every broadcast; may throw, and may mine by returning a receipt. */
  onSend: (raw: Hex, hash: Hex, count: number) => RpcReceipt | null = () => null;

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
  mine(hash: Hex, receipt: RpcReceipt) {
    this.receipts.set(hash, receipt);
    this.minedNonce++;
  }
  nonces() {
    return this.sent.map((raw) => parseTransaction(raw).nonce);
  }
}

function setup(opts: { maxRounds?: number; logger?: Logger } = {}) {
  const rpc = new FakeRpc();
  const settler = new ViemSettler({
    rpc,
    account: operator,
    chainId: DOMAIN.chainId,
    exchange: EXCHANGE,
    receiptTimeoutMs: 15,
    pollIntervalMs: 1,
    maxRounds: opts.maxRounds ?? 2,
    logger: opts.logger,
  });
  return { rpc, settler };
}

const ok = (matches: Match[]): RpcReceipt => ({ status: "success", logs: matches.map((m) => fillLog(m)) });

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
    expect(tx).toMatchObject({ nonce: 7, chainId: DOMAIN.chainId, maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gas: 300_000n + 150_000n });
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

  it("when broadcasting keeps failing, a later retry of the same batch re-sends the identical transaction", async () => {
    const { rpc, settler } = setup({ maxRounds: 2 });
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
    const { rpc, settler } = setup({ maxRounds: 3 });
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

  it("rejects concurrent use", async () => {
    const { rpc, settler } = setup();
    const batch: Batch = { id: "b1", matches: [await makeMatch("m1")] };
    rpc.onSend = () => ok(batch.matches);
    const first = settler.settle(batch);
    await expect(settler.settle(batch)).rejects.toThrow(/concurrently/);
    await first;
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
