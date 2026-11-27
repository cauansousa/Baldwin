/** Non-2xx response from the engine, with a user-facing (Portuguese) message. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Engine error code, e.g. "INSUFFICIENT_MARGIN", when the body carried one. */
    readonly code?: string,
    /** The engine's own verdict on whether the request took effect, when the body carries one. */
    readonly outcome?: "not_applied" | "unknown",
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** Portuguese text for every error code the engine documents. */
const ENGINE_CODE_MESSAGES: Record<string, string> = {
  BAD_REQUEST: "Requisição inválida.",
  UNKNOWN_MARKET: "Mercado desconhecido.",
  MARKET_INACTIVE: "Este mercado está inativo.",
  INVALID_ORDER: "Ordem inválida.",
  BELOW_MIN_SIZE: "Tamanho abaixo do mínimo do mercado.",
  EXPIRED: "A ordem já expirou. Envie de novo.",
  INVALID_EXPIRY: "Validade inválida: a ordem precisa expirar entre 1 minuto e 7 dias a partir de agora.",
  PRICE_OUTSIDE_BAND: "Preço fora da banda permitida em torno do preço índice.",
  TRADER_SUSPENDED: "Sua conta está temporariamente suspensa no motor: várias ordens suas falharam on-chain. Tente mais tarde.",
  EXCHANGE_PAUSED: "A exchange está pausada: só ordens de redução de posição são aceitas.",
  MARKET_HALTED: "Mercado suspenso: sem preço índice recente. Novas ordens não são aceitas no momento.",
  DUPLICATE_ORDER: "Já existe uma ordem igual no livro.",
  NONCE_CANCELLED: "O nonce desta ordem já foi cancelado. Envie uma nova ordem.",
  NONCE_REUSED: "Nonce já usado por outra ordem. Envie de novo.",
  BAD_SIGNATURE: "Assinatura inválida. Confira a conta e a rede da carteira.",
  ALREADY_FILLED: "Esta ordem já foi totalmente executada.",
  REDUCE_ONLY_NO_POSITION: "Ordem somente-redução sem posição para reduzir.",
  INSUFFICIENT_MARGIN: "Margem insuficiente para esta ordem.",
  POST_ONLY_WOULD_CROSS: "Ordem post-only executaria de imediato; ajuste o preço.",
  SHUTTING_DOWN: "O motor está reiniciando e não aceitou a ordem. Tente de novo em instantes.",
  STORE_UNAVAILABLE: "O motor está com falha para gravar seu estado e não está aceitando ordens.",
  STATE_UNKNOWN: "O motor processou a ordem mas não conseguiu gravá-la; não se sabe se ela foi aceita.",
  RECOVERING: "O motor está se sincronizando com a blockchain após reiniciar e não aceitou a ordem. Tente de novo em instantes.",
  REDUCE_ONLY_EXCEEDS_POSITION: "Ordem somente-redução maior que a posição (somada às outras ordens de redução abertas).",
  CHAIN_UNAVAILABLE:
    "O motor não está aceitando ordens: sem acesso à blockchain ou com o relógio fora de sincronia com ela. Tente de novo em instantes.",
  RATE_LIMITED:
    "Limite de requisições atingido (por conexão, por conta ou após várias ordens suas não liquidarem on-chain). Aguarde um pouco e tente de novo.",
  NOT_FOUND: "Ordem não encontrada no motor.",
  INTERNAL: "Erro interno do motor; não se sabe se a requisição teve efeito.",
};

/** Codes whose English server detail adds useful specifics to the generic translation. */
const CODES_WITH_DETAIL = new Set(["BAD_REQUEST", "INVALID_ORDER"]);

export interface EngineErrorInfo {
  message: string;
  code?: string;
  outcome?: "not_applied" | "unknown";
}

/** Turns an engine error body of unknown shape into a user-facing message (and code, if any). */
export function parseEngineError(status: number, body: unknown, rawText: string): EngineErrorInfo {
  const info = describeEngineError(status, body, rawText);
  const outcome = readOutcome(body);
  return outcome ? { ...info, outcome } : info;
}

function readOutcome(body: unknown): "not_applied" | "unknown" | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const inner = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>).outcome : undefined;
  const value = inner ?? b.outcome;
  return value === "not_applied" || value === "unknown" ? value : undefined;
}

