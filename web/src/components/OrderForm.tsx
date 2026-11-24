import type { Order } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { hashTypedData } from "viem";
import { useSignTypedData, useWriteContract } from "wagmi";
import { readContract } from "wagmi/actions";
import { engine } from "../api";
import type { EngineHealth, MarketInfo, PostOrderResult } from "../api/types";
import { config } from "../config";
import { readChainTime, type ChainAccount, type ChainMarket, type ExchangeStatus } from "../hooks/useChain";
import { useTxFlow } from "../hooks/useTx";
import { queryKeys } from "../hooks/useEngine";
import { describeError, describeOrderReason, EngineError } from "../lib/errors";
import {
  cancelTypedData,
  DEFAULT_EXPIRY_SECONDS,
  defaultExpiry,
  nextNonce,
  nonceUpperBound,
  normalizeSignature,
  orderToJson,
  orderTypedData,
} from "../lib/order";
import { classifyLimitPrice, estimateOrder, priceBand } from "../lib/risk";
import { submitUntilKnown } from "../lib/submit";
import { nonceStore } from "../nonces";
import { exchangeAbi, wagmiConfig } from "../wagmi";
import { TxStatus } from "./TxStatus";
import { formatBps, formatPrice, formatSize, formatUsdc, parseWad } from "../lib/units";

export interface OrderPrefill {
  key: number; // changes on every request so the same values can be applied twice
  marketId: number;
  isBuy: boolean;
  price: string;
  size: string;
  reduceOnly: boolean;
}

type Submit =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "sending" }
  /** Resubmitting the same signed order because the engine's answer was lost. */
  | { status: "confirming"; attempt: number }
  /** Retries exhausted: the order may or may not be live. `detail` is the last error. */
  | { status: "unresolved"; detail: string }
  | { status: "discarding" }
  | { status: "discard_failed"; detail: string }
  | { status: "success"; message: string; warn: boolean }
  | { status: "error"; message: string };

/**
 * An order the wallet has signed and whose fate at the engine is not known
 * yet. Kept in memory until the engine accepts or refuses it, or the user
 * discards it; while it exists no other order is signed.
 */
interface SignedOrder {
  order: Order;
  signature: `0x${string}`;
  orderHash: `0x${string}`;
  postOnly: boolean;
  ioc: boolean;
}

interface Props {
  market: MarketInfo | undefined;
  chainMarket: ChainMarket | undefined;
  account: ChainAccount | undefined;
  exchangeStatus: ExchangeStatus | undefined;
  /** The engine's own view of this market (index price, enforced band), when it reports one. */
  engineMarket: EngineHealth["markets"][number] | undefined;
  /** Connected address on the right network; undefined disables submission. */
  trader: `0x${string}` | undefined;
  prefill: OrderPrefill | undefined;
}

const STATUS_LABELS: Record<string, string> = {
  open: "aberta no livro",
  partially_filled: "parcialmente executada",
  pending_settlement: "casada, aguardando liquidação on-chain",
  filled: "executada",
  cancelled: "cancelada",
  expired: "expirada",
  rejected: "rejeitada",
};
/** Statuses meaning the order did not survive; shown as a warning, not a success. */
const CLOSED_STATUSES = new Set(["cancelled", "expired", "rejected"]);

