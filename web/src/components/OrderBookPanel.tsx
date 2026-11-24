import type { BookLevel, OrderBook } from "../api/types";
import { describeError } from "../lib/errors";
import { formatPrice, formatSize, formatUnits, priceFractionDigits } from "../lib/units";

const ROWS = 12;

interface Row extends BookLevel {
  total: bigint; // cumulative size from the best price
}

function withTotals(levels: BookLevel[]): Row[] {
  let total = 0n;
  return levels.slice(0, ROWS).map((l) => ({ ...l, total: (total += l.size) }));
}

/** Width of the depth bar in percent (integer math, 0..100). */
const barWidth = (total: bigint, max: bigint) => (max > 0n ? Number((total * 100n) / max) : 0);

interface Props {
  book: OrderBook | undefined;
  loading: boolean;
  error: unknown;
}

export function OrderBookPanel({ book, loading, error }: Props) {
  const asks = withTotals(book?.asks ?? []);
  const bids = withTotals(book?.bids ?? []);
  const maxTotal = [asks.at(-1)?.total ?? 0n, bids.at(-1)?.total ?? 0n].reduce((a, b) => (a > b ? a : b));
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const fraction = priceFractionDigits(bestBid ?? bestAsk ?? 0n);

  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;
  const mid = bestAsk !== undefined && bestBid !== undefined ? (bestAsk + bestBid) / 2n : undefined;
  // Spread relative to mid, as a percentage with 4 decimals of precision.
  const spreadPct = spread !== undefined && mid && mid > 0n ? (spread * 1_000_000n) / mid : undefined;

  const renderRow = (row: Row, side: "ask" | "bid") => (
    <div className={`book-row ${side}`} key={`${side}-${row.price}`}>
      <span className="depth" aria-hidden="true" style={{ width: `${barWidth(row.total, maxTotal)}%` }} />
      <span className={`num ${side === "ask" ? "neg" : "pos"}`}>{formatPrice(row.price, fraction)}</span>
      <span className="num">{formatSize(row.size)}</span>
      <span className="num muted">{formatSize(row.total)}</span>
    </div>
  );

  return (
    <section className="panel book">
      <h2 className="panel-title">Livro de ofertas</h2>
      <div className="book-head" aria-hidden="true">
        <span>Preço (USD)</span>
        <span>Tamanho</span>
        <span>Acumulado</span>
      </div>
      {!book ? (
        <div className="empty">{error ? describeError(error) : loading ? "Carregando…" : "Sem dados"}</div>
      ) : (
        <>
          <div className="book-side asks" role="group" aria-label="Ofertas de venda">
            <div className="book-caption neg">▼ Vendas</div>
            {asks.length === 0 ? <div className="empty">Sem ofertas de venda</div> : [...asks].reverse().map((r) => renderRow(r, "ask"))}
          </div>
          <div className="book-spread">
            <span className="muted">Spread</span>
            <span className="num">{spread !== undefined ? formatPrice(spread, fraction) : "—"}</span>
            <span className="num muted">{spreadPct !== undefined ? `${formatUnits(spreadPct, 4, { maxFraction: 3 })}%` : ""}</span>
          </div>
          <div className="book-side bids" role="group" aria-label="Ofertas de compra">
            <div className="book-caption pos">▲ Compras</div>
            {bids.length === 0 ? <div className="empty">Sem ofertas de compra</div> : bids.map((r) => renderRow(r, "bid"))}
          </div>
        </>
      )}
    </section>
  );
}
