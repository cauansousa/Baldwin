// Network definitions and block-explorer links. Pure: no env access here.

import { defineChain, type Chain } from "viem";
import { arbitrumSepolia } from "viem/chains";

export const LOCAL_CHAIN_ID = 31337;
export const ARBITRUM_SEPOLIA_CHAIN_ID = arbitrumSepolia.id; // 421614

const DEFAULT_LOCAL_RPC = "http://127.0.0.1:8545";

export interface ChainOptions {
  /** Overrides the chain's default RPC endpoint. */
  rpcUrl?: string;
  /** Explorer base URL for chains without a built-in definition. */
  explorerUrl?: string;
}

/**
 * Chain definition for a chain id: local node (31337), Arbitrum Sepolia
 * (421614) or a generic EVM chain for anything else. The definition is also
 * what the wallet receives in `wallet_addEthereumChain`.
 */
export function resolveChain(chainId: number, opts: ChainOptions = {}): Chain {
  const rpcUrl = opts.rpcUrl?.trim() || undefined;
  if (chainId === LOCAL_CHAIN_ID) {
    return defineChain({
      id: LOCAL_CHAIN_ID,
      name: "Localhost",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl ?? DEFAULT_LOCAL_RPC] } },
      testnet: true,
    });
  }
  if (chainId === ARBITRUM_SEPOLIA_CHAIN_ID) {
    return rpcUrl ? { ...arbitrumSepolia, rpcUrls: { default: { http: [rpcUrl] } } } : arbitrumSepolia;
  }
  const explorer = normalizeBaseUrl(opts.explorerUrl);
  return defineChain({
    id: chainId,
    name: `Rede ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl ?? DEFAULT_LOCAL_RPC] } },
    ...(explorer ? { blockExplorers: { default: { name: "Explorador", url: explorer } } } : {}),
  });
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  const u = url?.trim().replace(/\/+$/, "");
  return u && /^https?:\/\//i.test(u) ? u : undefined;
}

/** Explorer link for a transaction or address; undefined when the chain has no explorer (e.g. local). */
export function explorerLink(chain: Chain, kind: "tx" | "address", value: string): string | undefined {
  const base = normalizeBaseUrl(chain.blockExplorers?.default.url);
  if (!base) return undefined;
  const valid = kind === "tx" ? /^0x[0-9a-fA-F]{64}$/.test(value) : /^0x[0-9a-fA-F]{40}$/.test(value);
  return valid ? `${base}/${kind}/${value}` : undefined;
}

/** Picks the deployment record matching `chainId` out of contracts/deployments/*.json contents. */
export function pickDeployment<T extends object>(deployments: readonly unknown[], chainId: number): T | undefined {
  return deployments.find(
    (d): d is T => typeof d === "object" && d !== null && Number((d as { chainId?: unknown }).chainId) === chainId,
  );
}