export function OrderForm({ market, chainMarket, account, exchangeStatus, engineMarket, trader, prefill }: Props) {
  const queryClient = useQueryClient();
  const { signTypedDataAsync } = useSignTypedData();

  const [isBuy, setIsBuy] = useState(true);
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [ioc, setIoc] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ status: "idle" });
  // Lets the user abandon a wallet prompt that never answers without leaving the form stuck.
  const attempt = useRef(0);
  const [pending, setPending] = useState<SignedOrder>();
  const { writeContractAsync } = useWriteContract();
  const cancelTx = useTxFlow();

  useEffect(() => {
    if (!prefill) return;
    setIsBuy(prefill.isBuy);
    setPrice(prefill.price);
    setSize(prefill.size);
    setReduceOnly(prefill.reduceOnly);
    setPostOnly(false);
    setIoc(false);
    setSubmit({ status: "idle" });
  }, [prefill]);

  const params = chainMarket?.params;
  const base = market?.symbol.split("-")[0] ?? "";

  const parsed = useMemo(() => {
    const p = parseWad(price);
    const s = parseWad(size);
    let sizeError = s.ok ? undefined : s.error;
    if (s.ok && params && s.value < params.minOrderSize) {
      sizeError = `Tamanho mínimo: ${formatSize(params.minOrderSize, { minFraction: 0, maxFraction: 8 })} ${base}.`;
    }
    return {
      price: p.ok ? p.value : undefined,
      size: s.ok && !sizeError ? s.value : undefined,
      priceError: p.ok ? undefined : p.error,
      sizeError,
    };
  }, [price, size, params, base]);

  // Post-only orders rest on the book, so they pay the maker fee; otherwise assume taker (worst case).
  const feeBps = params ? (postOnly ? params.makerFeeBps : params.takerFeeBps) : undefined;
  const estimate =
    parsed.price !== undefined && parsed.size !== undefined && params && feeBps !== undefined
      ? estimateOrder({
          sizeWad: parsed.size,
          priceWad: parsed.price,
          isBuy,
          indexPriceWad: chainMarket?.indexPrice,
          initialMarginBps: params.initialMarginBps,
          feeBps,
        })
      : undefined;

  // Reduce-only orders never add exposure, so they need no new initial margin.
  const margin = estimate ? (reduceOnly ? 0n : estimate.initialMargin) : undefined;
  const totalCost = estimate && margin !== undefined ? margin + estimate.fee + estimate.priceLoss : undefined;
  const free = account?.freeCollateral;
  const marginShort = !reduceOnly && totalCost !== undefined && free !== undefined && totalCost > free;

  // Fills must happen within index ± maxPriceDeviationBps.
  const maxDeviation = exchangeStatus?.maxPriceDeviationBps;
  // Prefer the band the engine actually enforces; otherwise derive it from the contract.
  const band =
    engineMarket?.band ??
    (chainMarket?.indexPrice !== undefined && maxDeviation !== undefined
      ? priceBand(chainMarket.indexPrice, maxDeviation)
      : undefined);
  const bandPosition = band && parsed.price !== undefined ? classifyLimitPrice(isBuy, parsed.price, band) : undefined;

  const busy =
    submit.status === "signing" || submit.status === "sending" || submit.status === "confirming" || submit.status === "discarding";
  const blocker = !market
    ? "Nenhum mercado disponível"
    : !config.exchange
      ? "Contrato não configurado"
      : !trader
        ? "Conecte a carteira na rede correta"
        : params && !params.active
          ? "Mercado inativo"
          : engineMarket && engineMarket.indexPrice === null
            ? "Mercado suspenso (sem preço índice)"
            : undefined;
  // One intent at a time: nothing new is signed while an earlier order is unresolved.
  const canSubmit = !blocker && !busy && !pending && parsed.price !== undefined && parsed.size !== undefined;

  const refreshAfterOrder = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.openOrders(trader) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chain });
  };

  function describeAccepted(result: PostOrderResult | undefined): Submit {
    if (!result) return { status: "success", message: "Ordem confirmada: o motor já a tinha registrado.", warn: false };
    const status = STATUS_LABELS[result.status] ?? result.status;
    const fills = result.fills.length > 0 ? ` · ${result.fills.length} execução(ões) aguardando liquidação` : "";
    const reason = result.reason ? ` Motivo: ${describeOrderReason(result.reason)}.` : "";
    return {
      status: "success",
      message: `Ordem enviada${status ? `: ${status}` : ""}${fills}.${reason}`,
      warn: CLOSED_STATUSES.has(result.status) && result.fills.length === 0,
    };
  }

  /**
   * Sends a signed order and keeps resubmitting the SAME signed order (the
   * engine is idempotent by order hash) while the answer is a timeout, a
   * network error or a "state unknown" 5xx. Never signs anything.
   */
  async function sendSigned(signed: SignedOrder) {
    setSubmit({ status: "sending" });
    const outcome = await submitUntilKnown(
      () =>
        engine.postOrder({
          order: orderToJson(signed.order),
          signature: signed.signature,
          orderHash: signed.orderHash,
          ...(signed.postOnly ? { postOnly: true } : {}),
          ...(signed.ioc ? { ioc: true } : {}),
        }),
      { onRetry: (n) => setSubmit({ status: "confirming", attempt: n }) },
    );
    if (outcome.kind === "accepted") {
      setPending(undefined);
      setSubmit(describeAccepted(outcome.value));
      setSize("");
    } else if (outcome.kind === "not_accepted") {
      // Definitely not registered: the signed order is dropped and a new one may be signed.
      setPending(undefined);
      setSubmit({ status: "error", message: describeError(outcome.error) });
    } else {
      setSubmit({ status: "unresolved", detail: describeError(outcome.error) });
    }
    refreshAfterOrder();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !market || !trader || !config.exchange) return;
    if (parsed.price === undefined || parsed.size === undefined) return;
    const id = ++attempt.current;
    const current = () => attempt.current === id;
    let signed: SignedOrder;
    try {
      setSubmit({ status: "signing" });
      // Nonces below the on-chain minimum (raised by a bulk cancel) are dead: stay above it.
      let minValidNonce = account?.minValidNonce ?? 0n;
      const floor = nonceStore.floor(trader);
      if (floor > minValidNonce) minValidNonce = floor;
      // The contract's clock bounds nonces; fall back to the device clock if the read fails.
      let chainTime = BigInt(Math.floor(Date.now() / 1000));
      const [onChainMin, onChainTime] = await Promise.allSettled([
        readContract(wagmiConfig, {
          abi: exchangeAbi,
          address: config.exchange,
          chainId: config.chainId,
          functionName: "minValidNonce",
          args: [trader],
        }),
        readChainTime(),
      ]);
      if (onChainMin.status === "fulfilled" && onChainMin.value > minValidNonce) minValidNonce = onChainMin.value;
      if (onChainTime.status === "fulfilled") chainTime = onChainTime.value;
      if (!current()) return;
      const order: Order = {
        trader,
        marketId: market.marketId,
        isBuy,
        reduceOnly,
        size: parsed.size,
        limitPrice: parsed.price,
        nonce: nextNonce(minValidNonce, nonceUpperBound(chainTime)), // throws if no acceptable nonce exists
        expiry: defaultExpiry(),
      };
      const typedData = orderTypedData(config.chainId, config.exchange, order);
      // Recorded before the wallet is asked: the signature may exist even if we never get it back.
      nonceStore.recordSigned(trader, order.nonce);
      const signature = normalizeSignature(await signTypedDataAsync(typedData));
      if (!current()) return;
      signed = { order, signature, orderHash: hashTypedData(typedData), postOnly, ioc };
    } catch (err) {
      if (current()) setSubmit({ status: "error", message: describeError(err) });
      return;
    }
    setPending(signed);
    await sendSigned(signed);
  }

  /**
   * Gives up on an unresolved order. The nonce is cancelled at the engine
   * first; the order is only forgotten once the engine confirms the cancel or
   * says it never had the order.
   */
  async function discardPending() {
    if (!pending || !trader || !config.exchange) return;
    setSubmit({ status: "discarding" });
    try {
      const signature = normalizeSignature(
        await signTypedDataAsync(cancelTypedData(config.chainId, config.exchange, trader, pending.order.nonce)),
      );
      await engine.cancelOrder(pending.orderHash, signature);
      setPending(undefined);
      setSubmit({ status: "success", message: "Ordem descartada: o motor confirmou o cancelamento.", warn: false });
    } catch (err) {
      if (err instanceof EngineError && err.status === 404) {
        setPending(undefined);
        setSubmit({ status: "success", message: "Ordem descartada: o motor confirmou que ela não chegou a ser registrada.", warn: false });
      } else {
        setSubmit({ status: "discard_failed", detail: describeError(err) });
      }
    }
    refreshAfterOrder();
  }

  /** Last resort for an unresolved order: kill its nonce in the contract. */
  async function cancelPendingOnChain() {
    const exchange = config.exchange;
    if (!pending || !exchange) return;
    const nonce = pending.order.nonce;
    const ok = await cancelTx.run(
      () => [
        {
          label: "Cancelamento on-chain",
          send: () =>
            writeContractAsync({ abi: exchangeAbi, address: exchange, chainId: config.chainId, functionName: "cancelOrder", args: [nonce] }),
        },
      ],
      "Ordem cancelada on-chain: o contrato não a aceitará mais.",
    );
    if (ok) {
      setPending(undefined);
      setSubmit({ status: "success", message: "Ordem cancelada on-chain: o contrato não a aceitará mais.", warn: false });
      refreshAfterOrder();
    }
  }

  const usd = (v: bigint | undefined) => (v !== undefined ? `${formatUsdc(v)} USDC` : "—");

  return (
    <section className="panel order-form" id="order-form">
      <h2 className="panel-title">Nova ordem {market && <span className="muted">· {market.symbol}</span>}</h2>
      <form onSubmit={onSubmit} noValidate>
        <div className="side-toggle" role="group" aria-label="Lado">
          <button type="button" className={isBuy ? "active buy" : ""} aria-pressed={isBuy} onClick={() => setIsBuy(true)}>
            Comprar
          </button>
          <button type="button" className={!isBuy ? "active sell" : ""} aria-pressed={!isBuy} onClick={() => setIsBuy(false)}>
            Vender
          </button>
        </div>

        <label className="field">
          <span className="field-label">Preço limite</span>
          <span className="input-wrap">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-invalid={price !== "" && !!parsed.priceError}
            />
            <span className="suffix">USD</span>
          </span>
          {price !== "" && parsed.priceError && <span className="field-error">{parsed.priceError}</span>}
        </label>

        <label className="field">
          <span className="field-label">Tamanho</span>
          <span className="input-wrap">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,0000"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              aria-invalid={size !== "" && !!parsed.sizeError}
            />
            <span className="suffix">{base}</span>
          </span>
          {size !== "" && parsed.sizeError && <span className="field-error">{parsed.sizeError}</span>}
        </label>

        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
            Somente redução
          </label>
          <label className="check" title="A ordem só entra no livro; é rejeitada se fosse executar de imediato.">
            <input
              type="checkbox"
              checked={postOnly}
              onChange={(e) => {
                setPostOnly(e.target.checked);
                if (e.target.checked) setIoc(false);
              }}
            />
            Post-only
          </label>
          <label className="check" title="Executa o que for possível agora e cancela o restante.">
            <input
              type="checkbox"
              checked={ioc}
              onChange={(e) => {
                setIoc(e.target.checked);
                if (e.target.checked) setPostOnly(false);
              }}
            />
            IOC
          </label>
        </div>

        <dl className="summary">
          <div>
            <dt>Valor nocional</dt>
            <dd className="num">{usd(estimate?.notional)}</dd>
          </div>
          <div>
            <dt>Taxa estimada{feeBps !== undefined && ` (${postOnly ? "maker" : "taker"}, ${feeBps} bps)`}</dt>
            <dd className="num">{usd(estimate?.fee)}</dd>
          </div>
          <div>
            <dt title="Calculada sobre o valor nocional ao preço índice, como faz o contrato.">Margem inicial (no índice)</dt>
            <dd className="num">{usd(margin)}</dd>
          </div>
          {estimate !== undefined && estimate.priceLoss > 0n && (
            <div>
              <dt title="Diferença entre o seu preço limite e o preço índice, se a ordem executar inteira no limite.">
                Perda imediata vs. índice
              </dt>
              <dd className="num neg">{usd(estimate.priceLoss)}</dd>
            </div>
          )}
          <div>
            <dt>Custo estimado</dt>
            <dd className="num strong">{totalCost !== undefined ? `≈ ${formatUsdc(totalCost)} USDC` : "—"}</dd>
          </div>
          <div>
            <dt>Colateral livre</dt>
            <dd className="num">{usd(free)}</dd>
          </div>
          <div>
            <dt>Validade</dt>
            <dd>{DEFAULT_EXPIRY_SECONDS / 3600} h</dd>
          </div>
        </dl>
        <p className="footnote">Valores estimados para execução total no preço limite; o contrato é quem decide.</p>

        {band && maxDeviation !== undefined && bandPosition === "crossing" && (
          <p className="note note-warn" role="alert">
            Preço fora da banda permitida ({formatPrice(band.lower)} – {formatPrice(band.upper)}, índice ±
            {formatBps(maxDeviation)}). Só executa contra ofertas dentro da banda; o restante não executado será
            cancelado pelo motor.
          </p>
        )}
        {band && bandPosition === "resting" && (
          <p className="note">
            Preço {isBuy ? "abaixo" : "acima"} da banda permitida ({formatPrice(band.lower)} – {formatPrice(band.upper)}).
            A ordem fica no livro e só poderá executar quando o índice se aproximar.
          </p>
        )}
        {marginShort && (
          <p className="note note-warn">
            O custo estimado supera o colateral livre. A ordem só será executada se reduzir sua posição.
          </p>
        )}

        <button type="submit" className={`btn btn-submit ${isBuy ? "buy" : "sell"}`} disabled={!canSubmit}>
          {blocker ??
            (submit.status === "signing"
              ? "Assine na carteira…"
              : submit.status === "sending"
                ? "Enviando…"
                : submit.status === "confirming"
                  ? "Confirmando com o motor…"
                  : pending
                    ? "Resolva a ordem pendente abaixo"
                    : `${isBuy ? "Comprar" : "Vender"} ${base}`)}
        </button>

        {submit.status === "signing" && (
          <p className="note" role="status">
            Aguardando a assinatura na carteira (não custa gás).{" "}
            <button
              type="button"
              className="link note-action"
              onClick={() => {
                attempt.current++;
                setSubmit({ status: "idle" });
              }}
            >
              Desistir
            </button>
          </p>
        )}
        {submit.status === "confirming" && (
          <p className="note" role="status">
            Confirmando com o motor… (tentativa {submit.attempt + 1}). A resposta anterior se perdeu; a mesma ordem
            assinada está sendo reenviada, sem criar outra.
          </p>
        )}
        {pending && (submit.status === "unresolved" || submit.status === "discard_failed" || submit.status === "discarding") && (
          <div className="note note-warn" role="alert">
            {submit.status === "discard_failed" ? (
              <p>
                Não foi possível confirmar o cancelamento ({submit.detail}) <strong>A ordem pode estar ativa.</strong> Tente
                de novo ou cancele on-chain, que vale mesmo sem o motor.
              </p>
            ) : (
              <p>
                Não foi possível confirmar com o motor se a ordem foi aceita{submit.status === "unresolved" ? ` (${submit.detail})` : ""}{" "}
                <strong>Ela pode estar ativa.</strong> Nenhuma outra ordem será assinada até isto se resolver.
              </p>
            )}
            <p className="num muted">
              {pending.order.isBuy ? "Compra" : "Venda"} {formatSize(pending.order.size)} {base} a {formatPrice(pending.order.limitPrice)}
            </p>
            <div className="note-buttons">
              <button type="button" className="btn btn-small" disabled={busy || cancelTx.busy} onClick={() => void sendSigned(pending)}>
                Reenviar a mesma ordem
              </button>
              <button type="button" className="btn btn-small" disabled={busy || cancelTx.busy} onClick={() => void discardPending()}>
                {submit.status === "discarding" ? "Cancelando…" : "Descartar (cancelar no motor)"}
              </button>
              <button type="button" className="btn btn-small" disabled={busy || cancelTx.busy} onClick={() => void cancelPendingOnChain()}>
                Cancelar on-chain
              </button>
            </div>
          </div>
        )}
        {pending && <TxStatus state={cancelTx.state} onDismiss={cancelTx.dismiss} />}
        {submit.status === "success" && (
          <p className={`note ${submit.warn ? "note-warn" : "note-ok"}`} role="status">
            {submit.message}
          </p>
        )}
        {submit.status === "error" && <p className="note note-error" role="alert">{submit.message}</p>}
      </form>
    </section>
  );
}
