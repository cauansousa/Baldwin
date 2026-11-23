import { WAD } from "@shared";
import type { MarketInfo } from "../api/types";
import type { ChainAccount, ChainMarket } from "../hooks/useChain";
import { entryPriceWad, estimateLiquidationPrice, unrealizedPnlUsdc } from "../lib/risk";
import { formatPrice, formatSize, formatUsdc, priceFractionDigits, roundToFraction, toInputString, WAD_DECIMALS } from "../lib/units";
import type { OrderPrefill } from "./OrderForm";

interface Props {
  markets: MarketInfo[];
  chainMarkets: Map<number, ChainMarket> | undefined;
  account: ChainAccount | undefined;
  connected: boolean;
  onClose: (prefill: Omit<OrderPrefill, "key">) => void;
}

export function PositionsTable({ markets, chainMarkets, account, connected, onClose }: Props) {
  const positions = account?.positions ?? [];
  return (
    <section className="panel">
      <h2 className="panel-title">
        Posições <span className="count">{positions.length}</span>
      </h2>
      {positions.length === 0 ? (
        <div className="empty">{connected ? "Nenhuma posição aberta." : "Conecte a carteira para ver suas posições."}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Mercado</th>
                <th>Lado</th>
                <th className="r">Tamanho</th>
                <th className="r">Preço de entrada</th>
                <th className="r">Preço índice</th>
                <th className="r">PnL não realizado</th>
                <th className="r" title="Estimativa: supõe que só este mercado se move e ignora funding futuro.">
                  Liq. estimada*
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const symbol = markets.find((m) => m.marketId === pos.marketId)?.symbol ?? `#${pos.marketId}`;
                const cm = chainMarkets?.get(pos.marketId);
                const index = cm?.indexPrice;
                const isLong = pos.size > 0n;
                const absSize = isLong ? pos.size : -pos.size;
                const entry = entryPriceWad(pos.entryNotional, pos.size);
                const pnl = index !== undefined ? unrealizedPnlUsdc(pos.size, pos.entryNotional, index) : undefined;
                const liq =
                  index !== undefined &&
                  cm?.params &&
                  account?.accountValue !== undefined &&
                  account.maintenanceMargin !== undefined
                    ? estimateLiquidationPrice({
                        sizeWad: pos.size,
                        indexPriceWad: index,
                        accountValue: account.accountValue,
                        maintenanceRequirement: account.maintenanceMargin,
                        maintenanceMarginBps: cm.params.maintenanceMarginBps,
                      })
                    : undefined;
                const fraction = priceFractionDigits(index ?? entry ?? WAD);
                return (
                  <tr key={pos.marketId}>
                    <td>{symbol}</td>
                    <td className={isLong ? "pos" : "neg"}>{isLong ? "Comprado" : "Vendido"}</td>
                    <td className="r num">{formatSize(absSize)}</td>
                    <td className="r num">{entry !== null ? formatPrice(entry, fraction) : "—"}</td>
                    <td className="r num">{index !== undefined ? formatPrice(index, fraction) : "—"}</td>
                    <td className={`r num ${pnl === undefined || pnl === 0n ? "" : pnl > 0n ? "pos" : "neg"}`}>
                      {pnl !== undefined ? formatUsdc(pnl, { showPlus: true }) : "—"}
                    </td>
                    <td className="r num">{liq === undefined ? "—" : liq === null ? "sem risco" : `≈ ${formatPrice(liq, fraction)}`}</td>
                    <td className="r">
                      <button
                        className="btn btn-small"
                        onClick={() =>
                          onClose({
                            marketId: pos.marketId,
                            isBuy: !isLong,
                            size: toInputString(absSize, WAD_DECIMALS),
                            price: index !== undefined ? toInputString(roundToFraction(index, WAD_DECIMALS, fraction), WAD_DECIMALS) : "",
                            reduceOnly: true,
                          })
                        }
                      >
                        Fechar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {positions.length > 0 && (
        <p className="footnote">
          * Preço de liquidação é uma estimativa: considera a margem cruzada atual, supõe que apenas este mercado se
          move e ignora funding futuro. O contrato é quem decide.
        </p>
      )}
    </section>
  );
}
