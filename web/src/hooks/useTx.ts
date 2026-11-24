import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { waitForTransactionReceipt } from "wagmi/actions";
import { isLocalChain } from "../config";
import { describeError, TxTimeoutError } from "../lib/errors";
import { wagmiConfig } from "../wagmi";
import { queryKeys } from "./useEngine";

type Hash = `0x${string}`;

export type TxState =
  | { status: "idle" }
  | { status: "wallet"; label: string } // waiting for the user to confirm in the wallet
  | { status: "pending"; label: string; hash: Hash } // broadcast, waiting for inclusion
  | { status: "success"; label: string; hash?: Hash }
  | { status: "timeout"; message: string; hash: Hash } // not confirmed in time; outcome unknown
  | { status: "error"; message: string; hash?: Hash };

export interface TxStep {
  label: string;
  send: () => Promise<Hash>;
}

/** How long to wait for inclusion before handing control back to the user. */
const CONFIRMATION_TIMEOUT_MS = isLocalChain ? 60_000 : 180_000;

/**
 * Waits for a transaction, following speed-ups. A transaction the user
 * cancelled or replaced with a different one is an error; no receipt within
 * the window (slow network, dropped transaction) is a TxTimeoutError.
 */
async function confirm(hash: Hash, label: string): Promise<Hash> {
  let replacement: "cancelled" | "replaced" | "repriced" | undefined;
  let receipt;
  try {
    receipt = await waitForTransactionReceipt(wagmiConfig, {
      hash,
      timeout: CONFIRMATION_TIMEOUT_MS,
      onReplaced: (r) => (replacement = r.reason),
    });
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "WaitForTransactionReceiptTimeoutError") throw new TxTimeoutError(hash);
    throw err;
  }
  if (replacement === "cancelled") throw new Error(`${label}: a transação foi cancelada na carteira antes de confirmar.`);
  if (replacement === "replaced") {
    throw new Error(`${label}: a transação foi substituída por outra na carteira e não foi executada.`);
  }
  if (receipt.status !== "success") throw new Error(`${label}: a transação foi revertida pelo contrato.`);
  return receipt.transactionHash;
}

/**
 * Runs one or more transactions in sequence (e.g. approve then deposit),
 * exposing wallet / pending / confirmed / timeout / error states for the UI.
 * `dismiss` abandons the current run (e.g. a wallet prompt that was closed
 * without answering) so the UI never stays stuck; a transaction already sent
 * is not affected by it.
 */
export function useTxFlow() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });
  const runId = useRef(0);

  const run = useCallback(
    async (prepare: () => Promise<TxStep[]> | TxStep[], doneLabel: string): Promise<boolean> => {
      const id = ++runId.current;
      const current = () => runId.current === id;
      let hash: Hash | undefined;
      try {
        const steps = await prepare();
        for (const step of steps) {
          if (!current()) return false;
          setState({ status: "wallet", label: step.label });
          hash = await step.send();
          if (!current()) return false;
          setState({ status: "pending", label: step.label, hash });
          hash = await confirm(hash, step.label);
        }
        if (current()) setState({ status: "success", label: doneLabel, hash });
        return true;
      } catch (err) {
        if (!current()) return false;
        if (err instanceof TxTimeoutError) setState({ status: "timeout", message: err.message, hash: err.hash });
        else setState({ status: "error", message: describeError(err), hash });
        return false;
      } finally {
        void queryClient.invalidateQueries({ queryKey: queryKeys.chain });
      }
    },
    [queryClient],
  );

  const dismiss = useCallback(() => {
    runId.current++;
    setState({ status: "idle" });
  }, []);

  const busy = state.status === "wallet" || state.status === "pending";
  return { state, run, busy, dismiss };
}
