import { config } from "../config";
import type { ExchangeStatus } from "../hooks/useChain";
import { describeError } from "../lib/errors";
import { formatUsdc } from "../lib/units";
import { ExplorerLink } from "./TxStatus";

interface Props {
  status: ExchangeStatus | undefined;
  loading: boolean;
  error: unknown;
  /** Pause state as shown elsewhere in the app (contract first, engine as fallback). */
  paused: boolean;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Address({ label, value }: { label: string; value: `0x${string}` | undefined }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="num">
        {value ? (
          <ExplorerLink kind="address" value={value}>
            <span title={value}>{short(value)}</span>
          </ExplorerLink>
        ) : (
          "—"
        )}
      </dd>
    </div>
  );
}

/** Protocol-level health read from the contract: insurance fund, bad debt, pause and addresses. */
export function ProtocolPanel({ status, loading, error, paused }: Props) {
  const badDebt = status?.totalBadDebt ?? 0n;
  return (
    <section className="panel protocol">
      <h2 className="panel-title">Estado do protocolo</h2>
      {!config.exchange ? (
        <div className="empty">Contrato não configurado.</div>
      ) : !status ? (
        <div className="empty">{error ? describeError(error) : loading ? "Carregando…" : "Sem dados"}</div>
      ) : (
        <>
          {error != null && (
            <p className="note note-error" role="alert">
              {describeError(error)} Os valores abaixo podem estar desatualizados.
            </p>
          )}
          <dl className="summary">
            <div>
              <dt title="Cobre perdas que excedem o valor de uma conta liquidada.">Fundo de seguro</dt>
              <dd className="num">{status.insuranceFund !== undefined ? `${formatUsdc(status.insuranceFund)} USDC` : "—"}</dd>
            </div>
            {badDebt > 0n && (
              <div>
                <dt>Dívida não coberta</dt>
                <dd className="num neg">{formatUsdc(badDebt)} USDC</dd>
              </div>
            )}
            <div>
              <dt>Negociação</dt>
              <dd>{paused ? "Pausada (só redução)" : "Ativa"}</dd>
            </div>
            <Address label="Contrato da exchange" value={config.exchange} />
            <Address label="Oráculo de preços" value={status.oracle} />
            <Address label="Token de colateral (USDC)" value={config.usdc} />
          </dl>
          {badDebt > 0n && (
            <p className="note note-warn" role="alert">
              <strong>Atenção:</strong> há perdas registradas que o fundo de seguro não cobriu. Enquanto essa dívida existir,
              o contrato pode guardar menos USDC do que a soma dos saldos, e os últimos saques podem não ser atendidos.
            </p>
          )}
        </>
      )}
    </section>
  );
}
