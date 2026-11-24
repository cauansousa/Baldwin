import type { Deployment } from "@shared";
import { isAddress } from "viem";
import { LOCAL_CHAIN_ID, pickDeployment, resolveChain } from "./lib/chains";

type Address = `0x${string}`;

const env = import.meta.env;

/** Mock mode is a development aid only; it is compiled out of production builds. */
export const MOCK = import.meta.env.DEV && env.VITE_MOCK === "1";

function address(value: string | undefined): Address | undefined {
  const v = value?.trim();
  return v && isAddress(v) ? (v as Address) : undefined;
}

function parseChainId(value: string | undefined): number {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : LOCAL_CHAIN_ID;
}

const chainId = parseChainId(env.VITE_CHAIN_ID);
// Dev server only (always [] in production builds): contracts/deployments/<network>.json.
const deployment = pickDeployment<Partial<Deployment>>(__DEV_DEPLOYMENTS__, chainId);

// In mock mode nothing real is contacted; use fixed placeholder addresses.
const MOCK_EXCHANGE: Address = "0x00000000000000000000000000000000ba1d0001";
const MOCK_USDC: Address = "0x00000000000000000000000000000000ba1d0002";

export const chain = resolveChain(chainId, { rpcUrl: env.VITE_RPC_URL, explorerUrl: env.VITE_EXPLORER_URL });

export const config = {
  engineUrl: (env.VITE_ENGINE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
  rpcUrl: chain.rpcUrls.default.http[0]!,
  chainId,
  exchange: MOCK ? MOCK_EXCHANGE : (address(env.VITE_EXCHANGE_ADDRESS) ?? address(deployment?.exchange)),
  usdc: MOCK ? MOCK_USDC : (address(env.VITE_USDC_ADDRESS) ?? address(deployment?.usdc)),
} as const;

export { LOCAL_CHAIN_ID };
export const isLocalChain = chainId === LOCAL_CHAIN_ID;
