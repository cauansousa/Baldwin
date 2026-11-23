import { maxUint256, type Account, type PublicClient, type WalletClient } from "viem";
import { exchangeAbi } from "../abi.ts";
import type { Address } from "../types.ts";
import type { KeeperChain } from "./keeper.ts";

/** KeeperChain backed by viem clients. Transactions are simulated first and awaited until mined. */
export class ViemKeeperChain implements KeeperChain {
  constructor(
    private readonly client: PublicClient,
    private readonly wallet: WalletClient,
    private readonly account: Account,
    private readonly exchange: Address,
  ) {}

  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async touchedPositions(from: bigint, to: bigint): Promise<{ trader: Address; marketId: number }[]> {
    const range = { address: this.exchange, abi: exchangeAbi, fromBlock: from, toBlock: to, strict: true } as const;
    const [fills, liquidations] = await Promise.all([
      this.client.getContractEvents({ ...range, eventName: "Fill" }),
      this.client.getContractEvents({ ...range, eventName: "Liquidation" }),
    ]);
    const out: { trader: Address; marketId: number }[] = [];
    for (const l of fills) {
      out.push({ trader: l.args.maker, marketId: l.args.marketId }, { trader: l.args.taker, marketId: l.args.marketId });
    }
    for (const l of liquidations) out.push({ trader: l.args.trader, marketId: l.args.marketId });
    return out;
  }

  async positionSize(trader: Address, marketId: number): Promise<bigint> {
    const p = await this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "getPosition", args: [trader, marketId] });
    return p.size;
  }

  isLiquidatable(trader: Address): Promise<boolean> {
    return this.client.readContract({ address: this.exchange, abi: exchangeAbi, functionName: "isLiquidatable", args: [trader] });
  }

  async liquidate(trader: Address, marketId: number): Promise<void> {
    const { request } = await this.client.simulateContract({
      account: this.account,
      address: this.exchange,
      abi: exchangeAbi,
      functionName: "liquidate",
      args: [trader, marketId, maxUint256],
    });
    await this.mined(await this.wallet.writeContract(request));
  }

  async updateFunding(marketId: number): Promise<void> {
    const { request } = await this.client.simulateContract({
      account: this.account,
      address: this.exchange,
      abi: exchangeAbi,
      functionName: "updateFunding",
      args: [marketId],
    });
    await this.mined(await this.wallet.writeContract(request));
  }

  private async mined(hash: `0x${string}`): Promise<void> {
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  }
}