function describeEngineError(status: number, body: unknown, rawText: string): EngineErrorInfo {
  let detail: string | undefined;
  let code: string | undefined;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const candidate = b.error ?? b.message ?? b.reason ?? b.detail;
    if (typeof candidate === "string") detail = candidate;
    else if (candidate && typeof candidate === "object") {
      const inner = candidate as Record<string, unknown>;
      if (typeof inner.message === "string") detail = inner.message;
      if (typeof inner.code === "string") code = inner.code;
    }
    if (!code && typeof b.code === "string") code = b.code;
  }
  if (!detail && rawText && rawText.length <= 200 && !rawText.trimStart().startsWith("<")) {
    detail = rawText.trim();
  }
  const known = code ? ENGINE_CODE_MESSAGES[code] : undefined;
  if (known) {
    const withDetail = detail && CODES_WITH_DETAIL.has(code!) ? `${known} (${detail})` : known;
    return { message: withDetail, code };
  }
  if (status >= 500) return { message: `Erro interno do motor (${status})${detail ? `: ${detail}` : "."}`, code };
  if (detail) return { message: detail, code };
  if (status === 404) return { message: "Recurso não encontrado no motor (404).", code };
  if (status === 429) return { message: "Muitas requisições. Tente novamente em instantes.", code };
  return { message: `Requisição recusada pelo motor (${status}).`, code };
}

export const engineErrorMessage = (status: number, body: unknown, rawText: string) =>
  parseEngineError(status, body, rawText).message;

/** The transaction was not confirmed within the wait window; it may still confirm later. */
export class TxTimeoutError extends Error {
  constructor(readonly hash: `0x${string}`) {
    super("Sem confirmação até agora. A transação pode ainda confirmar; acompanhe na carteira ou no explorador antes de tentar de novo.");
    this.name = "TxTimeoutError";
  }
}

/** Portuguese text for the contract's custom errors a trader can run into. */
const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  NonceTooHigh: "O contrato recusou o novo mínimo de nonce por estar alto demais (limite: horário da rede + 1 dia).",
  NonceNotIncreased: "O novo mínimo de nonce precisa ser maior que o atual. Atualize a página e tente de novo.",
  InsufficientMargin: "Margem insuficiente para esta operação.",
  NegativeAccountValue: "O valor da conta ficaria negativo.",
  OnlyReducingAllowed: "A exchange está pausada: só operações que reduzem posição são permitidas.",
  StalePrice: "O preço do oráculo está desatualizado; tente de novo em instantes.",
  OrderIsCancelled: "Esta ordem já está cancelada.",
  OrderExpired: "Esta ordem já expirou.",
};

interface ErrorLike {
  data?: unknown;
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
  if (err instanceof EngineError || err instanceof TxTimeoutError) return err.message;
  for (const e of causeChain(err)) {
    // fetch() aborted by AbortSignal.timeout while talking to the engine.
    if ((e.name === "TimeoutError" || e.name === "AbortError") && typeof DOMException !== "undefined" && e instanceof DOMException) {
      return "O motor de ordens não respondeu a tempo.";
    }
  }
  for (const e of causeChain(err)) {
    if (e.name === "NonceRangeError" && typeof e.message === "string") return e.message;
    const errorName = e.data && typeof e.data === "object" ? (e.data as { errorName?: unknown }).errorName : undefined;
    const known = typeof errorName === "string" ? CONTRACT_ERROR_MESSAGES[errorName] : undefined;
    if (known) return known;
  }
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
    if (e.name === "ConnectorAlreadyConnectedError") return "A carteira já está conectada.";
    if (e.name === "ResourceUnavailableRpcError" || e.code === -32002) {
      return "Já existe um pedido aberto na carteira. Abra a carteira e responda a ele.";
    }
    if (e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "WebSocketRequestError") {
      return "Falha de rede ao falar com o nó RPC. Tentando de novo automaticamente.";
    }
    if (e.name === "LimitExceededRpcError" || e.code === -32005 || e.code === 429) {
      return "O nó RPC está limitando requisições. Tentando de novo automaticamente.";
    }
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
