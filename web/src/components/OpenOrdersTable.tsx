import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSignTypedData } from "wagmi";
import { engine } from "../api";
import type { MarketInfo, OpenOrder } from "../api/types";
import { config } from "../config";
import { queryKeys, useOpenOrders } from "../hooks/useEngine";
import { describeError } from "../lib/errors";
import { cancelTypedData } from "../lib/order";
import { formatPrice, formatSize } from "../lib/units";

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
      const signature = await signTypedDataAsync(cancelTypedData(config.chainId, config.exchange, trader, o.order.nonce));
      await engine.cancelOrder(o.orderHash, signature);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCancelling(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.openOrders(viewer) });
    }
  }

  return (
    <section className="panel">
      <h2 className="panel-title">
        Ordens abertas <span className="count">{orders.length}</span>
      </h2>
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
                <th className="r">Executado</th>
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
                    <td className="r num">{formatSize(o.filledSize)}</td>
                    <td>
                      {[o.order.reduceOnly && "Somente redução", o.postOnly && "Post-only", o.ioc && "IOC"]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="num">
                      {o.order.expiry === 0n ? "Sem validade" : expiryFormat.format(Number(o.order.expiry) * 1000)}
                    </td>
                    <td className="r">
                      <button className="btn btn-small" disabled={!trader || cancelling !== undefined} onClick={() => void cancel(o)}>
                        {cancelling === o.orderHash ? "Cancelando…" : "Cancelar"}
                      </button>
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
