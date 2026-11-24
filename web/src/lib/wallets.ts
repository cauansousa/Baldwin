/** Minimal view of a wagmi connector, enough to choose which ones to offer. */
export interface WalletOption {
  id: string;
  name: string;
  type: string;
}

/**
 * Wallets to offer in the connect menu. Wallets announced through EIP-6963
 * get one entry each; the generic `window.ethereum` connector is only offered
 * when none announced itself (it would otherwise duplicate one of them).
 */
export function selectWallets<T extends WalletOption>(connectors: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique = connectors.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  const announced = unique.filter((c) => c.type === "injected" && c.id !== "injected");
  return announced.length > 0 ? unique.filter((c) => c.id !== "injected") : unique;
}
