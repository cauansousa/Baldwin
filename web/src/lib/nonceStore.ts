// Per-account memory of nonces this client has dealt with:
//  - the highest nonce handed to the wallet for signing (persisted in
//    localStorage, so a later bulk cancel also covers earlier sessions);
//  - the highest minValidNonce this tab set on-chain (covers the moment between
//    a confirmed bulk cancel and the next successful chain read).
// Nothing secret is stored: only numbers.

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // storage blocked
  }
}

export interface NonceStore {
  /** Call BEFORE asking the wallet to sign: the signature may exist even if we never see it. */
  recordSigned(trader: string, nonce: bigint): void;
  highestSigned(trader: string): bigint;
  recordFloor(trader: string, minValidNonce: bigint): void;
  floor(trader: string): bigint;
}

/** `scope` separates deployments, e.g. "<chainId>:<exchange>". */
export function createNonceStore(scope: string, storage: Storage | undefined = defaultStorage()): NonceStore {
  const signed = new Map<string, bigint>();
  const floors = new Map<string, bigint>();
  const key = (trader: string) => `foxy.maxNonce:${scope}:${trader}`.toLowerCase();

  const readPersisted = (trader: string): bigint => {
    try {
      const raw = storage?.getItem(key(trader));
      return raw && /^\d{1,78}$/.test(raw) ? BigInt(raw) : 0n;
    } catch {
      return 0n;
    }
  };
  const highestSigned = (trader: string): bigint => {
    const inMemory = signed.get(trader.toLowerCase()) ?? 0n;
    const persisted = readPersisted(trader);
    return persisted > inMemory ? persisted : inMemory;
  };

  return {
    recordSigned(trader, nonce) {
      if (nonce <= highestSigned(trader)) return;
      signed.set(trader.toLowerCase(), nonce);
      try {
        storage?.setItem(key(trader), nonce.toString());
      } catch {
        // Quota or blocked storage: the in-memory value still covers this session.
      }
    },
    highestSigned,
    recordFloor(trader, minValidNonce) {
      const k = trader.toLowerCase();
      if (minValidNonce > (floors.get(k) ?? 0n)) floors.set(k, minValidNonce);
    },
    floor: (trader) => floors.get(trader.toLowerCase()) ?? 0n,
  };
}
