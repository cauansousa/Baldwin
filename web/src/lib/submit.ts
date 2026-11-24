// Order submission whose outcome can be unknown. A signed order is only ever
// resubmitted IDENTICALLY, never re-signed, until the engine says what happened
// to it. The engine is idempotent by order hash: the identical order again
// answers 200 with its current state and `duplicate: true`.

import { EngineError } from "./errors";

/**
 * What a failed POST /orders tells us about the order:
 *  - "not_accepted": nothing was changed at the engine.
 *  - "unknown": it may or may not be live.
 * Every engine error body carries `outcome` ("not_applied" | "unknown") and that
 * is trusted. Without it (a proxy's error page, an older engine) a 4xx still
 * means the request was refused; a 5xx, a timeout or a network error is unknown,
 * which only costs an idempotent resubmission.
 */
export function classifySubmitFailure(err: unknown): "not_accepted" | "unknown" {
  if (err instanceof EngineError) {
    if (err.outcome === "unknown") return "unknown";
    if (err.outcome === "not_applied") return "not_accepted";
    return err.status < 500 ? "not_accepted" : "unknown";
  }
  return "unknown";
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export type SubmitOutcome<T> =
  | { kind: "accepted"; value: T }
  /**
   * `resubmission` is true when an earlier attempt had an unknown outcome: a
   * refusal then (e.g. 409 NONCE_CANCELLED) may mean the order did arrive and
   * was cancelled or closed in the meantime. Either way it is not live.
   */
  | { kind: "not_accepted"; error: unknown; resubmission: boolean }
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
      if (classifySubmitFailure(err) === "not_accepted") return { kind: "not_accepted", error: err, resubmission: attempt > 0 };
      lastError = err;
    }
  }
  return { kind: "unknown", error: lastError };
}
