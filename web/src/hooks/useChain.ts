import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { getBlock, readContract } from "wagmi/actions";
import type { MarketInfo } from "../api/types";
import { config } from "../config";
import { CHAIN_POLL_MS, erc20Abi, exchangeAbi, wagmiConfig } from "../wagmi";
import { mergeMarketFigures, missingReads, type ChainMarketReads, type MarketFigures, type MarketRead } from "../lib/marketData";
import { queryKeys } from "./useEngine";

const POLL_MS = CHAIN_POLL_MS;

/** Timestamp (unix seconds) of the latest block: the clock the contract uses. */
export async function readChainTime(): Promise<bigint> {
  return (await getBlock(wagmiConfig, { chainId: config.chainId, blockTag: "latest" })).timestamp;
}

export interface MarketParams {
  active: boolean;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  minOrderSize: bigint;
}

/** Per-market data for the UI: engine-mirrored figures where present, contract reads otherwise. */
export interface ChainMarket extends MarketFigures {
  params?: MarketParams;
  /** Cumulative funding index, USD-WAD per unit of base. */
  cumulativeFunding?: bigint;
}

/** What one poll reads from the contract for a market. */
interface MarketChainData extends ChainMarketReads {
  params?: MarketParams;
  cumulativeFunding?: bigint;
}

export interface ChainPosition {
  marketId: number;
  size: bigint;
  entryNotional: bigint;
  lastCumulativeFunding: bigint;
}

export interface ChainAccount {
  walletUsdc?: bigint;
  balance?: bigint;
  accountValue?: bigint;
  initialMargin?: bigint;
  maintenanceMargin?: bigint;
  freeCollateral?: bigint;
  /** Nonces below this were cancelled in bulk on-chain. */
  minValidNonce?: bigint;
  positions: ChainPosition[];
}

/**
 * Runs independent reads together. Individual failures become `undefined`
 * (a stale oracle must not blank the whole panel), but if every read fails
 * the first error is thrown so the UI can report that the chain is unreachable.
 */
