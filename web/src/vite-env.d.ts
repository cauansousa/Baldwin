/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_EXCHANGE_ADDRESS?: string;
  readonly VITE_USDC_ADDRESS?: string;
  readonly VITE_MOCK?: string;
  /** Optional block-explorer base URL for chains the app has no built-in definition for. */
  readonly VITE_EXPLORER_URL?: string;
}

/** Injected by vite.config.ts: contents of contracts/deployments/*.json in dev, [] in builds. */
declare const __DEV_DEPLOYMENTS__: unknown[];
