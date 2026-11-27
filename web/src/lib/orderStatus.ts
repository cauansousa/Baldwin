// User-facing (Portuguese) wording for what the engine says about an order.

const STATUS_LABELS: Record<string, string> = {
  open: "aberta no livro",
  partially_filled: "parcialmente executada",
  pending_settlement: "casada, aguardando liquidação on-chain",
  filled: "executada",
  cancelled: "cancelada",
  expired: "expirada",
  rejected: "rejeitada",
};

/** Statuses meaning the order is closed and will not trade any further. */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "expired", "rejected"]);

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

/** Portuguese text for the reason the engine gives when it closes an order. */
export function describeOrderReason(reason: string): string {
  // Checked first: its detail may itself mention the band, the pause or the cap.
  if (/could not settle on-chain/i.test(reason)) {
    return "o negócio não pôde ser liquidado on-chain por uma condição geral (pausa, oráculo, banda de preço ou limite do mercado), sem culpa sua; o que não executou foi cancelado";
  }
  if (/price band/i.test(reason)) return "preço fora da banda permitida em torno do índice; o que não executou foi cancelado";
  if (/open-interest cap/i.test(reason)) {
    return "o mercado atingiu o limite de contratos em aberto; só negócios que não aumentam esse total são aceitos";
  }
  if (/reduce-only order would reduce/i.test(reason)) {
    return "a posição que esta ordem somente-redução reduziria já está sendo fechada por outras ordens suas";
  }
  if (/match failed on-chain/i.test(reason)) return "o negócio falhou on-chain e a ordem foi retirada";
  if (/exchange paused, market inactive or without an index price/i.test(reason)) {
    return "exchange pausada, mercado inativo ou sem preço índice: a ordem não pode negociar agora";
  }
  if (/post-only order would have taken liquidity/i.test(reason)) return "a ordem post-only executaria de imediato";
  if (/self-trade/i.test(reason)) return "a ordem casaria com outra ordem sua";
  if (/cancelled by trader/i.test(reason)) return "cancelada por você";
  if (/expired/i.test(reason)) return "expirada";
  if (/IOC/.test(reason)) return "ordem IOC: o que não executou de imediato foi cancelado";
  return reason;
}

export interface SubmitAnswer {
  status: string;
  reason?: string;
  duplicate: boolean;
  fillCount: number;
  /** Matched so far (pending + confirmed), already formatted with its unit, or undefined when zero/unknown. */
  matched?: string;
}

/**
 * Message for a 200 answer to POST /orders. `warn` is true when the order is
 * closed: nothing is live at the engine, even though the request "succeeded".
 * A `duplicate` answer describes an order the engine already had from an
 * earlier attempt whose reply was lost, in whatever state it is in now,
 * including closed.
 */
export function describeSubmitAnswer(a: SubmitAnswer): { message: string; warn: boolean } {
  const closed = CLOSED_STATUSES.has(a.status);
  const reason = a.reason ? ` Motivo: ${describeOrderReason(a.reason)}.` : "";
  const matched = a.matched ? ` · ${a.matched} já casado` : "";
  if (a.duplicate) {
    return closed
      ? {
          message: `A ordem tinha chegado ao motor na primeira tentativa, mas já está encerrada (${statusLabel(a.status)})${matched} e não está mais no livro.${reason}`,
          warn: true,
        }
      : {
          message: `Ordem confirmada: o motor já a tinha recebido na primeira tentativa (${statusLabel(a.status)})${matched}.${reason}`,
          warn: false,
        };
  }
  const fills = a.fillCount > 0 ? ` · ${a.fillCount} execução(ões) aguardando liquidação` : "";
  return { message: `Ordem enviada: ${statusLabel(a.status)}${fills}.${reason}`, warn: closed };
}
