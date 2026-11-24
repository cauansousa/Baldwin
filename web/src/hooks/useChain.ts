import { useQuery } from "@tanstack/react-query";
import { parseAbi } from "viem";
import { getBlock, readContract } from "wagmi/actions";
import type { MarketInfo } from "../api/types";
import { config } from "../config";
import { CHAIN_POLL_MS, erc20Abi, exchangeAbi, wagmiConfig } from "../wagmi";
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

export interface ChainMarket {
  params?: MarketParams;
  indexPrice?: bigint; // WAD; undefined when the oracle read fails (e.g. stale)
  markPrice?: bigint; // WAD, last fill; undefined before the first fill
  /** Time-weighted average fill price of the current funding period (the index if it did not trade), WAD. */
  markTwap?: bigint;
  /** Rate the current period would apply if accrued now: WAD per hour, positive = longs pay shorts. */
  fundingRate?: bigint;
  /** Unix seconds of the last funding accrual. */
  lastFundingTime?: bigint;
  /** Cumulative funding index, USD-WAD per unit of base. */
  cumulativeFunding?: bigint;
  openInterest?: { longs: bigint; shorts: bigint }; // base, WAD
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

async function fetchMarket(exchange: `0x${string}`, marketId: number): Promise<ChainMarket> {
  const base = { abi: exchangeAbi, address: exchange, chainId, args: [marketId] } as const;
  const [params, indexPrice, markPrice, markTwap, fundingRate, lastFundingTime, cumulativeFunding, openInterest] = await readAll([
    readContract(wagmiConfig, { ...base, functionName: "getMarket" }),
    readContract(wagmiConfig, { ...base, functionName: "indexPrice" }),
    readContract(wagmiConfig, { ...base, functionName: "markPrice" }),
    readContract(wagmiConfig, { ...base, functionName: "markTwap" }),
    readContract(wagmiConfig, { ...base, functionName: "currentFundingRate" }),
    readContract(wagmiConfig, { ...base, functionName: "lastFundingTime" }),
    readContract(wagmiConfig, { ...base, functionName: "cumulativeFunding" }),
    readContract(wagmiConfig, { ...base, functionName: "openInterest" }),
  ] as const);
  return {
    params,
    indexPrice: indexPrice && indexPrice > 0n ? indexPrice : undefined,
    markPrice: markPrice && markPrice > 0n ? markPrice : undefined,
    markTwap: markTwap && markTwap > 0n ? markTwap : undefined,
    fundingRate,
    lastFundingTime: lastFundingTime && lastFundingTime > 0n ? lastFundingTime : undefined,
    cumulativeFunding,
    openInterest: openInterest ? { longs: openInterest[0], shorts: openInterest[1] } : undefined,
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
  /** USDC units held to cover losses beyond a liquidated account's value. */
  insuranceFund?: bigint;
  /** USDC units of losses nobody covered yet. */
  totalBadDebt?: bigint;
  oracle?: `0x${string}`;
}

// `oracle` is a public variable of Exchange.sol that the shared ABI does not list.
const oracleGetterAbi = parseAbi(["function oracle() view returns (address)"]);

/** Exchange-wide flags: pause state and the fill-price band around the index. */
export function useExchangeStatus() {
  const exchange = config.exchange;
  return useQuery({
    queryKey: [...queryKeys.chain, "status", exchange],
    enabled: !!exchange,
    refetchInterval: Math.max(10_000, POLL_MS),
    queryFn: async (): Promise<ExchangeStatus> => {
      const ex = { abi: exchangeAbi, address: exchange!, chainId } as const;
      const [paused, maxPriceDeviationBps, insuranceFund, totalBadDebt, oracle] = await readAll([
        readContract(wagmiConfig, { ...ex, functionName: "paused" }),
        readContract(wagmiConfig, { ...ex, functionName: "maxPriceDeviationBps" }),
        readContract(wagmiConfig, { ...ex, functionName: "insuranceFund" }),
        readContract(wagmiConfig, { ...ex, functionName: "totalBadDebt" }),
        readContract(wagmiConfig, { abi: oracleGetterAbi, address: exchange!, chainId, functionName: "oracle" }),
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
