import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSignTypedData, useWriteContract } from "wagmi";
import { readContract } from "wagmi/actions";
import { engine } from "../api";
import { isCancellable } from "../api/normalize";
import type { MarketInfo, OpenOrder } from "../api/types";
import { config } from "../config";
import { queryKeys, useOpenOrders } from "../hooks/useEngine";
import { readChainTime } from "../hooks/useChain";
import { useTxFlow } from "../hooks/useTx";
import { engineClock } from "../lib/clock";
import { describeError } from "../lib/errors";
import { cancelTypedData, nonceUpperBound, normalizeSignature, planBulkCancel } from "../lib/order";
import { formatPrice, formatSize } from "../lib/units";
import { nonceStore } from "../nonces";
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
      await engine.cancelOrder(o.orderHash, signature, trader, o.order.nonce);
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
  const refreshOrders = () => void queryClient.invalidateQueries({ queryKey: queryKeys.openOrders(viewer) });

  // Nonces this tab has seen cancelled in the contract. The engine only learns of an
  // on-chain cancel a couple of blocks later, so such orders can stay in its list
  // for a moment; they are labelled instead of being presented as live or as gone.
  const [cancelledOnChain, setCancelledOnChain] = useState<ReadonlySet<bigint>>(new Set());
  const [onChainFloor, setOnChainFloor] = useState(0n);
  const isDeadOnChain = (o: OpenOrder) => cancelledOnChain.has(o.order.nonce) || o.order.nonce < onChainFloor;

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
      "Cancelamento confirmado on-chain: o contrato não aceita mais esta ordem. O motor leva alguns blocos para refletir isso.",
    );
    if (ok) {
      setCancelledOnChain((prev) => new Set(prev).add(o.order.nonce));
      refreshOrders();
    }
  }

  // What the last bulk cancel actually achieved, checked against the contract.
  const [bulkReport, setBulkReport] = useState<{ ok: boolean; text: string }>();

  async function cancelAllOnChain() {
    if (!trader || !exchange) return;
    setError(undefined);
    setBulkReport(undefined);
    const listed = orders.map((o) => o.order.nonce);
    let plan: ReturnType<typeof planBulkCancel> | undefined;
    const ok = await tx.run(async () => {
      // The new minimum must exceed the current one and stay within the contract's
      // bound, which follows the chain's clock (not this device's).
      const [currentMin, chainTime] = await Promise.all([
        readContract(wagmiConfig, { abi: exchangeAbi, address: exchange, chainId, functionName: "minValidNonce", args: [trader] }),
        readChainTime(),
      ]);
      let highestSigned = nonceStore.highestSigned(trader);
      for (const nonce of listed) if (nonce > highestSigned) highestSigned = nonce;
      const planned = planBulkCancel({
        currentMinValidNonce: currentMin,
        highestSignedNonce: highestSigned,
        upperBound: nonceUpperBound(chainTime),
        // Nonces are dated from the engine's clock when it is known, so the cover must be too.
        nowMs: Math.max(engineClock.nowMs(), Date.now()),
      });
      plan = planned;
      return [
        {
          label: "Cancelamento em massa on-chain",
          send: () =>
            writeContractAsync({ abi: exchangeAbi, address: exchange, chainId, functionName: "cancelAllOrders", args: [planned.value] }),
        },
      ];
    }, "Novo mínimo de nonce gravado no contrato.");
    if (!ok || !plan) return;
    // New orders must use nonces at or above the new minimum.
    nonceStore.recordFloor(trader, plan.value);
    setOnChainFloor(plan.value);
    refreshOrders();

    // Do not take coverage for granted: ask the contract about every order that was listed.
    const checks = await Promise.allSettled(
      listed.map((nonce) =>
        readContract(wagmiConfig, { abi: exchangeAbi, address: exchange, chainId, functionName: "isCancelled", args: [trader, nonce] }),
      ),
    );
    const alive = checks.filter((c) => c.status === "fulfilled" && !c.value).length;
    const unverified = checks.filter((c) => c.status === "rejected").length;
    const problems: string[] = [];
    if (alive > 0) problems.push(`${alive} ordem(ns) listada(s) NÃO ficaram canceladas no contrato: cancele-as uma a uma com “On-chain”.`);
    if (unverified > 0) problems.push(`Não foi possível verificar ${unverified} ordem(ns) no contrato; confira de novo em instantes.`);
    if (!plan.coversAllSigned) {
      problems.push(
        "O limite do contrato (horário da rede + 1 dia) ficou abaixo de nonces que este dispositivo pode ter assinado; ordens assinadas com o relógio adiantado podem continuar válidas.",
      );
    }
    setBulkReport(
      problems.length > 0
        ? { ok: false, text: problems.join(" ") }
        : {
            ok: true,
            text:
              listed.length > 0
                ? `Verificado no contrato: as ${listed.length} ordem(ns) listada(s) estão canceladas, assim como qualquer outra assinada neste dispositivo até agora. O motor leva alguns blocos para tirá-las da lista.`
                : "Todas as ordens assinadas neste dispositivo até agora estão canceladas no contrato.",
          },
    );
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
          impede o contrato de aceitá-la (vale a partir da confirmação na rede; o motor reflete alguns blocos depois).
        </p>
      )}
      <TxStatus state={tx.state} onDismiss={tx.dismiss} />
      {bulkReport && (
        <p className={`note ${bulkReport.ok ? "note-ok" : "note-warn"}`} role={bulkReport.ok ? "status" : "alert"}>
          {bulkReport.text}
        </p>
      )}
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
        <div className="table-scroll" role="region" aria-label="Ordens abertas" tabIndex={0}>
          <table className="table">
            <caption className="sr-only">Ordens abertas</caption>
            <thead>
              <tr>
                <th scope="col">Mercado</th>
                <th scope="col">Lado</th>
                <th scope="col" className="r">Preço limite</th>
                <th scope="col" className="r">Tamanho</th>
                <th scope="col" className="r" title="Confirmado on-chain; “pend.” = casado, aguardando confirmação on-chain">
                  Executado
                </th>
                <th scope="col" title="Parcial: parte executada, resto no livro. Em liquidação: toda casada, aguardando confirmação on-chain.">Status</th>
                <th scope="col">Condição</th>
                <th scope="col">Expira</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const symbol = markets.find((m) => m.marketId === o.order.marketId)?.symbol ?? `#${o.order.marketId}`;
                return (
                  <tr key={o.orderHash}>
                    <th scope="row">{symbol}</th>
                    <td className={o.order.isBuy ? "pos" : "neg"}>{o.order.isBuy ? "▲ Compra" : "▼ Venda"}</td>
                    <td className="r num">{formatPrice(o.order.limitPrice)}</td>
                    <td className="r num">{formatSize(o.order.size)}</td>
                    <td className="r num">
                      {formatSize(o.filledSize)}
                      {o.pendingSize > 0n && <span className="muted"> +{formatSize(o.pendingSize)} pend.</span>}
                    </td>
                    <td>
                      {isDeadOnChain(o) ? (
                        <span title="O contrato já não aceita esta ordem; o motor leva alguns blocos para tirá-la da lista.">
                          Canc. on-chain
                          <span className="sr-only"> (o motor ainda está atualizando)</span>
                        </span>
                      ) : (
                        (STATUS_LABELS[o.status] ?? o.status)
                      )}
                    </td>
                    <td>
                      {[o.order.reduceOnly && "Só redução", o.postOnly && "Post-only", o.ioc && "IOC"]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="num">
                      {o.order.expiry === 0n ? "—" : expiryFormat.format(Number(o.order.expiry) * 1000).replace(",", "")}
                    </td>
                    <td className="r">
                      <span className="row-actions">
                        {isCancellable(o) && !isDeadOnChain(o) && (
                          <button
                            className="btn btn-small"
                            aria-label={`Cancelar ordem de ${o.order.isBuy ? "compra" : "venda"} em ${symbol} a ${formatPrice(o.order.limitPrice)}`}
                            disabled={!trader || cancelling !== undefined}
                            onClick={() => void cancel(o)}
                          >
                            {cancelling === o.orderHash ? "Cancelando…" : "Cancelar"}
                          </button>
                        )}
                        {!isDeadOnChain(o) && (
                        <button
                          className="btn btn-small btn-ghost"
                          disabled={!canTransact}
                          title="Cancela este nonce no contrato (custa gás)."
                          aria-label={`Cancelar on-chain a ordem de ${o.order.isBuy ? "compra" : "venda"} em ${symbol} a ${formatPrice(o.order.limitPrice)}`}
                          onClick={() => void cancelOnChain(o)}
                        >
                          On-chain
                        </button>
                        )}
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
