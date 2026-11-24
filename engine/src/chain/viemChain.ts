import type { PublicClient } from "viem";
import { exchangeAbi } from "../abi.ts";
import type { Address, Hex, MarketConfig } from "../types.ts";
import type { ChainReader } from "./types.ts";

/** ChainReader backed by a viem public client. */
export class ViemChainReader implements ChainReader {
  /** Symbols from the deployment file, used when the contract returns an empty one. */
  private readonly symbols = new Map<number, string>();

  constructor(private readonly client: PublicClient, private readonly exchange: Address, symbols: { marketId: number; symbol: string }[] = []) {
    for (const s of symbols) this.symbols.set(s.marketId, s.symbol);
  }

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

  paused(): Promise<boolean> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "paused" });
  }
  maxPriceDeviationBps(): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "maxPriceDeviationBps" });
  }
  async openInterest(marketId: number): Promise<{ longs: bigint; shorts: bigint }> {
    const [longs, shorts] = await this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "openInterest", args: [marketId] });
    return { longs, shorts };
  }
  markTwap(marketId: number): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "markTwap", args: [marketId] });
  }
  currentFundingRate(marketId: number): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "currentFundingRate", args: [marketId] });
  }
  lastFundingTime(marketId: number): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "lastFundingTime", args: [marketId] });
  }
  insuranceFund(): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "insuranceFund" });
  }
  totalBadDebt(): Promise<bigint> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "totalBadDebt" });
  }
  async marketCount(): Promise<number> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "marketCount" });
  }

  isOperator(account: Address): Promise<boolean> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "isOperator", args: [account] });
  }

  async getMarket(marketId: number): Promise<MarketConfig> {
    const m = await this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "getMarket", args: [marketId] });
    return {
      marketId,
      symbol: m.symbol || this.symbols.get(marketId) || `MARKET-${marketId}`,
      active: m.active,
      minOrderSize: m.minOrderSize,
      maxOpenInterest: m.maxOpenInterest,
      initialMarginBps: BigInt(m.initialMarginBps),
      maintenanceMarginBps: BigInt(m.maintenanceMarginBps),
      makerFeeBps: BigInt(m.makerFeeBps),
      takerFeeBps: BigInt(m.takerFeeBps),
    };
  }
}
