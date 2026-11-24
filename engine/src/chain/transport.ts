import { http, type Transport } from "viem";

/**
 * HTTP JSON-RPC transport with viem's retry/backoff for transient failures, that also
 * reports every request that finally failed (not contract reverts) to `onError`.
 */
export function rpcTransport(url: string, onError: (method: string) => void): Transport {
  const inner = http(url, { retryCount: 3, retryDelay: 250, timeout: 20_000 });
  return (args) => {
    const t = inner(args);
    const request = (async (req: { method: string }, opts?: unknown) => {
      try {
        return await (t.request as (r: unknown, o?: unknown) => Promise<unknown>)(req, opts);
      } catch (e) {
        const err = e as { message?: string; details?: string; code?: number };
        const reverted = err.code === 3 || /revert/i.test(`${err.message ?? ""} ${err.details ?? ""}`);
        if (!reverted) onError(req.method);
        throw e;
      }
    }) as typeof t.request;
    return { ...t, request };
  };
}
