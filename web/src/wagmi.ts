import { ERC20_ABI, EXCHANGE_ABI } from "@shared";
import { http, parseAbi, type Transport } from "viem";
import { createConfig, type CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors";
import { chain, config, isLocalChain, MOCK } from "./config";

export { chain };
export const exchangeAbi = parseAbi(EXCHANGE_ABI);
export const erc20Abi = parseAbi(ERC20_ABI);

/** How often chain data is polled; public testnet RPCs are rate-limited. */
export const CHAIN_POLL_MS = isLocalChain ? 3000 : 6000;

// Transient RPC failures are retried by the transport before a read fails.
let transport: Transport = http(config.rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 15_000 });
let connectors: CreateConnectorFn[] = [injected()];

// `import.meta.env.DEV` is repeated (MOCK already implies it) so the bundler
// can statically drop the mock import from production builds.
if (import.meta.env.DEV && MOCK) {
  // A fake provider plays both the RPC node and the wallet.
  const [{ mockProvider }, { custom }] = await Promise.all([import("./mock/provider"), import("viem")]);
  transport = custom(mockProvider, { retryCount: 0 });
  connectors = [injected({ target: { id: "mock", name: "Carteira simulada", provider: () => mockProvider as never } })];
}

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  transports: { [chain.id]: transport },
  pollingInterval: isLocalChain ? 1000 : 4000,
  // Reads issued together are folded into one multicall where the chain has
  // Multicall3 (Arbitrum Sepolia); on a local node they go out one by one.
  batch: { multicall: !MOCK },
  // EIP-6963: every installed wallet extension announces itself and gets its own connector.
  multiInjectedProviderDiscovery: !MOCK,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
