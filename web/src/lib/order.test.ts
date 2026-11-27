import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { createEngineClock, ENGINE_TIME_MAX_AGE_MS } from "./clock";
import { describeError, EngineError, engineErrorMessage, parseEngineError, TxTimeoutError } from "./errors";
import { describeOrderReason, describeSubmitAnswer } from "./orderStatus";
import { createNonceStore } from "./nonceStore";
import { classifySubmitFailure, submitUntilKnown } from "./submit";
import {
  nextNonce,
  NonceRangeError,
  nonceUpperBound,
  planBulkCancel,
  cancelTypedData,
  DEFAULT_EXPIRY_SECONDS,
  defaultExpiry,
  generateNonce,
  MAX_EXPIRY_SECONDS,
  normalizeSignature,
  orderToJson,
  orderTypedData,
} from "./order";

const trader = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const exchange = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

describe("order helpers", () => {
  it("nonces embed the timestamp and are unique within one millisecond", () => {
    const now = 1_800_000_000_000;
    const nonces = new Set(Array.from({ length: 1000 }, () => generateNonce(now)));
    expect(nonces.size).toBe(1000);
    for (const n of nonces) expect(n >> 64n).toBe(BigInt(now));
    expect(generateNonce(now + 1, 0n)).toBeGreaterThan(generateNonce(now, 2n ** 64n - 1n));
    expect(generateNonce(now) < 2n ** 256n).toBe(true);
  });

  it("default expiry is 24h ahead, in seconds, non-zero and within the 7-day maximum", () => {
    expect(defaultExpiry(1_800_000_000_999)).toBe(1_800_000_000n + 86_400n);
    expect(DEFAULT_EXPIRY_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_EXPIRY_SECONDS).toBeLessThanOrEqual(MAX_EXPIRY_SECONDS);
  });

  it("normalizes signature v from 0/1 to 27/28 and leaves everything else alone", () => {
    const rs = "ab".repeat(64);
    expect(normalizeSignature(`0x${rs}00`)).toBe(`0x${rs}1b`);
    expect(normalizeSignature(`0x${rs}01`)).toBe(`0x${rs}1c`);
    expect(normalizeSignature(`0x${rs}1b`)).toBe(`0x${rs}1b`);
    expect(normalizeSignature(`0x${rs}1C`)).toBe(`0x${rs}1C`);
    expect(normalizeSignature("0x1234")).toBe("0x1234");
    expect(normalizeSignature(`0x${rs}${rs}00`)).toBe(`0x${rs}${rs}00`); // not 65 bytes
  });

  it("serializes bigints as decimal strings", () => {
    const order = {
      trader,
      marketId: 1,
      isBuy: true,
      reduceOnly: false,
      size: 10n ** 18n,
      limitPrice: 3_415n * 10n ** 18n,
      nonce: generateNonce(1_800_000_000_000, 7n),
      expiry: 1_800_086_400n,
    };
    const json = orderToJson(order);
    expect(json.size).toBe("1000000000000000000");
    expect(json.nonce).toBe(order.nonce.toString());
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    // The typed data is hashable (types and message agree with each other).
    expect(hashTypedData(orderTypedData(31337, exchange, order))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashTypedData(cancelTypedData(31337, exchange, trader, order.nonce))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(orderTypedData(31337, exchange, order).domain).toEqual({
      name: "Baldwin",
      version: "1",
      chainId: 31337,
      verifyingContract: exchange,
    });
  });
});

describe("nonce bounds and on-chain bulk cancel", () => {
  const now = 1_800_000_000_000; // device clock, ms
  const chainTime = 1_800_000_000n; // latest block, s (in sync with the device)
  const bound = nonceUpperBound(chainTime);
  const MAX_RANDOM = 2n ** 64n - 1n;

  it("the upper bound is ((chain time + 1 day) in ms) << 64", () => {
    expect(bound).toBe((1_800_000_000_000n + 86_400_000n) << 64n);
  });

  it("the plan is strictly above the current minimum and every nonce signed up to now", () => {
    const plan = planBulkCancel({ currentMinValidNonce: 0n, highestSignedNonce: 0n, upperBound: bound, nowMs: now });
    expect(plan).toEqual({ value: (BigInt(now) + 1n) << 64n, coversAllSigned: true });
    expect(plan.value).toBeGreaterThan(generateNonce(now, MAX_RANDOM));
    expect(plan.value).toBeLessThanOrEqual(bound);
  });

  it("device clock behind the on-chain minimum: still covers nonces this client signed above that minimum", () => {
    // An earlier bulk cancel (from a device with a later clock) left the minimum 1 h ahead of this device.
    const currentMin = (BigInt(now) + 3_600_000n) << 64n;
    // Orders signed here since then were bumped above the minimum by nextNonce.
    const signedA = nextNonce(currentMin, bound, now, 5n);
    const signedB = nextNonce(currentMin, bound, now + 10, MAX_RANDOM);
    expect(signedA).toBeGreaterThanOrEqual(currentMin);
    const highest = signedA > signedB ? signedA : signedB;
    const plan = planBulkCancel({ currentMinValidNonce: currentMin, highestSignedNonce: highest, upperBound: bound, nowMs: now + 20 });
    expect(plan.coversAllSigned).toBe(true);
    expect(plan.value).toBeGreaterThan(currentMin);
    expect(plan.value).toBeGreaterThan(signedA);
    expect(plan.value).toBeGreaterThan(signedB);
    // The old rule (currentMin + 1) would have left both orders alive.
    expect(currentMin + 1n).toBeLessThanOrEqual(signedA);
  });

  it("is capped at the contract bound and says so when that leaves signed nonces uncovered", () => {
    // Device clock two days ahead of the chain.
    const skewed = now + 2 * 86_400_000;
    const signed = generateNonce(skewed, 1n);
    const plan = planBulkCancel({ currentMinValidNonce: 0n, highestSignedNonce: signed, upperBound: bound, nowMs: skewed });
    expect(plan).toEqual({ value: bound, coversAllSigned: false });
    expect(plan.value).toBeLessThan(signed);
  });

  it("refuses when the minimum is already at the bound (cancelAllOrders would revert)", () => {
    for (const currentMin of [bound, bound + 1n]) {
      expect(() => planBulkCancel({ currentMinValidNonce: currentMin, highestSignedNonce: 0n, upperBound: bound, nowMs: now })).toThrow(
        NonceRangeError,
      );
    }
    // One below the bound still works, exactly at the bound.
    expect(planBulkCancel({ currentMinValidNonce: bound - 1n, highestSignedNonce: 0n, upperBound: bound, nowMs: now }).value).toBe(bound);
  });

  it("orders signed after a bulk cancel get nonces at or above the new minimum", () => {
    const min = planBulkCancel({ currentMinValidNonce: 0n, highestSignedNonce: 0n, upperBound: bound, nowMs: now }).value;
    // Same millisecond as the cancel, one later, and a device whose clock is far behind.
    for (const t of [now, now + 1, now - 3_600_000]) {
      for (const r of [0n, 12345n, MAX_RANDOM]) {
        const nonce = nextNonce(min, bound, t, r);
        expect(nonce).toBeGreaterThanOrEqual(min);
        expect(nonce >> 64n).toBeLessThanOrEqual(bound >> 64n);
      }
    }
    // Normally the nonce is just the time-based one.
    expect(nextNonce(0n, bound, now, 7n)).toBe(generateNonce(now, 7n));
    expect(nextNonce(min, bound, now + 5, 7n)).toBe(generateNonce(now + 5, 7n));
    // Still unique within a millisecond when bumped above the minimum.
    expect(nextNonce(min + 5n, bound, now, 1n)).not.toBe(nextNonce(min + 5n, bound, now, 2n));
    // A minimum with non-zero low bits is never undercut.
    expect(nextNonce(min + 5n, bound, now - 1000, 2n)).toBeGreaterThanOrEqual(min + 5n);
  });

  it("nextNonce throws a clear error instead of returning a nonce beyond the bound", () => {
    // Device clock more than a day ahead of the chain.
    expect(() => nextNonce(0n, bound, now + 2 * 86_400_000, 1n)).toThrow(/relógio/);
    // Minimum pushed beyond the bound's millisecond.
    expect(() => nextNonce(bound + (1n << 64n), bound, now, 1n)).toThrow(NonceRangeError);
    // Exactly at the bound is still usable.
    expect(nextNonce(bound, bound, now, 9n)).toBe(bound | 9n);
    expect(describeError(new NonceRangeError("mensagem clara"))).toBe("mensagem clara");
  });
});

describe("engine clock", () => {
  const device = 1_800_000_000_000;

  it("falls back to the device clock until synchronised", () => {
    const clock = createEngineClock();
    expect(clock.synced(device)).toBe(false);
    expect(clock.nowMs(device)).toBe(device);
  });

  it("dates from the engine's time once synchronised, ahead or behind the device", () => {
    const clock = createEngineClock();
    clock.sync(1_800_000_090, device); // engine 90 s ahead (e.g. chain time leading)
    expect(clock.synced(device)).toBe(true);
    expect(clock.nowMs(device)).toBe(device + 90_000);
    expect(clock.nowMs(device + 7_000)).toBe(device + 97_000);
    // An order dated from it expires 24 h after the ENGINE's now, and its nonce carries the engine's ms.
    expect(defaultExpiry(clock.nowMs(device))).toBe(1_800_000_090n + 86_400n);
    expect(generateNonce(clock.nowMs(device), 0n) >> 64n).toBe(BigInt(device) + 90_000n);
    clock.sync(1_799_999_970, device); // 30 s behind
    expect(clock.nowMs(device)).toBe(device - 30_000);
  });

  it("stops trusting a stale reading and ignores nonsense", () => {
    const clock = createEngineClock();
    clock.sync(1_800_000_090, device);
    expect(clock.nowMs(device + ENGINE_TIME_MAX_AGE_MS + 1)).toBe(device + ENGINE_TIME_MAX_AGE_MS + 1);
    clock.sync(Number.NaN, device);
    clock.sync(0, device);
    expect(clock.nowMs(device)).toBe(device + 90_000); // earlier good reading kept
  });
});

describe("nonce store", () => {
  const memoryStorage = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it("persists the highest signed nonce per account and deployment", () => {
    const storage = memoryStorage();
    const store = createNonceStore("421614:0xExchange", storage);
    expect(store.highestSigned(trader)).toBe(0n);
    store.recordSigned(trader, 10n);
    store.recordSigned(trader.toLowerCase(), 5n); // lower: ignored
    expect(store.highestSigned(trader)).toBe(10n);
    // A new session (new store, same storage) still knows it; other accounts and deployments do not.
    expect(createNonceStore("421614:0xExchange", storage).highestSigned(trader.toUpperCase().replace("0X", "0x"))).toBe(10n);
    expect(createNonceStore("421614:0xExchange", storage).highestSigned(exchange)).toBe(0n);
    expect(createNonceStore("31337:0xExchange", storage).highestSigned(trader)).toBe(0n);
  });

  it("works without storage, with broken storage and with garbage in it", () => {
    const none = createNonceStore("s", undefined);
    none.recordSigned(trader, 7n);
    expect(none.highestSigned(trader)).toBe(7n);
    const broken = createNonceStore("s", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    broken.recordSigned(trader, 8n);
    expect(broken.highestSigned(trader)).toBe(8n);
    const storage = memoryStorage();
    storage.data.set(`baldwin.maxnonce:s:${trader.toLowerCase()}`, "not-a-number");
    expect(createNonceStore("s", storage).highestSigned(trader)).toBe(0n);
  });

  it("remembers the highest floor per trader", () => {
    const store = createNonceStore("s", undefined);
    expect(store.floor(trader)).toBe(0n);
    store.recordFloor(trader, 10n);
    store.recordFloor(trader.toLowerCase(), 5n);
    expect(store.floor(trader)).toBe(10n);
  });
});

describe("submitting an order whose outcome may be unknown", () => {
  const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
  const noSleep = async () => {};

  it("classifies failures: the engine's `outcome` is trusted, unknown is the fallback", () => {
    // Bodies with outcome (every engine error has one).
    expect(classifySubmitFailure(new EngineError(422, "x", "INSUFFICIENT_MARGIN", "not_applied"))).toBe("not_accepted");
    for (const code of ["STORE_UNAVAILABLE", "CHAIN_UNAVAILABLE", "MARKET_HALTED", "EXCHANGE_PAUSED", "RECOVERING", "SHUTTING_DOWN"]) {
      expect(classifySubmitFailure(new EngineError(503, "x", code, "not_applied")), code).toBe("not_accepted");
    }
    expect(classifySubmitFailure(new EngineError(503, "x", "STATE_UNKNOWN", "unknown"))).toBe("unknown");
    expect(classifySubmitFailure(new EngineError(500, "x", "INTERNAL", "unknown"))).toBe("unknown");
    expect(classifySubmitFailure(new EngineError(400, "x", "WHATEVER", "unknown"))).toBe("unknown");
    // Bodies without it (proxy error page, older engine): 5xx is unknown whatever the code says.
    expect(classifySubmitFailure(new EngineError(503, "x", "SHUTTING_DOWN"))).toBe("unknown");
    expect(classifySubmitFailure(new EngineError(502, "x"))).toBe("unknown");
    expect(classifySubmitFailure(new EngineError(400, "x", "INVALID_ORDER"))).toBe("not_accepted");
    // Timeouts and network errors.
    expect(classifySubmitFailure(timeout())).toBe("unknown");
    expect(classifySubmitFailure(new TypeError("Failed to fetch"))).toBe("unknown");
    // The outcome is read from the error body.
    expect(parseEngineError(503, { error: { code: "STATE_UNKNOWN", message: "m", outcome: "unknown" } }, "").outcome).toBe("unknown");
    expect(parseEngineError(503, { error: { code: "RECOVERING", message: "m", outcome: "not_applied" } }, "").outcome).toBe("not_applied");
    expect(parseEngineError(503, { error: { code: "X", message: "m", outcome: "bogus" } }, "").outcome).toBeUndefined();
  });

  it("resubmits the identical request after a timeout and a state-unknown 503 until the engine answers", async () => {
    const answers: (() => string)[] = [
      () => {
        throw timeout();
      },
      () => {
        throw new EngineError(503, "x", "STATE_UNKNOWN", "unknown");
      },
      () => "open",
    ];
    const sent: number[] = [];
    const retries: number[] = [];
    const delays: number[] = [];
    const outcome = await submitUntilKnown(
      async () => {
        sent.push(sent.length);
        return answers[sent.length - 1]!();
      },
      { delays: [10, 20, 30], sleep: async (ms) => void delays.push(ms), onRetry: (n) => retries.push(n) },
    );
    expect(outcome).toEqual({ kind: "accepted", value: "open" });
    expect(sent).toHaveLength(3);
    expect(retries).toEqual([1, 2]);
    expect(delays).toEqual([10, 20]); // backoff
  });

  it("stops at once when the engine definitely refused", async () => {
    let calls = 0;
    const refused = new EngineError(503, "x", "SHUTTING_DOWN", "not_applied");
    const outcome = await submitUntilKnown(
      async () => {
        calls++;
        throw refused;
      },
      { sleep: noSleep },
    );
    expect(outcome).toEqual({ kind: "not_accepted", error: refused, resubmission: false });
    expect(calls).toBe(1);
  });

  it("a refusal on a resubmission is flagged: the order may have arrived and been closed meanwhile", async () => {
    let calls = 0;
    const closed = new EngineError(409, "x", "NONCE_CANCELLED", "not_applied");
    const outcome = await submitUntilKnown<string>(
      async () => {
        if (calls++ === 0) throw timeout();
        throw closed;
      },
      { sleep: noSleep },
    );
    expect(outcome).toEqual({ kind: "not_accepted", error: closed, resubmission: true });
  });

  it("gives up as unknown, never as refused, when every attempt is inconclusive", async () => {
    let calls = 0;
    const outcome = await submitUntilKnown(
      async () => {
        calls++;
        throw timeout();
      },
      { delays: [1, 1], sleep: noSleep },
    );
    expect(outcome.kind).toBe("unknown");
    expect(calls).toBe(3);
  });
});

describe("error messages", () => {
  it("maps every engine error code to Portuguese", () => {
    const body = (code: string, message = "english detail") => ({ error: { code, message } });
    expect(parseEngineError(422, body("PRICE_OUTSIDE_BAND"), "")).toEqual({
      code: "PRICE_OUTSIDE_BAND",
      message: "Preço fora da banda permitida em torno do preço índice.",
    });
    expect(engineErrorMessage(400, body("INVALID_EXPIRY"), "")).toMatch(/Validade inválida/);
    expect(engineErrorMessage(429, body("TRADER_SUSPENDED"), "")).toMatch(/suspensa/);
    expect(engineErrorMessage(429, body("RATE_LIMITED"), "")).toMatch(/Limite de requisições/);
    expect(engineErrorMessage(503, body("EXCHANGE_PAUSED"), "")).toMatch(/pausada/);
    expect(engineErrorMessage(503, body("MARKET_HALTED"), "")).toMatch(/Mercado suspenso/);
    expect(engineErrorMessage(503, body("CHAIN_UNAVAILABLE"), "")).toMatch(/blockchain/);
    expect(engineErrorMessage(503, body("SHUTTING_DOWN"), "")).toMatch(/não aceitou a ordem/);
    expect(engineErrorMessage(503, body("STATE_UNKNOWN"), "")).toMatch(/não se sabe se ela foi aceita/);
    expect(engineErrorMessage(503, body("STORE_UNAVAILABLE"), "")).toMatch(/falha para gravar/);
    expect(engineErrorMessage(503, body("RECOVERING"), "")).toMatch(/sincronizando/);
    expect(engineErrorMessage(422, body("REDUCE_ONLY_EXCEEDS_POSITION"), "")).toMatch(/maior que a posição/);
    expect(engineErrorMessage(422, body("INSUFFICIENT_MARGIN"), "")).toBe("Margem insuficiente para esta ordem.");
    for (const code of [
      "UNKNOWN_MARKET", "MARKET_INACTIVE", "BELOW_MIN_SIZE", "EXPIRED", "DUPLICATE_ORDER", "NONCE_CANCELLED", "NONCE_REUSED",
      "BAD_SIGNATURE", "ALREADY_FILLED", "REDUCE_ONLY_NO_POSITION", "POST_ONLY_WOULD_CROSS", "NOT_FOUND", "INTERNAL",
    ]) {
      const message = engineErrorMessage(400, body(code), "");
      expect(message, code).not.toContain("english detail");
      expect(message.length, code).toBeGreaterThan(10);
    }
    // Validation errors keep the server's specifics; unknown codes fall back to the server text.
    expect(engineErrorMessage(400, body("BAD_REQUEST", "order.size must be..."), "")).toBe("Requisição inválida. (order.size must be...)");
    expect(parseEngineError(418, body("NEW_CODE", "something new"), "")).toEqual({ code: "NEW_CODE", message: "something new" });
  });

  it("translates the reasons the engine gives for closing an order", () => {
    expect(describeOrderReason("price outside the oracle price band")).toMatch(/fora da banda/);
    expect(describeOrderReason("IOC remainder cancelled")).toMatch(/IOC/);
    expect(describeOrderReason("open-interest cap reached: only fills that do not add open interest can trade")).toMatch(/limite de contratos em aberto/);
    expect(describeOrderReason("the position this reduce-only order would reduce is being closed by the trader's other orders")).toMatch(
      /somente-redução/,
    );
    expect(describeOrderReason("match could not settle on-chain: exchange paused")).toMatch(/condição geral/);
    expect(describeOrderReason("match could not settle on-chain: price band (repeatedly)")).toMatch(/sem culpa sua/);
    expect(describeOrderReason("exchange paused, market inactive or without an index price: this order cannot trade now")).toMatch(/pausada/);
    expect(describeOrderReason("post-only order would have taken liquidity")).toMatch(/post-only/);
    expect(describeOrderReason("something else")).toBe("something else");
  });

  it("describes a 200 answer: fresh, duplicate-and-live, duplicate-and-closed", () => {
    const base = { fillCount: 0, duplicate: false } as const;
    expect(describeSubmitAnswer({ ...base, status: "open" })).toEqual({ message: "Ordem enviada: aberta no livro.", warn: false });
    expect(describeSubmitAnswer({ ...base, status: "partially_filled", fillCount: 2 }).message).toMatch(/2 execução/);
    // IOC with nothing to match: accepted, but nothing is live.
    expect(describeSubmitAnswer({ ...base, status: "cancelled", reason: "IOC remainder cancelled" })).toMatchObject({ warn: true });

    const live = describeSubmitAnswer({ status: "open", duplicate: true, fillCount: 0 });
    expect(live.warn).toBe(false);
    expect(live.message).toMatch(/já a tinha recebido na primeira tentativa \(aberta no livro\)/);

    // Resubmitting a known closed order answers 200 with its real status: resolved, and closed.
    for (const [status, word] of [["cancelled", "cancelada"], ["expired", "expirada"], ["rejected", "rejeitada"]] as const) {
      const closed = describeSubmitAnswer({ status, duplicate: true, fillCount: 0 });
      expect(closed.warn, status).toBe(true);
      expect(closed.message, status).toContain(`já está encerrada (${word})`);
      expect(closed.message, status).toContain("não está mais no livro");
    }
    const partly = describeSubmitAnswer({
      status: "cancelled",
      duplicate: true,
      fillCount: 0,
      matched: "0,0500 BTC",
      reason: "open-interest cap reached: only fills that do not add open interest can trade",
    });
    expect(partly.message).toMatch(/0,0500 BTC já casado/);
    expect(partly.message).toMatch(/Motivo: o mercado atingiu o limite/);
  });

  it("the new meanings of RATE_LIMITED and CHAIN_UNAVAILABLE are in their messages", () => {
    const body = (code: string) => ({ error: { code, message: "x", outcome: "not_applied" } });
    expect(engineErrorMessage(429, body("RATE_LIMITED"), "")).toMatch(/não liquidarem on-chain/);
    expect(engineErrorMessage(503, body("CHAIN_UNAVAILABLE"), "")).toMatch(/relógio fora de sincronia/);
  });

  it("translates the contract's nonce errors and an engine request timeout", () => {
    const revert = (errorName: string) =>
      Object.assign(new Error("outer"), {
        cause: Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError", shortMessage: "raw", data: { errorName } }),
      });
    expect(describeError(revert("NonceTooHigh"))).toMatch(/alto demais/);
    expect(describeError(revert("NonceNotIncreased"))).toMatch(/maior que o atual/);
    expect(describeError(revert("SomethingElse"))).toBe("Transação revertida: raw");
    expect(describeError(new DOMException("The operation timed out.", "TimeoutError"))).toBe("O motor de ordens não respondeu a tempo.");
  });

  it("a confirmation timeout says the transaction may still confirm", () => {
    const err = new TxTimeoutError(`0x${"0".repeat(64)}`);
    expect(describeError(err)).toMatch(/pode ainda confirmar/);
    expect(describeError(Object.assign(new Error("x"), { name: "HttpRequestError" }))).toMatch(/RPC/);
  });

  it("uses the engine's own message for 4xx", () => {
    expect(engineErrorMessage(400, { error: "insufficient margin" }, "")).toBe("insufficient margin");
    expect(engineErrorMessage(422, { message: "bad signature" }, "")).toBe("bad signature");
    expect(engineErrorMessage(400, { error: { message: "nested" } }, "")).toBe("nested");
    expect(engineErrorMessage(400, undefined, "plain text reason")).toBe("plain text reason");
    expect(engineErrorMessage(400, undefined, "<html>…</html>")).toBe("Requisição recusada pelo motor (400).");
    expect(engineErrorMessage(503, undefined, "")).toContain("503");
  });

  it("recognizes wallet rejections anywhere in the cause chain", () => {
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    expect(describeError(rejected)).toBe("Solicitação rejeitada na carteira.");
    expect(describeError(new Error("outer", { cause: rejected }))).toBe("Solicitação rejeitada na carteira.");
    expect(describeError(new EngineError(400, "order expired"))).toBe("order expired");
    expect(describeError(null)).toBe("Erro inesperado.");
  });
});
