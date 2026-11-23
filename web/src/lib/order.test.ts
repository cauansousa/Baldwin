import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { engineErrorMessage, describeError, EngineError } from "./errors";
import {
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

describe("error messages", () => {
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
