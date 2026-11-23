import type { Deployment } from "@shared";
import { isAddress } from "viem";

type Address = `0x${string}`;

const env = import.meta.env;

/** Mock mode is a development aid only; it is compiled out of production builds. */
export const MOCK = import.meta.env.DEV && env.VITE_MOCK === "1";

function localDeployment(): Partial<Deployment> | null {
  const d = __LOCAL_DEPLOYMENT__;
  return d && typeof d === "object" ? (d as Partial<Deployment>) : null;
}

function address(value: string | undefined): Address | undefined {
  const v = value?.trim();
  return v && isAddress(v) ? (v as Address) : undefined;
}

function chainId(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : fallback;
}

const deployment = localDeployment();

// In mock mode nothing real is contacted; use fixed placeholder addresses.
const MOCK_EXCHANGE: Address = "0x00000000000000000000000000000000ba1d0001";
const MOCK_USDC: Address = "0x00000000000000000000000000000000ba1d0002";

export const config = {
  engineUrl: (env.VITE_ENGINE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
  rpcUrl: env.VITE_RPC_URL?.trim() || "http://127.0.0.1:8545",
  chainId: MOCK ? 31337 : chainId(env.VITE_CHAIN_ID, deployment?.chainId ?? 31337),
  exchange: MOCK ? MOCK_EXCHANGE : (address(env.VITE_EXCHANGE_ADDRESS) ?? address(deployment?.exchange)),
  usdc: MOCK ? MOCK_USDC : (address(env.VITE_USDC_ADDRESS) ?? address(deployment?.usdc)),
} as const;

export const LOCAL_CHAIN_ID = 31337;
export const isLocalChain = config.chainId === LOCAL_CHAIN_ID;
