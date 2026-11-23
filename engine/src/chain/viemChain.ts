import type { PublicClient } from "viem";
import { exchangeAbi } from "../abi.ts";
import type { Address, Hex, MarketConfig } from "../types.ts";
import type { ChainReader } from "./types.ts";

/** ChainReader backed by a viem public client. */
export class ViemChainReader implements ChainReader {
  constructor(private readonly client: PublicClient, private readonly exchange: Address) {}

  isCancelled(trader: Address, nonce: bigint): Promise<boolean> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "isCancelled", args: [trader, nonce] });
  }
  filledSize(orderHash: Hex): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "filledSize", args: [orderHash] });
  }
  freeCollateral(trader: Address): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "freeCollateral", args: [trader] });
  }
  async positionSize(trader: Address, marketId: number): Promise<bigint> {
    const p = await this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "getPosition", args: [trader, marketId] });
    return p.size;
  }
  indexPrice(marketId: number): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "indexPrice", args: [marketId] });
  }
  async blockTimestamp(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: "latest" })).timestamp;
  }

  isOperator(account: Address): Promise<boolean> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "isOperator", args: [account] });
  }

  async getMarket(marketId: number, fallbackSymbol?: string): Promise<MarketConfig> {
    const m = await this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "getMarket", args: [marketId] });
    return {
      marketId,
      symbol: m.symbol || fallbackSymbol || `MARKET-${marketId}`,
      active: m.active,
      minOrderSize: m.minOrderSize,
      initialMarginBps: BigInt(m.initialMarginBps),
      maintenanceMarginBps: BigInt(m.maintenanceMarginBps),
      makerFeeBps: BigInt(m.makerFeeBps),
      takerFeeBps: BigInt(m.takerFeeBps),
    };
  }
}
