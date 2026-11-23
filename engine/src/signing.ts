import { hashTypedData, isAddressEqual, recoverTypedDataAddress, size as hexSize } from "viem";
import { CANCEL_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, ORDER_TYPES } from "../../shared/src/index.ts";
import type { Address, Hex, Order } from "./types.ts";

export interface Domain {
  chainId: number;
  verifyingContract: Address;
}

export function eip712Domain(d: Domain) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  } as const;
}

/** EIP-712 digest of an order; equals `Exchange.hashOrder(order)`. */
export function hashOrder(domain: Domain, order: Order): Hex {
  return hashTypedData({ domain: eip712Domain(domain), types: ORDER_TYPES, primaryType: "Order", message: order });
}

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Only canonical 65-byte (r, s, v) signatures with v in {27, 28} and low s are
 * accepted. Anything else might recover off-chain but be rejected by a strict
 * on-chain ECDSA check, which would only surface as a failed settlement.
 */
export function isCanonicalSignature(sig: string): sig is Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  if (hexSize(sig as Hex) !== 65) return false;
  const s = BigInt("0x" + sig.slice(66, 130));
  const v = parseInt(sig.slice(130, 132), 16);
  return (v === 27 || v === 28) && s > 0n && s <= SECP256K1_HALF_N;
}

async function recovers(expected: Address, recover: () => Promise<Address>): Promise<boolean> {
  try {
    return isAddressEqual(await recover(), expected);
  } catch {
    return false;
  }
}

/** True iff `signature` is a canonical EOA signature of `order` by `order.trader`. */
export async function verifyOrderSignature(domain: Domain, order: Order, signature: string): Promise<boolean> {
  if (!isCanonicalSignature(signature)) return false;
  return recovers(order.trader, () =>
    recoverTypedDataAddress({ domain: eip712Domain(domain), types: ORDER_TYPES, primaryType: "Order", message: order, signature }),
  );
}

/** True iff `signature` is a canonical EOA signature of `Cancel(trader, nonce)` by `trader`. */
export async function verifyCancelSignature(domain: Domain, trader: Address, nonce: bigint, signature: string): Promise<boolean> {
  if (!isCanonicalSignature(signature)) return false;
  return recovers(trader, () =>
    recoverTypedDataAddress({
      domain: eip712Domain(domain),
      types: CANCEL_TYPES,
      primaryType: "Cancel",
      message: { trader, nonce },
      signature,
    }),
  );
}
