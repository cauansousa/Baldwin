import { config } from "./config";
import { createNonceStore } from "./lib/nonceStore";

/** Nonce memory for the configured deployment (see lib/nonceStore.ts). */
export const nonceStore = createNonceStore(`${config.chainId}:${config.exchange ?? "unconfigured"}`);
