import type { Hex, Match } from "../types.ts";

export type MatchResult =
  | { status: "settled"; txHash: Hex }
  /** The contract emitted MatchFailed for this match; `reason` is the raw revert data. */
  | { status: "failed"; txHash: Hex | null; reason: Hex };

export interface Batch {
  /** Unique id; the same id is passed again when the engine retries the batch. */
  id: string;
  matches: Match[];
}

/**
 * Submits batches of matches to the Exchange.
 *
 * Contract with the engine:
 *  - `settle` resolves with exactly one result per match, in order, only once the
 *    outcome is final (transaction mined).
 *  - If it rejects with `BatchRevertedError`, the implementation guarantees that
 *    NONE of the matches were settled; the engine may retry or give up.
 *  - If it rejects with anything else the outcome is unknown. The engine will call
 *    `settle` again with the same `batch.id`; the implementation must make that safe
 *    (a batch must never be able to settle twice).
 *  - Batches are submitted strictly one at a time, in order.
 */
export interface Settler {
  settle(batch: Batch): Promise<MatchResult[]>;
  /** Conditions an operator must act on (optional). */
  status?(): { insufficientFunds: boolean; feeCapReached: boolean };
}

/** The batch definitively did not settle (transaction reverted or would revert). */
export class BatchRevertedError extends Error {
  override readonly name = "BatchRevertedError";
  constructor(message: string, public readonly txHash: Hex | null = null) {
    super(message);
  }
}
