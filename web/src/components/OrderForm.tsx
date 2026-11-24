import type { Order } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSignTypedData } from "wagmi";
import { readContract } from "wagmi/actions";
import { engine } from "../api";
import type { EngineHealth, MarketInfo } from "../api/types";
import { config } from "../config";
import type { ChainAccount, ChainMarket, ExchangeStatus } from "../hooks/useChain";
import { queryKeys } from "../hooks/useEngine";
import { describeError, describeOrderReason } from "../lib/errors";
import {
  DEFAULT_EXPIRY_SECONDS,
  defaultExpiry,
  knownNonceFloor,
  nextNonce,
  normalizeSignature,
  orderToJson,
  orderTypedData,
} from "../lib/order";
import { classifyLimitPrice, estimateOrder, priceBand } from "../lib/risk";
import { exchangeAbi, wagmiConfig } from "../wagmi";
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
  | { status: "success"; message: string; warn: boolean }
  | { status: "error"; message: string };

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

  const busy = submit.status === "signing" || submit.status === "sending";
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
  const canSubmit = !blocker && !busy && parsed.price !== undefined && parsed.size !== undefined;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !market || !trader || !config.exchange) return;
    if (parsed.price === undefined || parsed.size === undefined) return;
    const id = ++attempt.current;
    const current = () => attempt.current === id;
    try {
      setSubmit({ status: "signing" });
      // Nonces below the on-chain minimum (raised by a bulk cancel) are dead: stay above it.
      let minValidNonce = account?.minValidNonce ?? 0n;
      const floor = knownNonceFloor(trader);
      if (floor > minValidNonce) minValidNonce = floor;
      try {
        const onChain = await readContract(wagmiConfig, {
          abi: exchangeAbi,
          address: config.exchange,
          chainId: config.chainId,
          functionName: "minValidNonce",
          args: [trader],
        });
        if (onChain > minValidNonce) minValidNonce = onChain;
      } catch {
        // RPC hiccup: fall back to the last value we know.
      }
      if (!current()) return;
      const order: Order = {
        trader,
        marketId: market.marketId,
        isBuy,
        reduceOnly,
        size: parsed.size,
        limitPrice: parsed.price,
        nonce: nextNonce(minValidNonce),
        expiry: defaultExpiry(),
      };
      const signature = normalizeSignature(
        await signTypedDataAsync(orderTypedData(config.chainId, config.exchange, order)),
      );
      if (!current()) return;
      setSubmit({ status: "sending" });
      const result = await engine.postOrder({
        order: orderToJson(order),
        signature,
        ...(postOnly ? { postOnly: true } : {}),
        ...(ioc ? { ioc: true } : {}),
      });
      const status = STATUS_LABELS[result.status] ?? result.status;
      const fills = result.fills.length > 0 ? ` · ${result.fills.length} execução(ões) aguardando liquidação` : "";
      const reason = result.reason ? ` Motivo: ${describeOrderReason(result.reason)}.` : "";
      if (!current()) return;
      setSubmit({
        status: "success",
        message: `Ordem enviada${status ? `: ${status}` : ""}${fills}.${reason}`,
        warn: CLOSED_STATUSES.has(result.status) && result.fills.length === 0,
      });
      setSize("");
    } catch (err) {
      if (current()) setSubmit({ status: "error", message: describeError(err) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.openOrders(trader) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chain });
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
