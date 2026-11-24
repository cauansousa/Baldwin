import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { engine } from "../api";
import { mergeTrades } from "../api/normalize";
import type { Trade } from "../api/types";

export const BOOK_DEPTH = 25;
const FALLBACK_POLL_MS = 2000;

export const queryKeys = {
  markets: ["engine", "markets"] as const,
  orderBook: (marketId: number) => ["engine", "orderbook", marketId] as const,
  trades: (marketId: number) => ["engine", "trades", marketId] as const,
  openOrders: (trader: string | undefined) => ["engine", "orders", trader?.toLowerCase()] as const,
  chain: ["chain"] as const,
};

/** Engine self-report: settlement health, pause flag and halted markets. Best effort. */
export function useEngineHealth() {
  return useQuery({ queryKey: ["engine", "health"] as const, queryFn: () => engine.getHealth(), refetchInterval: 10_000 });
}

export function useMarkets() {
  // Polled often: the entries also carry prices and funding figures mirrored from the contract.
  return useQuery({ queryKey: queryKeys.markets, queryFn: () => engine.getMarkets(), refetchInterval: 5000 });
}

/**
 * Order book and trades for one market. A REST snapshot is taken on mount and
 * on every WebSocket (re)connect; the socket then keeps the cache fresh. While
 * the socket is down the same queries fall back to polling.
 */
export function useMarketFeed(marketId: number | undefined) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const enabled = marketId !== undefined;
  const id = marketId ?? -1;

  useEffect(() => {
    if (marketId === undefined) return;
    setLive(false);
    const refetch = (key: readonly unknown[]) =>
      void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    return engine.openFeed(marketId, {
      onStatus(connected) {
        setLive(connected);
        if (connected) {
          refetch(queryKeys.orderBook(marketId));
          refetch(queryKeys.trades(marketId));
        }
      },
      onBook(book) {
        if (book) queryClient.setQueryData(queryKeys.orderBook(marketId), book);
        else refetch(queryKeys.orderBook(marketId));
      },
      onTrades(trades) {
        queryClient.setQueryData<Trade[]>(queryKeys.trades(marketId), (old) => mergeTrades(old ?? [], trades));
      },
    });
  }, [marketId, queryClient]);

  const book = useQuery({
    queryKey: queryKeys.orderBook(id),
    queryFn: () => engine.getOrderBook(id, BOOK_DEPTH),
    enabled,
    refetchInterval: live ? false : FALLBACK_POLL_MS,
  });
  const trades = useQuery({
    queryKey: queryKeys.trades(id),
    queryFn: () => engine.getTrades(id),
    enabled,
    refetchInterval: live ? false : FALLBACK_POLL_MS,
  });

  return { live, book, trades };
}

export function useOpenOrders(trader: `0x${string}` | undefined) {
  return useQuery({
    queryKey: queryKeys.openOrders(trader),
    queryFn: () => engine.getOpenOrders(trader!),
    enabled: !!trader,
    refetchInterval: 3000,
  });
}
