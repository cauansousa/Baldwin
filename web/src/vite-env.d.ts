/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_EXCHANGE_ADDRESS?: string;
  readonly VITE_USDC_ADDRESS?: string;
  readonly VITE_MOCK?: string;
}

/** Injected by vite.config.ts; contracts/deployments/localhost.json or null. */
declare const __LOCAL_DEPLOYMENT__: unknown;
