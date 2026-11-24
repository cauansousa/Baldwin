// Order submission whose outcome can be unknown. A signed order is only ever
// resubmitted IDENTICALLY (the engine is idempotent by order hash), never
// re-signed, until the engine says what happened to it.

import { EngineError } from "./errors";

/**
 * 5xx codes that mean "definitely not accepted, nothing changed". Deliberately
 * short: a code missing here is treated as "unknown", which only costs an
 * idempotent resubmission, whereas a wrong entry could cause a duplicate order.
 */
const NOT_ACCEPTED_5XX = new Set(["SHUTTING_DOWN", "EXCHANGE_PAUSED", "MARKET_HALTED", "RECOVERING"]);

/**
 * What a failed POST /orders tells us about the order:
 *  - "not_accepted": the engine refused it (any 4xx, a 5xx that says so by an
 *    explicit `outcome: "not_applied"` or by a code known to mean it).
 *  - "unknown": it may or may not be live (timeout, network error, STATE_UNKNOWN,
 *    and any 5xx we cannot interpret).
 */
export function classifySubmitFailure(err: unknown): "not_accepted" | "unknown" {
  if (err instanceof EngineError) {
    if (err.outcome === "unknown") return "unknown";
    if (err.status < 500 || err.outcome === "not_applied") return "not_accepted";
    return err.code !== undefined && NOT_ACCEPTED_5XX.has(err.code) ? "not_accepted" : "unknown";
  }
  return "unknown";
}

/** On a resubmission, "duplicate" means the first attempt did arrive. */
const isDuplicate = (err: unknown) => err instanceof EngineError && err.code === "DUPLICATE_ORDER";

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export type SubmitOutcome<T> =
  | { kind: "accepted"; value: T | undefined } // value undefined: known to the engine, details not returned
  | { kind: "not_accepted"; error: unknown }
  | { kind: "unknown"; error: unknown };

/**
 * Sends the same request until its fate is known or the retries run out.
 * `send` must resubmit the identical signed order every time.
 */
export async function submitUntilKnown<T>(
  send: () => Promise<T>,
  opts: {
    delays?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** Called before each retry (1-based). */
    onRetry?: (attempt: number, error: unknown) => void;
    /** Return true to stop retrying (the user gave up waiting); the outcome is then "unknown". */
    stopped?: () => boolean;
  } = {},
): Promise<SubmitOutcome<T>> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      opts.onRetry?.(attempt, lastError);
      await sleep(delays[attempt - 1]!);
      if (opts.stopped?.()) break;
    }
    try {
      return { kind: "accepted", value: await send() };
    } catch (err) {
      if (attempt > 0 && isDuplicate(err)) return { kind: "accepted", value: undefined };
      if (classifySubmitFailure(err) === "not_accepted") return { kind: "not_accepted", error: err };
      lastError = err;
    }
  }
  return { kind: "unknown", error: lastError };
}
