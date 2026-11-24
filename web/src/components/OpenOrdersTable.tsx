import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSignTypedData, useWriteContract } from "wagmi";
import { readContract } from "wagmi/actions";
import { engine } from "../api";
import { isCancellable } from "../api/normalize";
import type { MarketInfo, OpenOrder } from "../api/types";
import { config } from "../config";
import { queryKeys, useOpenOrders } from "../hooks/useEngine";
import { useTxFlow } from "../hooks/useTx";
import { describeError } from "../lib/errors";
import { bulkCancelNonce, cancelTypedData, normalizeSignature, rememberNonceFloor } from "../lib/order";
import { formatPrice, formatSize } from "../lib/units";
import { exchangeAbi, wagmiConfig } from "../wagmi";
import { TxStatus } from "./TxStatus";

const STATUS_LABELS: Record<string, string> = {
  open: "Aberta",
  partially_filled: "Parcial",
  pending_settlement: "Em liquidação",
  filled: "Executada",
  cancelled: "Cancelada",
  expired: "Expirada",
  rejected: "Rejeitada",
};

const expiryFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

interface Props {
  markets: MarketInfo[];
  /** Connected address (orders are listed even on the wrong network). */
  viewer: `0x${string}` | undefined;
  /** Connected address on the right network; required to sign a cancel. */
  trader: `0x${string}` | undefined;
}

export function OpenOrdersTable({ markets, viewer, trader }: Props) {
  const queryClient = useQueryClient();
  const { signTypedDataAsync } = useSignTypedData();
  const query = useOpenOrders(viewer);
  const orders = viewer ? (query.data ?? []) : [];
  const [cancelling, setCancelling] = useState<string>();
  const [error, setError] = useState<string>();

  async function cancel(o: OpenOrder) {
    if (!trader || !config.exchange) return;
    setError(undefined);
    setCancelling(o.orderHash);
    try {
      const signature = normalizeSignature(
        await signTypedDataAsync(cancelTypedData(config.chainId, config.exchange, trader, o.order.nonce)),
      );
      await engine.cancelOrder(o.orderHash, signature);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCancelling(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.openOrders(viewer) });
    }
  }

  // ---- on-chain cancels: the only ones that bind the contract (they cost gas).
  const { writeContractAsync } = useWriteContract();
  const tx = useTxFlow();
  const { exchange, chainId } = config;
  const refreshOrders = () => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.openOrders(viewer) });
    refresh();
    // The engine learns about on-chain cancels from events, a moment later.
    setTimeout(refresh, 4000);
  };

  async function cancelOnChain(o: OpenOrder) {
    if (!trader || !exchange) return;
    setError(undefined);
    const ok = await tx.run(
      () => [
        {
          label: "Cancelamento on-chain",
          send: () =>
            writeContractAsync({ abi: exchangeAbi, address: exchange, chainId, functionName: "cancelOrder", args: [o.order.nonce] }),
        },
      ],
      "Ordem cancelada on-chain.",
    );
    if (ok) refreshOrders();
  }

  async function cancelAllOnChain() {
    if (!trader || !exchange) return;
    setError(undefined);
    let newMin: bigint | undefined;
    const ok = await tx.run(async () => {
      // Read the current minimum first: the new one must be strictly greater.
      const currentMin = await readContract(wagmiConfig, {
        abi: exchangeAbi,
        address: exchange,
        chainId,
        functionName: "minValidNonce",
        args: [trader],
      });
      const value = bulkCancelNonce(currentMin);
      newMin = value;
      return [
        {
          label: "Cancelamento de todas as ordens on-chain",
          send: () =>
            writeContractAsync({ abi: exchangeAbi, address: exchange, chainId, functionName: "cancelAllOrders", args: [value] }),
        },
      ];
    }, "Todas as ordens assinadas até agora foram canceladas on-chain.");
    if (ok && newMin !== undefined) {
      // New orders must use nonces at or above the new minimum.
      rememberNonceFloor(trader, newMin);
      refreshOrders();
    }
  }

  const canTransact = !!trader && !!exchange && !tx.busy;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">
          Ordens abertas <span className="count">{orders.length}</span>
        </h2>
        {viewer && (
          <button
            className="btn btn-small"
            disabled={!canTransact}
            title="Invalida no contrato todas as ordens que você assinou até agora (custa gás)."
            onClick={() => void cancelAllOnChain()}
          >
            Cancelar todas on-chain
          </button>
        )}
      </div>
      {viewer && (
        <p className="footnote panel-hint">
          “Cancelar” é grátis e imediato, mas só retira a ordem do motor; apenas o cancelamento on-chain (custa gás)
          impede o contrato de aceitá-la.
        </p>
      )}
      <TxStatus state={tx.state} onDismiss={tx.dismiss} />
      {error && <p className="note note-error" role="alert">{error}</p>}
      {orders.length === 0 ? (
        <div className="empty">
          {!viewer
            ? "Conecte a carteira para ver suas ordens."
            : query.isError
              ? describeError(query.error)
              : query.isLoading
                ? "Carregando…"
                : "Nenhuma ordem aberta."}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Mercado</th>
                <th>Lado</th>
                <th className="r">Preço limite</th>
                <th className="r">Tamanho</th>
                <th className="r" title="Confirmado on-chain; “pend.” = casado, aguardando confirmação on-chain">
                  Executado
                </th>
                <th title="Parcial: parte executada, resto no livro. Em liquidação: toda casada, aguardando confirmação on-chain.">Status</th>
                <th>Condição</th>
                <th>Expira</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const symbol = markets.find((m) => m.marketId === o.order.marketId)?.symbol ?? `#${o.order.marketId}`;
                return (
                  <tr key={o.orderHash}>
                    <td>{symbol}</td>
                    <td className={o.order.isBuy ? "pos" : "neg"}>{o.order.isBuy ? "Compra" : "Venda"}</td>
                    <td className="r num">{formatPrice(o.order.limitPrice)}</td>
                    <td className="r num">{formatSize(o.order.size)}</td>
                    <td className="r num">
                      {formatSize(o.filledSize)}
                      {o.pendingSize > 0n && <span className="muted"> +{formatSize(o.pendingSize)} pend.</span>}
                    </td>
                    <td>{STATUS_LABELS[o.status] ?? o.status}</td>
                    <td>
                      {[o.order.reduceOnly && "Só redução", o.postOnly && "Post-only", o.ioc && "IOC"]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="num">
                      {o.order.expiry === 0n ? "Sem validade" : expiryFormat.format(Number(o.order.expiry) * 1000)}
                    </td>
                    <td className="r">
                      <span className="row-actions">
                        {isCancellable(o) && (
                          <button className="btn btn-small" disabled={!trader || cancelling !== undefined} onClick={() => void cancel(o)}>
                            {cancelling === o.orderHash ? "Cancelando…" : "Cancelar"}
                          </button>
                        )}
                        <button
                          className="btn btn-small btn-ghost"
                          disabled={!canTransact}
                          title="Cancela este nonce no contrato (custa gás)."
                          onClick={() => void cancelOnChain(o)}
                        >
                          On-chain
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
