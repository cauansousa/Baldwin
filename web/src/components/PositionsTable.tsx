import { WAD } from "@shared";
import type { MarketInfo } from "../api/types";
import type { ChainAccount, ChainMarket } from "../hooks/useChain";
import { describeError } from "../lib/errors";
import { estimateNextFundingUsdc } from "../lib/funding";
import { entryPriceWad, estimateLiquidationPrice, unrealizedPnlUsdc } from "../lib/risk";
import { formatPrice, formatSize, formatUsdc, priceFractionDigits, roundToFraction, toInputString, WAD_DECIMALS } from "../lib/units";
import type { OrderPrefill } from "./OrderForm";

interface Props {
  markets: MarketInfo[];
  chainMarkets: Map<number, ChainMarket> | undefined;
  account: ChainAccount | undefined;
  loading: boolean;
  loadError: unknown;
  connected: boolean;
  onClose: (prefill: Omit<OrderPrefill, "key">) => void;
}

export function PositionsTable({ markets, chainMarkets, account, loading, loadError, connected, onClose }: Props) {
  const positions = account?.positions ?? [];
  return (
    <section className="panel">
      <h2 className="panel-title">
        Posições <span className="count">{positions.length}</span>
      </h2>
      {positions.length === 0 ? (
        <div className="empty">
          {!connected
            ? "Conecte a carteira para ver suas posições."
            : account
              ? "Nenhuma posição aberta."
              : loadError
                ? describeError(loadError)
                : loading
                  ? "Carregando…"
                  : "Sem dados"}
        </div>
      ) : (
        <div className="table-scroll" role="region" aria-label="Posições" tabIndex={0}>
          <table className="table">
            <caption className="sr-only">Posições abertas</caption>
            <thead>
              <tr>
                <th scope="col">Mercado</th>
                <th scope="col">Lado</th>
                <th scope="col" className="r">Tamanho</th>
                <th scope="col" className="r">Preço de entrada</th>
                <th scope="col" className="r">Preço índice</th>
                <th scope="col" className="r">PnL não realizado</th>
                <th
                  scope="col"
                  className="r"
                  title="Estimativa do próximo pagamento de funding, se a taxa, o preço e a posição não mudarem."
                >
                  Próx. funding*
                </th>
                <th scope="col" className="r" title="Estimativa: supõe que só este mercado se move e ignora funding futuro.">
                  Liq. estimada*
                </th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
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
                // Positive = this position pays at the next accrual.
                const nextFunding =
                  index !== undefined && cm?.fundingRate !== undefined
                    ? estimateNextFundingUsdc(pos.size, index, cm.fundingRate)
                    : undefined;
                return (
                  <tr key={pos.marketId}>
                    <th scope="row">{symbol}</th>
                    <td className={isLong ? "pos" : "neg"}>{isLong ? "▲ Comprado" : "▼ Vendido"}</td>
                    <td className="r num">{formatSize(absSize)}</td>
                    <td className="r num">{entry !== null ? formatPrice(entry, fraction) : "—"}</td>
                    <td className="r num">{index !== undefined ? formatPrice(index, fraction) : "—"}</td>
                    <td className={`r num ${pnl === undefined || pnl === 0n ? "" : pnl > 0n ? "pos" : "neg"}`}>
                      {pnl !== undefined ? formatUsdc(pnl, { showPlus: true }) : "—"}
                    </td>
                    <td className="r num">
                      {nextFunding === undefined
                        ? "—"
                        : nextFunding === 0n
                          ? "0,00"
                          : nextFunding > 0n
                            ? `≈ paga ${formatUsdc(nextFunding)}`
                            : `≈ recebe ${formatUsdc(-nextFunding)}`}
                    </td>
                    <td className="r num">{liq === undefined ? "—" : liq === null ? "sem risco" : `≈ ${formatPrice(liq, fraction)}`}</td>
                    <td className="r">
                      <button
                        className="btn btn-small"
                        aria-label={`Fechar posição em ${symbol}`}
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
          * Estimativas. Liquidação: considera a margem cruzada atual, supõe que apenas este mercado se move e ignora
          funding futuro. Próximo funding: supõe taxa, preço índice e posição inalterados até a apuração. O contrato é
          quem decide.
        </p>
      )}
    </section>
  );
}
