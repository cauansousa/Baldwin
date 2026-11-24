import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ContractTransactionReceipt, ContractTransactionResponse, Signature } from "ethers";
import { Exchange, IExchange, MockOracle, MockUSDC } from "../typechain-types";

export const WAD = 10n ** 18n;
export const NOTIONAL_SCALE = 10n ** 30n;
export const BPS = 10_000n;
export const HOUR = 3600;

export const usdc = (n: number | string) => ethers.parseUnits(String(n), 6);
export const wad = (n: number | string) => ethers.parseUnits(String(n), 18);

export const BTC = 0;
export const ETH = 1;
export const BTC_PRICE = wad(50_000);
export const ETH_PRICE = wad(2_000);
export const MAX_PRICE_AGE = HOUR;
export const MAX_FUNDING_RATE_BPS = 10n;
export const MAX_PRICE_DEVIATION_BPS = 500n;

export type Order = IExchange.OrderStruct;
export type Match = IExchange.MatchStruct;

export const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "uint32" },
    { name: "isBuy", type: "bool" },
    { name: "reduceOnly", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};

export function marketConfig(symbol: string, overrides: Partial<IExchange.MarketStruct> = {}): IExchange.MarketStruct {
  return {
    active: true,
    initialMarginBps: 2000,
    maintenanceMarginBps: 1000,
    makerFeeBps: 2,
    takerFeeBps: 5,
    liquidationPenaltyBps: 150,
    maxOpenInterest: wad(100),
    minOrderSize: wad("0.001"),
    symbol,
    ...overrides,
  };
}

export async function deployFixture() {
  const [owner, operator, feeRecipient, alice, bob, carol, dave, liquidator, stranger] = await ethers.getSigners();

  const token = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as unknown as MockUSDC;
  const oracle = (await (await ethers.getContractFactory("MockOracle")).deploy()) as unknown as MockOracle;
  const exchange = (await (
    await ethers.getContractFactory("Exchange")
  ).deploy(
    await token.getAddress(),
    await oracle.getAddress(),
    owner.address,
    feeRecipient.address,
    MAX_PRICE_AGE,
    MAX_FUNDING_RATE_BPS,
    MAX_PRICE_DEVIATION_BPS,
  )) as unknown as Exchange;

  await oracle.setPrice(BTC, BTC_PRICE);
  await oracle.setPrice(ETH, ETH_PRICE);
  await exchange.addMarket(marketConfig("BTC-USD"));
  await exchange.addMarket(marketConfig("ETH-USD", { maxOpenInterest: wad(1000), minOrderSize: wad("0.01") }));
  await exchange.setOperator(operator.address, true);

  for (const s of [alice, bob, carol, dave, liquidator, stranger]) {
    await token.mint(s.address, usdc(10_000_000));
    await token.connect(s).approve(await exchange.getAddress(), ethers.MaxUint256);
  }

  // Orders must expire within 30 days; tests never move time forward by more than a few days.
  const defaultExpiry = (await ethers.provider.getBlock("latest"))!.timestamp + 20 * 24 * HOUR;
  const ctx = new Ctx(exchange, oracle, token, operator, defaultExpiry);
  return { owner, operator, feeRecipient, alice, bob, carol, dave, liquidator, stranger, token, oracle, exchange, ctx };
}

/** Convenience wrapper around the exchange for building, signing and settling orders. */
export class Ctx {
  private nonce = 1n;
  constructor(
    public exchange: Exchange,
    public oracle: MockOracle,
    public token: MockUSDC,
    public operator: HardhatEthersSigner,
    public defaultExpiry: number,
  ) {}

  order(trader: HardhatEthersSigner, isBuy: boolean, size: bigint, limitPrice: bigint, o: Partial<Order> = {}): Order {
    return {
      trader: trader.address,
      marketId: BTC,
      isBuy,
      reduceOnly: false,
      size,
      limitPrice,
      nonce: this.nonce++,
      expiry: this.defaultExpiry,
      ...o,
    };
  }

