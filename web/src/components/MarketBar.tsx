import type { MarketInfo } from "../api/types";
import type { ChainMarket } from "../hooks/useChain";
import { useNowSeconds } from "../hooks/useNow";
import { formatCountdown, formatFundingRate, fundingDirection } from "../lib/funding";
import { formatPrice, formatSize } from "../lib/units";

interface Props {
  markets: MarketInfo[];
  market: MarketInfo | undefined;
  onSelectMarket: (marketId: number) => void;
  chainMarket: ChainMarket | undefined;
  loading: boolean;
}

const DIRECTION_TEXT = {
  longs_pay: "comprados pagam vendidos",
  shorts_pay: "vendidos pagam comprados",
  none: "ninguém paga",
} as const;

function Stat({ label, title, children, hint }: { label: string; title?: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="stat" title={title}>
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value num">
        {children}
        {hint && <span className="stat-hint">{hint}</span>}
      </dd>
    </div>
  );
}

/** Market selector plus prices, funding and open interest of the selected market (all read from the contract). */
export function MarketBar({ markets, market, onSelectMarket, chainMarket: cm, loading }: Props) {
  const now = useNowSeconds();
  const base = market?.symbol.split("-")[0] ?? "";
  const blank = loading ? "…" : "—";
  const price = (v: bigint | undefined) => (v !== undefined ? formatPrice(v) : blank);

  const rate = cm?.fundingRate;
  const countdown = cm?.nextFundingTime !== undefined ? formatCountdown(cm.nextFundingTime, now) : undefined;
  const oi = cm?.openInterest;

  return (
    <section className="market-bar" aria-label="Mercado">
      <label className="market-select">
        <span className="sr-only">Mercado</span>
        <select value={market?.marketId ?? ""} onChange={(e) => onSelectMarket(Number(e.target.value))} disabled={markets.length === 0}>
          {markets.length === 0 && <option value="">Sem mercados</option>}
          {markets.map((m) => (
            <option key={m.marketId} value={m.marketId}>
              {m.symbol}
            </option>
          ))}
        </select>
      </label>

      <dl className="stats">
        <Stat label="Preço índice" title="Preço do oráculo; usado para margem, PnL e liquidação.">
          {price(cm?.indexPrice)}
        </Stat>
        <Stat
          label="Último negócio"
          title="Preço do último negócio. A média ponderada pelo tempo (TWAP) do período atual é a que define o funding."
          hint={cm?.markTwap !== undefined ? <>TWAP {formatPrice(cm.markTwap)}</> : undefined}
        >
          {price(cm?.markPrice)}
        </Stat>
        <Stat
          label="Funding (por hora)"
          title="Taxa que o período atual aplicaria se fosse apurado agora. Positiva: comprados pagam vendidos. Um mercado sem negócios no período atual não paga funding."
          hint={rate !== undefined ? DIRECTION_TEXT[fundingDirection(rate)] : undefined}
        >
          {rate !== undefined ? formatFundingRate(rate) : blank}
        </Stat>
        <Stat label="Próximo funding" title="O funding é apurado no máximo uma vez por hora, na primeira transação depois do prazo.">
          {countdown === undefined ? blank : (countdown ?? "a qualquer momento")}
        </Stat>
        <Stat
          label="Contratos em aberto"
          title="Soma das posições compradas (igual à das vendidas, salvo posições assumidas em liquidação)."
          hint={oi && oi.longs !== oi.shorts ? <>vendidos {formatSize(oi.shorts, { maxFraction: 2 })}</> : undefined}
        >
          {oi ? `${formatSize(oi.longs, { maxFraction: 2 })} ${base}` : blank}
        </Stat>
      </dl>
    </section>
  );
}
