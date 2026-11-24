import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { describeError, describeOrderReason, EngineError, engineErrorMessage, parseEngineError, TxTimeoutError } from "./errors";
import {
  bulkCancelNonce,
  knownNonceFloor,
  nextNonce,
  rememberNonceFloor,
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

describe("on-chain bulk cancel nonces", () => {
  const now = 1_800_000_000_000;
  const MAX_RANDOM = 2n ** 64n - 1n;

  it("the new minimum is strictly above every nonce signed up to now", () => {
    const min = bulkCancelNonce(0n, now);
    expect(min).toBeGreaterThan(generateNonce(now, MAX_RANDOM));
    expect(min).toBeGreaterThan(generateNonce(now - 86_400_000, MAX_RANDOM));
    expect(min).toBe((BigInt(now) + 1n) << 64n);
  });

  it("is strictly greater than the current on-chain minimum, even if that is ahead of the clock", () => {
    const ahead = (BigInt(now) + 10_000n) << 64n;
    expect(bulkCancelNonce(ahead, now)).toBe(ahead + 1n);
    const same = bulkCancelNonce(0n, now);
    expect(bulkCancelNonce(same, now)).toBe(same + 1n);
    expect(bulkCancelNonce(same - 1n, now)).toBe(same);
  });

  it("orders signed after a bulk cancel get nonces at or above the new minimum", () => {
    const min = bulkCancelNonce(0n, now);
    // Same millisecond as the cancel, one later, and a device whose clock is far behind.
    for (const t of [now, now + 1, now - 3_600_000]) {
      for (const r of [0n, 12345n, MAX_RANDOM]) expect(nextNonce(min, t, r)).toBeGreaterThanOrEqual(min);
    }
    // Normally the nonce is just the time-based one.
    expect(nextNonce(0n, now, 7n)).toBe(generateNonce(now, 7n));
    expect(nextNonce(min, now + 5, 7n)).toBe(generateNonce(now + 5, 7n));
    // Still unique within a millisecond when bumped above the minimum.
    expect(nextNonce(min + 5n, now, 1n)).not.toBe(nextNonce(min + 5n, now, 2n));
  });

  it("remembers the highest floor per trader, case-insensitively", () => {
    expect(knownNonceFloor(trader)).toBe(0n);
    rememberNonceFloor(trader, 10n);
    rememberNonceFloor(trader.toLowerCase(), 5n);
    expect(knownNonceFloor(trader.toUpperCase().replace("0X", "0x"))).toBe(10n);
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
    expect(engineErrorMessage(429, body("RATE_LIMITED"), "")).toMatch(/Muitas requisições/);
    expect(engineErrorMessage(503, body("EXCHANGE_PAUSED"), "")).toMatch(/pausada/);
    expect(engineErrorMessage(503, body("MARKET_HALTED"), "")).toMatch(/Mercado suspenso/);
    expect(engineErrorMessage(503, body("CHAIN_UNAVAILABLE"), "")).toMatch(/blockchain/);
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

  it("translates the reason of an order the engine closed", () => {
    expect(describeOrderReason("price outside the oracle price band")).toMatch(/fora da banda/);
    expect(describeOrderReason("IOC order: match failed on-chain, size not re-posted")).toMatch(/IOC/);
    expect(describeOrderReason("something else")).toBe("something else");
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
