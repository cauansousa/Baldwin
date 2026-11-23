import { useQuery } from "@tanstack/react-query";
import { readContract } from "wagmi/actions";
import type { MarketInfo } from "../api/types";
import { config } from "../config";
import { erc20Abi, exchangeAbi, wagmiConfig } from "../wagmi";
import { queryKeys } from "./useEngine";

const POLL_MS = 3000;

export interface MarketParams {
  active: boolean;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  minOrderSize: bigint;
}

export interface ChainMarket {
  params?: MarketParams;
  indexPrice?: bigint; // WAD; undefined when the oracle read fails (e.g. stale)
  markPrice?: bigint; // WAD; undefined before the first fill
}

export interface ChainPosition {
  marketId: number;
  size: bigint;
  entryNotional: bigint;
}

export interface ChainAccount {
  walletUsdc?: bigint;
  balance?: bigint;
  accountValue?: bigint;
  initialMargin?: bigint;
  maintenanceMargin?: bigint;
  freeCollateral?: bigint;
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

async function fetchMarket(exchange: `0x${string}`, marketId: number): Promise<ChainMarket> {
  const base = { abi: exchangeAbi, address: exchange, chainId, args: [marketId] } as const;
  const [params, indexPrice, markPrice] = await readAll([
    readContract(wagmiConfig, { ...base, functionName: "getMarket" }),
    readContract(wagmiConfig, { ...base, functionName: "indexPrice" }),
    readContract(wagmiConfig, { ...base, functionName: "markPrice" }),
  ] as const);
  return {
    params,
    indexPrice: indexPrice && indexPrice > 0n ? indexPrice : undefined,
    markPrice: markPrice && markPrice > 0n ? markPrice : undefined,
  };
}

/** On-chain parameters and prices for every market, keyed by marketId. */
export function useChainMarkets(markets: MarketInfo[]) {
  const ids = markets.map((m) => m.marketId);
  const exchange = config.exchange;
  return useQuery({
    queryKey: [...queryKeys.chain, "markets", exchange, ids],
    enabled: !!exchange && ids.length > 0,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const entries = await readAll(ids.map((id) => fetchMarket(exchange!, id)));
      return new Map(ids.map((id, i) => [id, entries[i] ?? {}] as const));
    },
  });
}

export interface ExchangeStatus {
  paused?: boolean;
  maxPriceDeviationBps?: bigint;
}

/** Exchange-wide flags: pause state and the fill-price band around the index. */
export function useExchangeStatus() {
  const exchange = config.exchange;
  return useQuery({
    queryKey: [...queryKeys.chain, "status", exchange],
    enabled: !!exchange,
    refetchInterval: 10_000,
    queryFn: async (): Promise<ExchangeStatus> => {
      const ex = { abi: exchangeAbi, address: exchange!, chainId } as const;
      const [paused, maxPriceDeviationBps] = await readAll([
        readContract(wagmiConfig, { ...ex, functionName: "paused" }),
        readContract(wagmiConfig, { ...ex, functionName: "maxPriceDeviationBps" }),
      ] as const);
      return { paused, maxPriceDeviationBps };
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
      const [walletUsdc, balance, accountValue, margin, freeCollateral, positions] = await readAll([
        usdc
          ? readContract(wagmiConfig, { abi: erc20Abi, address: usdc, chainId, functionName: "balanceOf", args: [account] })
          : Promise.resolve(undefined),
        readContract(wagmiConfig, { ...ex, functionName: "balanceOf", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "accountValue", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "marginRequirement", args: [account] }),
        readContract(wagmiConfig, { ...ex, functionName: "freeCollateral", args: [account] }),
        readAll(ids.map((id) => readContract(wagmiConfig, { ...ex, functionName: "getPosition", args: [account, id] }))),
      ] as const);
      return {
        walletUsdc,
        balance,
        accountValue,
        initialMargin: margin?.[0],
        maintenanceMargin: margin?.[1],
        freeCollateral,
        positions: (positions ?? []).flatMap((p, i) =>
          p && p.size !== 0n ? [{ marketId: ids[i]!, size: p.size, entryNotional: p.entryNotional }] : [],
        ),
      };
    },
  });
}
