import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { waitForTransactionReceipt } from "wagmi/actions";
import { describeError } from "../lib/errors";
import { wagmiConfig } from "../wagmi";
import { queryKeys } from "./useEngine";

export type TxState =
  | { status: "idle" }
  | { status: "wallet"; label: string } // waiting for the user to confirm in the wallet
  | { status: "pending"; label: string } // broadcast, waiting for inclusion
  | { status: "success"; label: string }
  | { status: "error"; message: string };

export interface TxStep {
  label: string;
  send: () => Promise<`0x${string}`>;
}

/**
 * Runs one or more transactions in sequence (e.g. approve then deposit),
 * exposing wallet / pending / confirmed / error states for the UI.
 */
export function useTxFlow() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async (prepare: () => Promise<TxStep[]> | TxStep[], doneLabel: string): Promise<boolean> => {
      try {
        const steps = await prepare();
        for (const step of steps) {
          setState({ status: "wallet", label: step.label });
          const hash = await step.send();
          setState({ status: "pending", label: step.label });
          const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
          if (receipt.status !== "success") throw new Error(`Transação revertida (${step.label}).`);
        }
        setState({ status: "success", label: doneLabel });
        return true;
      } catch (err) {
        setState({ status: "error", message: describeError(err) });
        return false;
      } finally {
        void queryClient.invalidateQueries({ queryKey: queryKeys.chain });
      }
    },
    [queryClient],
  );

  const busy = state.status === "wallet" || state.status === "pending";
  return { state, run, busy, reset: useCallback(() => setState({ status: "idle" }), []) };
}
