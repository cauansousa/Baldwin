import { privateKeyToAccount } from "viem/accounts";
import { CANCEL_TYPES, ORDER_TYPES, WAD } from "../../shared/src/index.ts";
import type { ChainReader } from "../src/chain/types.ts";
import { Engine, type EngineOptions } from "../src/engine/engine.ts";
import { FakeSettler } from "../src/settlement/fakeSettler.ts";
import { eip712Domain, type Domain } from "../src/signing.ts";
import type { Address, Hex, MarketConfig, Order } from "../src/types.ts";

export const DOMAIN: Domain = { chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" };

// Hardhat's well-known test keys.
export const alice = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const bob = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const carol = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
export type TestAccount = typeof alice;

export const wad = (n: number | string): bigint => {
  const [i, f = ""] = String(n).split(".");
  return BigInt(i!) * WAD + BigInt(f.padEnd(18, "0").slice(0, 18) || "0");
};

export const MARKET: MarketConfig = {
  marketId: 1,
  symbol: "BTC-USD",
  active: true,
  minOrderSize: wad("0.01"),
  maxOpenInterest: wad(1000),
  initialMarginBps: 2000n,
  maintenanceMarginBps: 1000n,
  makerFeeBps: 2n,
  takerFeeBps: 5n,
};

/** The test clock starts at 1000; orders live for a day unless a test says otherwise. */
export const DEFAULT_EXPIRY = 1_000n + 86_400n;

let nonce = 1n;
export function makeOrder(trader: TestAccount, isBuy: boolean, price: number | string, size: number | string, extra: Partial<Order> = {}): Order {
  return {
    trader: trader.address,
    marketId: MARKET.marketId,
    isBuy,
    reduceOnly: false,
    size: wad(size),
    limitPrice: wad(price),
    nonce: nonce++,
    expiry: DEFAULT_EXPIRY,
    ...extra,
  };
}

export function signOrder(account: TestAccount, order: Order, domain: Domain = DOMAIN): Promise<Hex> {
  return account.signTypedData({ domain: eip712Domain(domain), types: ORDER_TYPES, primaryType: "Order", message: order });
}

export function signCancel(account: TestAccount, trader: Address, n: bigint, domain: Domain = DOMAIN): Promise<Hex> {
  return account.signTypedData({ domain: eip712Domain(domain), types: CANCEL_TYPES, primaryType: "Cancel", message: { trader, nonce: n } });
}

/** In-memory ChainReader: healthy accounts by default. */
export class FakeChain implements ChainReader {
  cancelled = new Set<string>();
  filled = new Map<Hex, bigint>();
  free = new Map<string, bigint>();
  positions = new Map<string, bigint>();
  index = wad(100);
  time = 1_000n;
  defaultFree = 10n ** 12n; // 1,000,000 USDC
  fail = false;

  private check() {
    if (this.fail) throw new Error("rpc down");
  }
  async isCancelled(trader: Address, n: bigint) {
    this.check();
    return this.cancelled.has(`${trader.toLowerCase()}:${n}`);
  }
  async filledSize(hash: Hex) {
    this.check();
    return this.filled.get(hash) ?? 0n;
  }
  async freeCollateral(trader: Address) {
    this.check();
    return this.free.get(trader.toLowerCase()) ?? this.defaultFree;
  }
  async positionSize(trader: Address, marketId: number) {
    this.check();
    return this.positions.get(`${trader.toLowerCase()}:${marketId}`) ?? 0n;
  }
  async indexPrice() {
    this.check();
    if (this.indexFails) throw new Error("StalePrice");
    return this.index;
  }
  async blockTimestamp() {
    this.check();
    return this.time;
  }
  isPaused = false;
  deviationBps = 500n;
  oi = { longs: 0n, shorts: 0n };
  indexFails = false;
  market: MarketConfig = MARKET;
  async paused() {
    this.check();
    return this.isPaused;
  }
  async maxPriceDeviationBps() {
    this.check();
    return this.deviationBps;
  }
  async openInterest() {
    this.check();
    return this.oi;
  }
  async getMarket(marketId: number) {
    this.check();
    return { ...this.market, marketId };
  }
}

export interface Harness {
  engine: Engine;
  settler: FakeSettler;
  chain: FakeChain;
  clock: { now: number };
  /** Sign and submit. */
  place(account: TestAccount, isBuy: boolean, price: number | string, size: number | string, opts?: { postOnly?: boolean; ioc?: boolean; order?: Partial<Order> }): ReturnType<Engine["submit"]>;
}

export function harness(opts: Partial<EngineOptions> & { withChain?: boolean } = {}): Harness {
  const settler = new FakeSettler();
  const chain = new FakeChain();
  const clock = { now: 1_000 };
  const { withChain, ...rest } = opts;
  const engine = new Engine({
    domain: DOMAIN,
    markets: [MARKET],
    settler,
    ...(withChain ? { chain } : {}),
    now: () => clock.now,
    retryDelayMs: 1,
    // Tests that are about expiry timing set these themselves.
    expiryBufferSec: 5,
    minTimeToExpirySec: 0,
    ...rest,
  });
  return {
    engine,
    settler,
    chain,
    clock,
    async place(account, isBuy, price, size, o = {}) {
      const order = makeOrder(account, isBuy, price, size, o.order);
      return engine.submit({ order, signature: await signOrder(account, order), postOnly: o.postOnly, ioc: o.ioc });
    },
  };
}