  async sign(signer: HardhatEthersSigner, order: Order, exchange: Exchange = this.exchange): Promise<string> {
    const domain = {
      name: "Baldwin",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await exchange.getAddress(),
    };
    return signer.signTypedData(domain, ORDER_TYPES, order);
  }

  async match(
    makerSigner: HardhatEthersSigner,
    maker: Order,
    takerSigner: HardhatEthersSigner,
    taker: Order,
    fillSize: bigint,
  ): Promise<Match> {
    return {
      maker,
      makerSig: await this.sign(makerSigner, maker),
      taker,
      takerSig: await this.sign(takerSigner, taker),
      fillSize,
    };
  }

  /** Builds a full fill of `size` at `price`: `buyer` buys from `seller`; the maker is the buyer unless stated. */
  async trade(
    buyer: HardhatEthersSigner,
    seller: HardhatEthersSigner,
    size: bigint,
    price: bigint,
    opts: { marketId?: number; makerIsSeller?: boolean } = {},
  ): Promise<Match> {
    const marketId = opts.marketId ?? BTC;
    const buy = this.order(buyer, true, size, price, { marketId });
    const sell = this.order(seller, false, size, price, { marketId });
    return opts.makerIsSeller ? this.match(seller, sell, buyer, buy, size) : this.match(buyer, buy, seller, sell, size);
  }

  settle(matches: Match[]): Promise<ContractTransactionResponse> {
    return this.exchange.connect(this.operator).settleMatches(matches);
  }

  /** Settles and requires that every match succeeded. */
  async settleOk(matches: Match[]): Promise<ContractTransactionReceipt> {
    const receipt = (await (await this.settle(matches)).wait())!;
    const failed = this.failures(receipt);
    if (failed.length) throw new Error(`matches failed: ${JSON.stringify(failed)}`);
    return receipt;
  }

  /** Settles one match and returns the name of the error it failed with ("" if it succeeded). */
  async settleError(m: Match): Promise<string> {
    const receipt = (await (await this.settle([m])).wait())!;
    const failed = this.failures(receipt);
    return failed.length ? failed[0].error : "";
  }

  failures(receipt: ContractTransactionReceipt): { index: number; error: string }[] {
    const out: { index: number; error: string }[] = [];
    for (const log of receipt.logs) {
      let parsed;
      try {
        parsed = this.exchange.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name !== "MatchFailed") continue;
      const reason: string = parsed.args.reason;
      const err = this.exchange.interface.parseError(reason);
      out.push({ index: Number(parsed.args.index), error: err ? err.name : EXTRA_ERRORS[reason.slice(0, 10)] ?? reason });
    }
    return out;
  }
}

const EXTRA_ERRORS: Record<string, string> = Object.fromEntries(
  ["ECDSAInvalidSignature()", "ECDSAInvalidSignatureLength(uint256)", "ECDSAInvalidSignatureS(bytes32)", "PriceNotSet(uint32)", "OracleBroken()"].map(
    (sig) => [ethers.id(sig).slice(0, 10), sig.slice(0, sig.indexOf("("))],
  ),
);

/** The other valid-looking encoding of the same ECDSA signature (high s). */
export function malleate(sig: string): string {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = Signature.from(sig);
  const highS = ethers.toBeHex(N - BigInt(s.s), 32);
  const v = s.v === 27 ? 28 : 27;
  return ethers.concat([s.r, highS, ethers.toBeHex(v, 1)]);
}

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export const notionalUp = (size: bigint, price: bigint) => ceilDiv(size * price, NOTIONAL_SCALE);
export const notionalDown = (size: bigint, price: bigint) => (size * price) / NOTIONAL_SCALE;
export const feeOf = (size: bigint, price: bigint, bps: bigint) => ceilDiv(notionalUp(size, price) * bps, BPS);
