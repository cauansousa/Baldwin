import { concat, encodeAbiParameters, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { hashOrder, isCanonicalSignature, verifyCancelSignature, verifyOrderSignature } from "../src/signing.ts";
import type { Hex } from "../src/types.ts";
import { alice, bob, DOMAIN, makeOrder, signCancel, signOrder } from "./helpers.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("EIP-712 orders", () => {
  it("hashOrder equals the digest computed by hand from the Solidity type string", () => {
    const order = makeOrder(alice, true, 100, 1, { expiry: 1234n, reduceOnly: true });
    const typeHash = keccak256(
      toHex("Order(address trader,uint32 marketId,bool isBuy,bool reduceOnly,uint256 size,uint256 limitPrice,uint256 nonce,uint64 expiry)"),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint32" }, { type: "bool" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
        [typeHash, order.trader, order.marketId, order.isBuy, order.reduceOnly, order.size, order.limitPrice, order.nonce, order.expiry],
      ),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toHex("Foxy")),
          keccak256(toHex("1")),
          BigInt(DOMAIN.chainId),
          DOMAIN.verifyingContract,
        ],
      ),
    );
    expect(hashOrder(DOMAIN, order)).toBe(keccak256(concat(["0x1901", domainSeparator, structHash])));
  });

  it("accepts an order signed by its trader", async () => {
    const order = makeOrder(alice, true, 100, 1);
    expect(await verifyOrderSignature(DOMAIN, order, await signOrder(alice, order))).toBe(true);
  });

  it("rejects a signature by someone else", async () => {
    const order = makeOrder(alice, true, 100, 1);
    expect(await verifyOrderSignature(DOMAIN, order, await signOrder(bob, order))).toBe(false);
  });

  it("rejects when any signed field was altered", async () => {
    const order = makeOrder(alice, true, 100, 1);
    const sig = await signOrder(alice, order);
    const variants = [
      { ...order, size: order.size + 1n },
      { ...order, limitPrice: order.limitPrice + 1n },
      { ...order, isBuy: false },
      { ...order, reduceOnly: true },
      { ...order, nonce: order.nonce + 1n },
      { ...order, expiry: 1n },
      { ...order, marketId: order.marketId + 1 },
      { ...order, trader: bob.address },
    ];
    for (const v of variants) expect(await verifyOrderSignature(DOMAIN, v, sig)).toBe(false);
  });

  it("rejects a signature made for another chain or another exchange", async () => {
    const order = makeOrder(alice, true, 100, 1);
    const otherChain = await signOrder(alice, order, { ...DOMAIN, chainId: 1 });
    const otherContract = await signOrder(alice, order, { ...DOMAIN, verifyingContract: bob.address });
    expect(await verifyOrderSignature(DOMAIN, order, otherChain)).toBe(false);
    expect(await verifyOrderSignature(DOMAIN, order, otherContract)).toBe(false);
  });

  it("rejects malformed and non-canonical signatures", async () => {
    const order = makeOrder(alice, true, 100, 1);
    const sig = await signOrder(alice, order);
    expect(isCanonicalSignature(sig)).toBe(true);
    expect(await verifyOrderSignature(DOMAIN, order, "0x")).toBe(false);
    expect(await verifyOrderSignature(DOMAIN, order, sig.slice(0, -2))).toBe(false);
    expect(await verifyOrderSignature(DOMAIN, order, "not hex")).toBe(false);
    // The malleable twin (r, n - s, flipped v) recovers to the same address but must be refused.
    const r = sig.slice(2, 66);
    const s = BigInt("0x" + sig.slice(66, 130));
    const v = parseInt(sig.slice(130), 16);
    const twin = `0x${r}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    expect(isCanonicalSignature(twin)).toBe(false);
    expect(await verifyOrderSignature(DOMAIN, order, twin)).toBe(false);
    // v given as 0/1 instead of 27/28
    const yParity = `${sig.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}`;
    expect(await verifyOrderSignature(DOMAIN, order, yParity)).toBe(false);
  });
});

describe("EIP-712 cancel", () => {
  it("accepts the trader's Cancel and nothing else", async () => {
    expect(await verifyCancelSignature(DOMAIN, alice.address, 7n, await signCancel(alice, alice.address, 7n))).toBe(true);
    expect(await verifyCancelSignature(DOMAIN, alice.address, 8n, await signCancel(alice, alice.address, 7n))).toBe(false);
    expect(await verifyCancelSignature(DOMAIN, alice.address, 7n, await signCancel(bob, alice.address, 7n))).toBe(false);
    // An order signature is not a cancel signature.
    const order = makeOrder(alice, true, 100, 1);
    expect(await verifyCancelSignature(DOMAIN, alice.address, order.nonce, await signOrder(alice, order))).toBe(false);
  });
});