async function readAll<T extends readonly Promise<unknown>[]>(
  reads: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> | undefined }> {
  const settled = await Promise.allSettled(reads);
  if (settled.length > 0 && settled.every((r) => r.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  return settled.map((r) => (r.status === "fulfilled" ? r.value : undefined)) as {
    [K in keyof T]: Awaited<T[K]> | undefined;
  };
}

const chainId = config.chainId;

// Market parameters change only through governance; re-read them once a minute.
const PARAMS_TTL_MS = 60_000;
const paramsCache = new Map<string, { at: number; params: MarketParams }>();

async function readParams(exchange: `0x${string}`, marketId: number): Promise<MarketParams> {
  const key = `${exchange}:${marketId}`;
  const cached = paramsCache.get(key);
  if (cached && Date.now() - cached.at < PARAMS_TTL_MS) return cached.params;
  const params = await readContract(wagmiConfig, { abi: exchangeAbi, address: exchange, chainId, functionName: "getMarket", args: [marketId] });
  paramsCache.set(key, { at: Date.now(), params });
  return params;
}

/** Reads from the contract only the views in `reads` (those the engine did not supply), plus params and the funding index. */
async function fetchMarket(exchange: `0x${string}`, marketId: number, reads: readonly MarketRead[]): Promise<MarketChainData> {
  const base = { abi: exchangeAbi, address: exchange, chainId, args: [marketId] } as const;
  const want = (r: MarketRead) => reads.includes(r);
  const skip = Promise.resolve(undefined);
  const [params, cumulativeFunding, indexPrice, markPrice, markTwap, fundingRate, lastFundingTime, openInterest] = await readAll([
    readParams(exchange, marketId),
    readContract(wagmiConfig, { ...base, functionName: "cumulativeFunding" }),
    want("indexPrice") ? readContract(wagmiConfig, { ...base, functionName: "indexPrice" }) : skip,
    want("markPrice") ? readContract(wagmiConfig, { ...base, functionName: "markPrice" }) : skip,
    want("markTwap") ? readContract(wagmiConfig, { ...base, functionName: "markTwap" }) : skip,
    want("currentFundingRate") ? readContract(wagmiConfig, { ...base, functionName: "currentFundingRate" }) : skip,
    want("lastFundingTime") ? readContract(wagmiConfig, { ...base, functionName: "lastFundingTime" }) : skip,
    want("openInterest") ? readContract(wagmiConfig, { ...base, functionName: "openInterest" }) : skip,
  ] as const);
  return {
    params,
    cumulativeFunding,
    indexPrice,
    markPrice,
    markTwap,
    fundingRate,
    lastFundingTime,
    openInterest: openInterest ? { longs: openInterest[0], shorts: openInterest[1] } : undefined,
  };
}

/**
 * Parameters, prices, funding and open interest of every market, keyed by
 * marketId. Figures the engine already mirrors on GET /markets are taken from
 * there; the contract is read only for what is missing (and always for the
 * parameters and the funding index).
 */
export function useChainMarkets(markets: MarketInfo[]) {
  const ids = markets.map((m) => m.marketId);
  const exchange = config.exchange;
  // The query function must see the latest engine data without it being part of the key.
  const latest = useRef(markets);
  latest.current = markets;
  const query = useQuery({
    queryKey: [...queryKeys.chain, "markets", exchange, ids],
    enabled: !!exchange && ids.length > 0,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const entries = await readAll(
        latest.current.map((m) => fetchMarket(exchange!, m.marketId, missingReads(m.stats))),
      );
      return new Map(latest.current.map((m, i) => [m.marketId, entries[i] ?? {}] as const));
    },
  });
  const data = useMemo(() => {
    if (!query.data && markets.every((m) => !m.stats || Object.keys(m.stats).length === 0)) return undefined;
    return new Map<number, ChainMarket>(
      markets.map((m) => {
        const chain = query.data?.get(m.marketId);
        return [m.marketId, { ...mergeMarketFigures(m.stats, chain), params: chain?.params, cumulativeFunding: chain?.cumulativeFunding }];
      }),
    );
  }, [markets, query.data]);
  return { data, isLoading: query.isLoading, isError: query.isError, error: query.error, isFetching: query.isFetching, refetch: query.refetch };
}

export interface ExchangeStatus {
  paused?: boolean;
  maxPriceDeviationBps?: bigint;
  /** USDC units held to cover losses beyond a liquidated account's value. */
  insuranceFund?: bigint;
  /** USDC units of losses nobody covered yet. */
  totalBadDebt?: bigint;
  oracle?: `0x${string}`;
}


/**
 * Exchange-wide state: pause flag, fill-price band, oracle address and, unless
 * the engine already reports them (`engineHasFigures`), insurance fund and bad debt.
 */
export function useExchangeStatus(engineHasFigures: boolean) {
  const exchange = config.exchange;
  const skipFigures = useRef(engineHasFigures);
  skipFigures.current = engineHasFigures;
  return useQuery({
    queryKey: [...queryKeys.chain, "status", exchange],
    enabled: !!exchange,
    refetchInterval: Math.max(10_000, POLL_MS),
    queryFn: async (): Promise<ExchangeStatus> => {
      const ex = { abi: exchangeAbi, address: exchange!, chainId } as const;
      const skip = Promise.resolve(undefined);
      const [paused, maxPriceDeviationBps, oracle, insuranceFund, totalBadDebt] = await readAll([
        readContract(wagmiConfig, { ...ex, functionName: "paused" }),
        readContract(wagmiConfig, { ...ex, functionName: "maxPriceDeviationBps" }),
        readContract(wagmiConfig, { ...ex, functionName: "oracle" }),
        skipFigures.current ? skip : readContract(wagmiConfig, { ...ex, functionName: "insuranceFund" }),
        skipFigures.current ? skip : readContract(wagmiConfig, { ...ex, functionName: "totalBadDebt" }),
      ] as const);
      return { paused, maxPriceDeviationBps, insuranceFund, totalBadDebt, oracle: oracle ?? config.oracle };
    },
  });
}

/** Balances, margin figures and positions of one trader. */
export function useChainAccount(trader: `0x${string}` | undefined, markets: MarketInfo[]) {
  const ids = markets.map((m) => m.marketId);
  const { exchange, usdc } = config;
  return useQuery({
    queryKey: [...queryKeys.chain, "account", exchange, usdc, trader, ids],
    enabled: !!exchange && !!trader,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<ChainAccount> => {
      const ex = { abi: exchangeAbi, address: exchange!, chainId } as const;
      const account = trader!;
      const [walletUsdc, balance, accountValue, margin, freeCollateral, minValidNonce, positions] = await readAll([
        usdc
          ? readContract(wagmiConfig, { abi: erc20Abi, address: usdc, chainId, functionName: "balanceOf", args: [account] })
          : Promise.resolve(undefined),
        readContract(wagmiConfig, { ...ex, functionName: "balanceOf", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "accountValue", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "marginRequirement", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "freeCollateral", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "minValidNonce", args: [account] }),
        readAll(ids.map((id) => readContract(wagmiConfig, { ...ex, functionName: "getPosition", args: [account, id] }))),
      ] as const);
      return {
        walletUsdc,
        balance,
        accountValue,
        initialMargin: margin?.[0],
        maintenanceMargin: margin?.[1],
        freeCollateral,
        minValidNonce,
        positions: (positions ?? []).flatMap((p, i) =>
          p && p.size !== 0n
            ? [{ marketId: ids[i]!, size: p.size, entryNotional: p.entryNotional, lastCumulativeFunding: p.lastCumulativeFunding }]
            : [],
        ),
      };
    },
  });
}
