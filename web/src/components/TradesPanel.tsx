import type { Trade } from "../api/types";
import { describeError } from "../lib/errors";
import { formatPrice, formatSize, priceFractionDigits } from "../lib/units";

const ROWS = 26;
const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface Props {
  trades: Trade[] | undefined;
  loading: boolean;
  error: unknown;
}

export function TradesPanel({ trades, loading, error }: Props) {
  const rows = (trades ?? []).slice(0, ROWS);
  const fraction = priceFractionDigits(rows[0]?.price ?? 0n);
  return (
    <section className="panel trades">
      <h2 className="panel-title">Negócios recentes</h2>
      <div className="trades-head">
        <span title="▲ comprador agrediu · ▼ vendedor agrediu">Preço (USD)</span>
        <span>Tamanho</span>
        <span>Hora</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">{error ? describeError(error) : loading ? "Carregando…" : "Nenhum negócio ainda"}</div>
      ) : (
        <div className="trades-list">
          {rows.map((t) => (
            <div className="trade-row" key={t.id}>
              <span className={`num ${t.takerIsBuy ? "pos" : "neg"}`}>
                <span aria-hidden="true">{t.takerIsBuy ? "▲ " : "▼ "}</span>
                <span className="sr-only">{t.takerIsBuy ? "compra " : "venda "}</span>
                {formatPrice(t.price, fraction)}
              </span>
              <span className="num">{formatSize(t.size)}</span>
              <span className="num muted">{t.timestampMs ? timeFormat.format(t.timestampMs) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
