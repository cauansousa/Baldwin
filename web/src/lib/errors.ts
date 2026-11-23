/** Non-2xx response from the engine, carrying the server's own message. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** Pulls a human message out of an engine error body of unknown shape. */
export function engineErrorMessage(status: number, body: unknown, rawText: string): string {
  let detail: string | undefined;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const candidate = b.error ?? b.message ?? b.reason ?? b.detail;
    if (typeof candidate === "string") detail = candidate;
    else if (candidate && typeof candidate === "object") {
      const inner = (candidate as Record<string, unknown>).message;
      if (typeof inner === "string") detail = inner;
    }
  }
  if (!detail && rawText && rawText.length <= 200 && !rawText.trimStart().startsWith("<")) {
    detail = rawText.trim();
  }
  if (status >= 500) return `Erro interno do motor (${status})${detail ? `: ${detail}` : "."}`;
  if (detail) return detail;
  if (status === 404) return "Recurso não encontrado no motor (404).";
  if (status === 429) return "Muitas requisições. Tente novamente em instantes.";
  return `Requisição recusada pelo motor (${status}).`;
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  cause?: unknown;
}

function* causeChain(err: unknown): Generator<ErrorLike> {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth++) {
    yield current as ErrorLike;
    current = (current as ErrorLike).cause;
  }
}

/** True when the user dismissed the wallet prompt (EIP-1193 code 4001). */
export function isUserRejection(err: unknown): boolean {
  for (const e of causeChain(err)) {
    if (e.code === 4001 || e.code === "ACTION_REJECTED" || e.name === "UserRejectedRequestError") return true;
  }
  return false;
}

/** User-facing (Portuguese) description of any error thrown in the app. */
export function describeError(err: unknown): string {
  if (isUserRejection(err)) return "Solicitação rejeitada na carteira.";
  if (err instanceof EngineError) return err.message;
  for (const e of causeChain(err)) {
    if (e.name === "ContractFunctionRevertedError" && typeof e.shortMessage === "string") {
      return `Transação revertida: ${e.shortMessage}`;
    }
  }
  for (const e of causeChain(err)) {
    if (e.name === "InsufficientFundsError") return "Saldo de gás insuficiente para enviar a transação.";
    if (e.name === "ChainMismatchError") return "A carteira está em outra rede. Troque de rede e tente de novo.";
    if (e.name === "ConnectorNotConnectedError") return "Conecte a carteira primeiro.";
    if (e.name === "ProviderNotFoundError") return "Nenhuma carteira encontrada no navegador (instale a MetaMask ou similar).";
  }
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
    return "Não foi possível falar com o motor de ordens. Verifique se ele está no ar.";
  }
  if (err && typeof err === "object") {
    const e = err as ErrorLike;
    if (typeof e.shortMessage === "string") return e.shortMessage;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return "Erro inesperado.";
}
