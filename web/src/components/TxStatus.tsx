import type { TxState } from "../hooks/useTx";
import { explorerLink } from "../lib/chains";
import { chain } from "../wagmi";

/** Link to a transaction or address on the chain's explorer; plain text where there is none. */
export function ExplorerLink({ kind, value, children }: { kind: "tx" | "address"; value: string; children: React.ReactNode }) {
  const href = explorerLink(chain, kind, value);
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function TxLink({ hash }: { hash: string | undefined }) {
  if (!hash || !explorerLink(chain, "tx", hash)) return null;
  return (
    <>
      {" "}
      <ExplorerLink kind="tx" value={hash}>
        Ver no explorador
      </ExplorerLink>
    </>
  );
}

/** One-line status of a transaction flow: wallet prompt, pending, confirmed, timed out or failed. */
export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss: () => void }) {
  const dismiss = (text: string) => (
    <button type="button" className="link note-action" onClick={onDismiss}>
      {text}
    </button>
  );
  switch (state.status) {
    case "idle":
      return null;
    case "wallet":
      return (
        <p className="note" role="status">
          {state.label}: confirme na carteira… {dismiss("Desistir")}
        </p>
      );
    case "pending":
      return (
        <p className="note" role="status">
          {state.label}: aguardando confirmação na rede…
          <TxLink hash={state.hash} /> {dismiss("Parar de esperar")}
        </p>
      );
    case "success":
      return (
        <p className="note note-ok" role="status">
          {state.label}
          <TxLink hash={state.hash} />
        </p>
      );
    case "timeout":
      return (
        <p className="note note-warn" role="alert">
          {state.message}
          <TxLink hash={state.hash} /> {dismiss("Fechar")}
        </p>
      );
    case "error":
      return (
        <p className="note note-error" role="alert">
          {state.message}
          <TxLink hash={state.hash} />
        </p>
      );
  }
}
