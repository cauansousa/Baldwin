import { ERC20_ABI, EXCHANGE_ABI } from "@shared";
import { defineChain, http, parseAbi, type Transport } from "viem";
import { createConfig, type CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors";
import { config, LOCAL_CHAIN_ID, MOCK } from "./config";

export const exchangeAbi = parseAbi(EXCHANGE_ABI);
export const erc20Abi = parseAbi(ERC20_ABI);

export const chain = defineChain({
  id: config.chainId,
  name: config.chainId === LOCAL_CHAIN_ID ? "Localhost" : `Rede ${config.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  testnet: config.chainId === LOCAL_CHAIN_ID,
});

let transport: Transport = http(config.rpcUrl);
let connector: CreateConnectorFn = injected();

// `import.meta.env.DEV` is repeated (MOCK already implies it) so the bundler
// can statically drop the mock import from production builds.
if (import.meta.env.DEV && MOCK) {
  // A fake provider plays both the RPC node and the wallet.
  const [{ mockProvider }, { custom }] = await Promise.all([import("./mock/provider"), import("viem")]);
  transport = custom(mockProvider);
  connector = injected({
    target: { id: "mock", name: "Carteira simulada", provider: () => mockProvider as never },
  });
}

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [connector],
  transports: { [chain.id]: transport },
  pollingInterval: 1000,
  // Wallets are discovered through the single injected connector only.
  multiInjectedProviderDiscovery: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
