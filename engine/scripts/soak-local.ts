// Soak / load test against a LOCAL node and a running engine, through the real REST API.
//
// N simulated traders place, cross and cancel random orders for a while (limit, IOC,
// post-only and reduce-only orders, off-chain and on-chain cancels); optionally one
// account is driven into liquidation so that a running keeper takes its position over
// and unwinds it. At the end the engine's view is compared with the chain. The engine
// may be killed and restarted while this runs: requests without a definite answer are
// repeated with the identical signed order, as the engine's retry contract allows.
//
// Prereqs: a hardhat node with the local deployment (mock USDC with an open mint, mock
// oracle), and the engine started with generous limits, e.g.
//   RATE_LIMIT_PER_MINUTE=10000000 TRADER_ORDERS_PER_MINUTE=0 npm start
// and, for SOAK_LIQUIDATION=true, the keeper (KEEPER_PRIVATE_KEY = hardhat account #1,
// ENGINE_URL set, unwind on).
//
// The script switches the node to interval mining (SOAK_BLOCK_TIME_MS, default 1000):
// with automine a hardhat node creates a block per transaction and advances its clock
// a second per block, which under load makes chain time run far ahead of real time.
//
// Usage:
//   RPC_URL=http://127.0.0.1:8545 ENGINE_URL=http://127.0.0.1:8080 \
//   SOAK_TRADERS=8 SOAK_DURATION_SEC=180 SOAK_RATE=20 SOAK_LIQUIDATION=true npx tsx scripts/soak-local.ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeErrorResult, defineChain, hashTypedData, http, parseAbi, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { CANCEL_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, ERC20_ABI, EXCHANGE_ABI, ORDER_TYPES, type Deployment, type Order } from "../../shared/src/index.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const ENGINE = (process.env.ENGINE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const TRADERS = Number(process.env.SOAK_TRADERS ?? 8);
const DURATION = Number(process.env.SOAK_DURATION_SEC ?? 180);
const RATE = Number(process.env.SOAK_RATE ?? 20); // operations per second, all traders together
const BLOCK_TIME_MS = Number(process.env.SOAK_BLOCK_TIME_MS ?? 1000);
const LIQUIDATION = (process.env.SOAK_LIQUIDATION ?? "false") === "true";
const FIRST_ACCOUNT = Number(process.env.SOAK_FIRST_ACCOUNT ?? 10); // hardhat accounts 10.. are the traders
// Activity floors: a run in which next to nothing happened proves nothing.
const MIN_ACCEPTED = Number(process.env.SOAK_MIN_ACCEPTED ?? Math.floor(RATE * DURATION * 0.3));
const MIN_FILLS = Number(process.env.SOAK_MIN_FILLS ?? Math.floor(RATE * DURATION * 0.05));
const dep: Deployment = JSON.parse(
  readFileSync(process.env.DEPLOYMENT_PATH ?? new URL("../../contracts/deployments/localhost.json", import.meta.url), "utf8"),
);
if (dep.chainId !== 31337) throw new Error("soak-local.ts mints mock USDC and only runs against a local chain (31337)");

const chain = defineChain({ id: dep.chainId, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 200 }) as PublicClient;
const abi = parseAbi(EXCHANGE_ABI);
const erc20 = parseAbi(ERC20_ABI);
const oracleAbi = parseAbi(["function setPrice(uint32 marketId, uint256 priceWad)"]);
const domain = { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: dep.chainId, verifyingContract: dep.exchange } as const;
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const traders = Array.from({ length: TRADERS }, (_, i) => account(FIRST_ACCOUNT + i));
type Trader = (typeof traders)[number];
const owner = account(0); // deployer: may set the mock oracle
const keeper = account(1); // the keeper process is expected to run with this key
const victim = account(FIRST_ACCOUNT + TRADERS); // driven into liquidation
const LIQ_MARKET = dep.markets[0]!.marketId;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
let seed = Number(process.env.SOAK_SEED ?? 12345);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const abs = (x: bigint) => (x < 0n ? -x : x);
const rpc = async (method: string, params: unknown[] = []) =>
  (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

interface Sent {
  order: Order;
  hash: `0x${string}`;
  signature: `0x${string}`;
  trader: Trader;
  accepted: boolean;
  /** Last status the engine reported for it. */
  status?: string;
  /** filled + pending the engine reported when it acknowledged an off-chain cancel. */
  cancelAck?: bigint;
  /** on-chain filledSize right after the trader's on-chain cancelOrder was mined. */
  onChainCancel?: bigint;
}
const sent = new Map<string, Sent>();
const stats = {
  operations: 0,
  ordersAccepted: 0,
  ordersWithFills: 0,
  reduceOnlyAccepted: 0,
  duplicateAnswers: 0,
  retriesAfterNoAnswer: 0,
  cancelsOk: 0,
  onChainCancels: 0,
  rejected: {} as Record<string, number>,
  cancelRefused: {} as Record<string, number>,
  acceptedStatus: {} as Record<string, number>,
  closedReason: {} as Record<string, number>,
  latenciesMs: [] as number[],
};
const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);

type Reply = { status: number; body: any } | null;
async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(`${ENGINE}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: j(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.json() };
  } catch {
    return null; // engine down, connection reset, timeout
  }
}

/** POST /orders until there is a definite answer (the identical order is safe to repeat). */
async function submit(s: Sent, flags: { ioc?: boolean; postOnly?: boolean }, giveUpAt: number): Promise<Reply> {
  for (;;) {
    const t0 = Date.now();
    const r = await call("POST", "/orders", { order: s.order, signature: s.signature, ...flags });
    if (r && (r.status === 200 || r.body?.error?.outcome === "not_applied")) {
      stats.latenciesMs.push(Date.now() - t0);
      return r;
    }
    stats.retriesAfterNoAnswer++;
    if (Date.now() > giveUpAt) return r;
    await sleep(500);
  }
}

let markets: { marketId: number; indexPrice: bigint; minOrderSize: bigint }[] = [];
/** The engine's clock for order expiry (it follows chain time when that runs ahead). */
let engineTime = BigInt(Math.floor(Date.now() / 1000));
async function refreshMarkets(): Promise<void> {
  const r = await call("GET", "/markets");
  if (r?.status === 200) {
    markets = (r.body as any[]).filter((m) => m.indexPrice !== null && m.active).map((m) => ({ marketId: m.marketId, indexPrice: BigInt(m.indexPrice), minOrderSize: BigInt(m.minOrderSize) }));
  }
  const h = await call("GET", "/health");
  if (h?.body?.time) engineTime = BigInt(h.body.time);
}

/** Every trade the engine ever reported, by its id. */
const trades = new Map<string, any>();
async function collectTrades(): Promise<void> {
  for (const m of dep.markets) {
    const r = await call("GET", `/trades/${m.marketId}?limit=200`);
    if (r?.status === 200) for (const t of r.body as any[]) trades.set(t.id, t);
  }
}

let nonceCounter = 0n;
const nextNonce = () => (BigInt(Date.now()) << 64n) | nonceCounter++;

async function place(t: Trader, o: Omit<Order, "trader" | "nonce">, flags: { ioc?: boolean; postOnly?: boolean }, giveUpAt: number): Promise<Sent> {
  const order: Order = { ...o, trader: t.address, nonce: nextNonce() };
  const signature = await t.signTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: order });
  const hash = hashTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: order });
  const s: Sent = { order, hash, signature, trader: t, accepted: false };
  sent.set(hash, s);
  const r = await submit(s, flags, giveUpAt);
  if (!r) return bump(stats.rejected, "NO_ANSWER"), s;
  if (r.status !== 200) return bump(stats.rejected, r.body?.error?.code ?? `HTTP_${r.status}`), s;
  if (r.body.orderHash !== hash) throw new Error(`engine computed another order hash: ${r.body.orderHash} vs ${hash}`);
  s.accepted = true;
  s.status = r.body.status;
  stats.ordersAccepted++;
  if (order.reduceOnly) stats.reduceOnlyAccepted++;
  if (r.body.duplicate) stats.duplicateAnswers++;
  if (r.body.fills.length > 0) stats.ordersWithFills++;
  bump(stats.acceptedStatus, r.body.status);
  if (r.body.reason) bump(stats.closedReason, String(r.body.reason).split(":")[0]!);
  return s;
}

async function placeRandom(t: Trader, giveUpAt: number): Promise<void> {
  if (markets.length === 0) return;
  const m = pick(markets);
  const step = m.indexPrice / 2000n; // 0.05% of the index
  const k = BigInt(Math.floor(rnd() * 17) - 8); // -8 .. +8 steps
  const expiry = engineTime + BigInt(rnd() < 0.05 ? 100 : 3600);
  const x = rnd();
  const flags = x < 0.15 ? { ioc: true } : x < 0.25 ? { postOnly: true } : {};
  // Now and then: a reduce-only order against the trader's on-chain position.
  if (rnd() < 0.1) {
    const position = (await pub.readContract({ address: dep.exchange, abi, functionName: "getPosition", args: [t.address, m.marketId] })).size;
    if (abs(position) >= m.minOrderSize) {
      const size = abs(position) / 2n >= m.minOrderSize && rnd() < 0.5 ? abs(position) / 2n : abs(position);
      const isBuy = position < 0n;
      await place(t, { marketId: m.marketId, isBuy, reduceOnly: true, size, limitPrice: m.indexPrice + (isBuy ? 2n : -2n) * step, expiry }, {}, giveUpAt);
      return;
    }
  }
  await place(
    t,
    { marketId: m.marketId, isBuy: rnd() < 0.5, reduceOnly: false, size: m.minOrderSize * BigInt(1 + Math.floor(rnd() * 20)), limitPrice: m.indexPrice + k * step, expiry },
    flags,
    giveUpAt,
  );
}

const resting = (t: Trader) => [...sent.values()].filter((s) => s.trader === t && s.accepted && (s.status === "open" || s.status === "partially_filled") && !s.onChainCancel && s.cancelAck === undefined);

async function cancelRandom(t: Trader): Promise<void> {
  const mine = resting(t);
  if (mine.length === 0) return;
  const s = pick(mine);
  const signature = await t.signTypedData({ domain, types: CANCEL_TYPES, primaryType: "Cancel", message: { trader: t.address, nonce: s.order.nonce } });
  const r = await call("DELETE", `/orders/${s.hash}`, { signature, trader: t.address, nonce: s.order.nonce });
  if (r?.status === 200) {
    stats.cancelsOk++;
    s.status = r.body.status;
    // From here on the order may only gain what was already matched.
    s.cancelAck = BigInt(r.body.filled ?? 0) + BigInt(r.body.pending ?? 0);
  } else bump(stats.cancelRefused, r ? (r.body?.error?.code ?? `HTTP_${r.status}`) : "NO_ANSWER");
}

/** The trader cancels on-chain; the engine has to find out from the event. */
async function cancelOnChain(t: Trader): Promise<void> {
  const mine = resting(t);
  if (mine.length === 0) return;
  const s = pick(mine);
  s.onChainCancel = -1n; // being cancelled: no further off-chain cancel for it
  const w = createWalletClient({ account: t, chain, transport: http(RPC) });
  const hash = await w.writeContract({ address: dep.exchange, abi, functionName: "cancelOrder", args: [s.order.nonce] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  // After its cancel block nothing more can fill it on-chain.
  s.onChainCancel = await pub.readContract({ address: dep.exchange, abi, functionName: "filledSize", args: [s.hash], blockNumber: receipt.blockNumber });
  stats.onChainCancels++;
}

async function send(a: Trader, address: `0x${string}`, contractAbi: any, functionName: string, args: unknown[]): Promise<void> {
  const w = createWalletClient({ account: a, chain, transport: http(RPC) });
  const hash = await w.writeContract({ address, abi: contractAbi, functionName, args } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted for ${a.address}`);
}

async function fund(t: Trader, usdc: string): Promise<void> {
  const want = parseUnits(usdc, 6);
  const have = await pub.readContract({ address: dep.exchange, abi, functionName: "balanceOf", args: [t.address] });
  if (have >= want / 2n) return;
  await send(t, dep.usdc, erc20, "mint", [t.address, want]);
  await send(t, dep.usdc, erc20, "approve", [dep.exchange, want]);
  await send(t, dep.exchange, abi, "deposit", [want]);
}

const positionOf = async (a: `0x${string}`, marketId: number) => (await pub.readContract({ address: dep.exchange, abi, functionName: "getPosition", args: [a, marketId] })).size;

/** One account takes a leveraged long; later the index falls 20% and it becomes liquidatable. */
const liquidation = { opened: 0n, priceMoved: false };
async function openVictimPosition(giveUpAt: number): Promise<void> {
  const m = markets.find((x) => x.marketId === LIQ_MARKET);
  if (!m) return;
  // 2,000 USDC of collateral, ~9,750 of notional at 20% initial margin.
  const size = (parseUnits("9750", 18) * 10n ** 18n) / m.indexPrice;
  for (let i = 0; i < 20 && liquidation.opened < (size * 9n) / 10n; i++) {
    const left = size - liquidation.opened;
    if (left < m.minOrderSize) break;
    await place(victim, { marketId: LIQ_MARKET, isBuy: true, reduceOnly: false, size: left, limitPrice: m.indexPrice + (m.indexPrice * 30n) / 10_000n, expiry: engineTime + 3600n }, { ioc: true }, giveUpAt);
    await sleep(1500);
    liquidation.opened = await positionOf(victim.address, LIQ_MARKET);
  }
}
async function dropIndex(): Promise<void> {
  const m = markets.find((x) => x.marketId === LIQ_MARKET);
  if (!m) return;
  await send(owner, dep.oracle, oracleAbi, "setPrice", [LIQ_MARKET, (m.indexPrice * 80n) / 100n]);
  liquidation.priceMoved = true;
}

async function main(): Promise<void> {
  console.log(`soak: ${TRADERS} traders, ${DURATION} s, ~${RATE} ops/s, block time ${BLOCK_TIME_MS} ms, liquidation ${LIQUIDATION}, engine ${ENGINE}, rpc ${RPC}`);
  if (BLOCK_TIME_MS > 0) {
    await rpc("evm_setAutomine", [false]);
    await rpc("evm_setIntervalMining", [BLOCK_TIME_MS]);
  }
  const startBlock = await pub.getBlockNumber();
  await Promise.all(traders.map((t) => fund(t, "500000")));
  if (LIQUIDATION) await Promise.all([fund(victim, "2000"), fund(keeper, "50000")]);
  await refreshMarkets();
  if (markets.length === 0) throw new Error("the engine reports no live market (is it running and past recovery?)");

  const startedAt = Date.now();
  const deadline = startedAt + DURATION * 1000;
  const giveUpAt = deadline + 120_000;
  let running = true;
  const background = (async () => {
    while (running) {
      await refreshMarkets();
      await collectTrades();
      await sleep(700);
    }
  })();
  const scenario = (async () => {
    if (!LIQUIDATION) return;
    await sleep(DURATION * 1000 * 0.15);
    await openVictimPosition(giveUpAt);
    await sleep(Math.max(0, startedAt + DURATION * 1000 * 0.45 - Date.now()));
    await dropIndex();
  })();
  const pause = (TRADERS * 1000) / RATE;
  await Promise.all(
    traders.map(async (t, i) => {
      await sleep((pause * i) / TRADERS);
      while (Date.now() < deadline) {
        const t0 = Date.now();
        stats.operations++;
        const x = rnd();
        try {
          if (x < 0.1) await cancelRandom(t);
          else if (x < 0.115) await cancelOnChain(t);
          else await placeRandom(t, giveUpAt);
        } catch (e) {
          bump(stats.rejected, `SCRIPT_ERROR ${String((e as Error).message).slice(0, 60)}`);
        }
        await sleep(Math.max(0, pause - (Date.now() - t0)));
      }
    }),
  );
  await scenario;
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`load phase done after ${elapsed.toFixed(0)} s; waiting for settlement to drain`);

  // ---- settle down (and, with a keeper, let it finish unwinding: someone must take the other side)
  let health: any = null;
  const liqMin = markets.find((x) => x.marketId === LIQ_MARKET)?.minOrderSize ?? 0n;
  for (let i = 0; i < 360; i++) {
    health = (await call("GET", "/health"))?.body ?? null;
    const drained = health && health.ok && health.settlement.queued === 0 && health.settlement.inFlight === 0;
    let unwound = true;
    if (LIQUIDATION && liquidation.priceMoved) {
      const kp = await positionOf(keeper.address, LIQ_MARKET);
      unwound = abs(kp) < liqMin && (await positionOf(victim.address, LIQ_MARKET)) === 0n;
      if (!unwound && drained && i % 4 === 0) {
        // a counterparty for the keeper's reduce-only order
        const m = markets.find((x) => x.marketId === LIQ_MARKET);
        if (m && kp !== 0n) await place(traders[0]!, { marketId: LIQ_MARKET, isBuy: kp > 0n, reduceOnly: false, size: abs(kp), limitPrice: m.indexPrice, expiry: engineTime + 3600n }, { ioc: true }, Date.now() + 5000);
      }
    }
    if (drained && unwound) break;
    await sleep(500);
  }
  await sleep(3000); // let the last on-chain cancel events reach the engine
  running = false;
  await background;
  await collectTrades();
  health = (await call("GET", "/health"))?.body ?? health;

  // ---- checks
  const problems: string[] = [];
  const fail = (msg: string) => {
    if (problems.length < 30) problems.push(msg);
    else if (problems.length === 30) problems.push("... more");
  };
  const head = await pub.getBlockNumber();
  const fillLogs = await pub.getContractEvents({ address: dep.exchange, abi, eventName: "Fill", fromBlock: startBlock, toBlock: head, strict: true });
  const failedLogs = await pub.getContractEvents({ address: dep.exchange, abi, eventName: "MatchFailed", fromBlock: startBlock, toBlock: head, strict: true });
  const liquidations = await pub.getContractEvents({ address: dep.exchange, abi, eventName: "Liquidation", fromBlock: startBlock, toBlock: head, strict: true });

  // 0. activity floors
  if (stats.ordersAccepted < MIN_ACCEPTED) fail(`only ${stats.ordersAccepted} orders were accepted (floor ${MIN_ACCEPTED}): the run exercised too little`);
  if (fillLogs.length < MIN_FILLS) fail(`only ${fillLogs.length} fills on-chain (floor ${MIN_FILLS})`);
  if (stats.cancelsOk === 0) fail("no cancel was acknowledged");
  if (stats.reduceOnlyAccepted === 0) fail("no reduce-only order was accepted");
  if (stats.onChainCancels === 0) fail("no on-chain cancel happened");

  // 1. engine trades and on-chain Fill events correspond one to one, both ways
  const keyOf = (tx: string, maker: string, taker: string, size: bigint | string, price: bigint | string) => `${tx}:${maker}:${taker}:${size}:${price}`.toLowerCase();
  const onChainFills = new Map<string, number>();
  for (const l of fillLogs) {
    const k = keyOf(l.transactionHash, l.args.makerOrderHash, l.args.takerOrderHash, l.args.size, l.args.price);
    onChainFills.set(k, (onChainFills.get(k) ?? 0) + 1);
  }
  const engineFills = new Map<string, number>();
  const engineFilled = new Map<string, bigint>();
  for (const t of trades.values()) {
    const k = keyOf(t.txHash, t.makerOrderHash, t.takerOrderHash, t.size, t.price);
    engineFills.set(k, (engineFills.get(k) ?? 0) + 1);
    for (const h of [t.makerOrderHash, t.takerOrderHash]) engineFilled.set(h.toLowerCase(), (engineFilled.get(h.toLowerCase()) ?? 0n) + BigInt(t.size));
  }
  for (const [k, n] of engineFills) if ((onChainFills.get(k) ?? 0) !== n) fail(`engine reported ${n} trade(s) ${k.slice(0, 80)}.. but the chain has ${onChainFills.get(k) ?? 0}`);
  for (const [k, n] of onChainFills) if ((engineFills.get(k) ?? 0) !== n) fail(`chain has ${n} Fill(s) ${k.slice(0, 80)}.. but the engine reported ${engineFills.get(k) ?? 0}`);

  // 2. every order, including short-lived ones the engine has already forgotten:
  //    what the engine reported as filled (its trades) equals on-chain filledSize
  let checked = 0;
  let forgotten = 0;
  let restingAtEnd = 0;
  const book = new Map<string, bigint>(); // market:side:price -> resting size, rebuilt from order states
  for (const s of sent.values()) {
    const onChain = await pub.readContract({ address: dep.exchange, abi, functionName: "filledSize", args: [s.hash] });
    const byTrades = engineFilled.get(s.hash.toLowerCase()) ?? 0n;
    if (byTrades !== onChain) fail(`order ${s.hash}: engine trades add up to ${byTrades}, on-chain filledSize is ${onChain}`);
    if (!s.accepted) {
      if (onChain !== 0n) fail(`order ${s.hash} was refused by the engine but has fills on-chain`);
      continue;
    }
    // The identical order again: the engine answers with its current state and changes nothing.
    const r = await call("POST", "/orders", { order: s.order, signature: s.signature });
    if (r?.status === 400 && r.body?.error?.code === "EXPIRED") {
      forgotten++; // finished and past its expiry: forgotten by the engine. Its fills were checked above.
      continue;
    }
    if (r?.status !== 200 || r.body.duplicate !== true) {
      fail(`order ${s.hash}: resubmission did not return its state (${r?.status} ${j(r?.body).slice(0, 120)})`);
      continue;
    }
    checked++;
    const e = r.body;
    const isResting = e.status === "open" || e.status === "partially_filled";
    if (BigInt(e.pending) !== 0n) fail(`order ${s.hash}: engine still shows pending ${e.pending} after settlement drained`);
    if (BigInt(e.filled) !== onChain) fail(`order ${s.hash}: engine filled ${e.filled} != on-chain ${onChain} (status ${e.status})`);
    if (BigInt(e.remaining) + BigInt(e.filled) > s.order.size) fail(`order ${s.hash}: remaining + filled exceeds its size`);
    if (isResting && BigInt(e.remaining) + BigInt(e.filled) !== s.order.size) fail(`order ${s.hash}: resting order does not add up`);
    if (!isResting && BigInt(e.remaining) !== 0n) fail(`order ${s.hash}: status ${e.status} with remaining ${e.remaining}`);
    if (e.status === "filled" && onChain !== s.order.size) fail(`order ${s.hash}: engine says filled, chain has ${onChain} of ${s.order.size}`);
    // cancels are final
    if (s.cancelAck !== undefined) {
      if (isResting) fail(`order ${s.hash}: cancel was acknowledged but the order is ${e.status}`);
      if (onChain > s.cancelAck) fail(`order ${s.hash}: filled ${onChain} on-chain, more than the ${s.cancelAck} that was filled or matched when its cancel was acknowledged`);
    }
    if (s.onChainCancel !== undefined && s.onChainCancel >= 0n) {
      if (isResting) fail(`order ${s.hash}: cancelled on-chain but still ${e.status} in the engine`);
      if (onChain !== s.onChainCancel) fail(`order ${s.hash}: filledSize moved after its on-chain cancel`);
    }
    if (isResting) {
      restingAtEnd++;
      const k = `${s.order.marketId}:${s.order.isBuy ? "bids" : "asks"}:${s.order.limitPrice}`;
      book.set(k, (book.get(k) ?? 0n) + BigInt(e.remaining));
    }
  }
  if (checked + forgotten < stats.ordersAccepted * 0.95) fail(`only ${checked + forgotten} of ${stats.ordersAccepted} accepted orders could be checked`);

  // 3. the engine's book is exactly the resting orders (this run's, plus the keeper's
  //    unwind order if one is working). Orders can still expire while this is being
  //    checked, so the comparison is made on a consistent snapshot: the books are read,
  //    then the state of every resting order, then the books again - and it only counts
  //    if the books did not change in between.
  const restingOrders = [...sent.values()].filter((s) => book.has(`${s.order.marketId}:${s.order.isBuy ? "bids" : "asks"}:${s.order.limitPrice}`));
  const readBooks = async () => {
    const out = new Map<number, any>();
    for (const m of dep.markets) out.set(m.marketId, (await call("GET", `/orderbook/${m.marketId}?depth=500`))?.body ?? null);
    return out;
  };
  let bookChecked = false;
  for (let attempt = 0; attempt < 6 && !bookChecked; attempt++) {
    const before = await readBooks();
    const levels = new Map<string, bigint>();
    for (const s of restingOrders) {
      const r = await call("POST", "/orders", { order: s.order, signature: s.signature });
      if (r?.status !== 200) continue;
      const rem = BigInt(r.body.remaining);
      if (rem > 0n) {
        const k = `${s.order.marketId}:${s.order.isBuy ? "bids" : "asks"}:${s.order.limitPrice}`;
        levels.set(k, (levels.get(k) ?? 0n) + rem);
      }
    }
    for (const o of ((await call("GET", `/orders?trader=${keeper.address}`))?.body ?? []) as any[]) {
      const k = `${o.order.marketId}:${o.order.isBuy ? "bids" : "asks"}:${o.order.limitPrice}`;
      levels.set(k, (levels.get(k) ?? 0n) + BigInt(o.remaining));
    }
    const after = await readBooks();
    if (j([...before]) !== j([...after])) continue; // something moved meanwhile: take another snapshot
    bookChecked = true;
    for (const m of dep.markets) {
      const ob = after.get(m.marketId);
      if (!ob) {
        fail(`no order book for market ${m.marketId}`);
        continue;
      }
      if (ob.bids[0] && ob.asks[0] && BigInt(ob.bids[0].price) >= BigInt(ob.asks[0].price)) fail(`market ${m.marketId}: book is crossed`);
      const seen = new Set<string>();
      for (const side of ["bids", "asks"] as const) {
        for (const level of ob[side] as { price: string; size: string }[]) {
          const k = `${m.marketId}:${side}:${level.price}`;
          seen.add(k);
          if (BigInt(level.size) !== (levels.get(k) ?? 0n)) fail(`book level ${k}: engine shows ${level.size}, the orders add up to ${levels.get(k) ?? 0n}`);
        }
      }
      for (const [k, size] of levels) {
        const side = k.split(":")[1] as "bids" | "asks";
        if (k.startsWith(`${m.marketId}:`) && size > 0n && !seen.has(k) && ob[side].length < 500) fail(`book level ${k} (${size}) is missing from the engine's book`);
      }
    }
  }
  if (!bookChecked) fail("the order book kept changing: no consistent snapshot to compare with the orders");

  // 4. liquidation and unwind
  let keeperPosition: bigint | null = null;
  if (LIQUIDATION) {
    keeperPosition = await positionOf(keeper.address, LIQ_MARKET);
    if (liquidation.opened === 0n) fail("the liquidation candidate never got a position");
    if (!liquidations.some((l) => l.args.trader === victim.address)) fail("the under-margined account was not liquidated (is the keeper running?)");
    if ((await positionOf(victim.address, LIQ_MARKET)) !== 0n) fail("the liquidated account still has a position");
    if (abs(keeperPosition) >= liqMin) fail(`the keeper still holds ${keeperPosition}: the position it took over was not unwound`);
    const failedForKeeper = failedLogs.filter((l) => sent.get(l.args.makerOrderHash) === undefined || sent.get(l.args.takerOrderHash) === undefined).length;
    if (failedForKeeper > 3) fail(`${failedForKeeper} failed matches involved an order that is not this run's (the keeper's)`);
  }

  // 5. engine health
  if (!health?.ok) fail(`engine /health not ok at the end: ${j(health).slice(0, 300)}`);
  if (health && (health.settlement.queued !== 0 || health.settlement.inFlight !== 0)) fail("settlement queue did not drain");

  // ---- contract-level sanity (the contract enforces these by itself; listed apart from the engine checks)
  const chainSanity: string[] = [];
  const filledByLogs = new Map<string, bigint>();
  for (const l of fillLogs) for (const h of [l.args.makerOrderHash, l.args.takerOrderHash]) filledByLogs.set(h, (filledByLogs.get(h) ?? 0n) + l.args.size);
  for (const s of sent.values()) {
    const logged = filledByLogs.get(s.hash) ?? 0n;
    if (logged > s.order.size) chainSanity.push(`order ${s.hash} overfilled on-chain`);
  }
  const accounts = new Set<`0x${string}`>(traders.map((t) => t.address));
  for (const l of await pub.getContractEvents({ address: dep.exchange, abi, eventName: "Fill", fromBlock: 0n, toBlock: head, strict: true })) {
    accounts.add(l.args.maker);
    accounts.add(l.args.taker);
  }
  for (const l of await pub.getContractEvents({ address: dep.exchange, abi, eventName: "Liquidation", fromBlock: 0n, toBlock: head, strict: true })) {
    accounts.add(l.args.trader);
    accounts.add(l.args.liquidator);
  }
  for (const m of dep.markets) {
    let sum = 0n;
    for (const a of accounts) sum += await positionOf(a, m.marketId);
    if (sum !== 0n) chainSanity.push(`market ${m.marketId}: positions sum to ${sum}`);
    const [longs, shorts] = await pub.readContract({ address: dep.exchange, abi, functionName: "openInterest", args: [m.marketId] });
    if (longs !== shorts) chainSanity.push(`market ${m.marketId}: open interest longs ${longs} != shorts ${shorts}`);
  }
  for (const c of chainSanity) fail(`[contract-level] ${c}`);

  // ---- report
  const failedBy: Record<string, number> = {};
  for (const l of failedLogs) {
    let name = l.args.reason.slice(0, 10);
    try {
      name = decodeErrorResult({ abi, data: l.args.reason }).errorName;
    } catch {
      // unknown selector: keep it
    }
    bump(failedBy, name);
  }
  const lat = [...stats.latenciesMs].sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  const report = {
    durationSec: Math.round(elapsed),
    traders: TRADERS,
    blockTimeMs: BLOCK_TIME_MS,
    operations: stats.operations,
    ordersSent: sent.size,
    ordersAccepted: stats.ordersAccepted,
    ordersAcceptedPerSec: +(stats.ordersAccepted / elapsed).toFixed(2),
    reduceOnlyOrdersAccepted: stats.reduceOnlyAccepted,
    ordersWithImmediateFills: stats.ordersWithFills,
    acceptedStatus: stats.acceptedStatus,
    closedOnArrivalBy: stats.closedReason,
    refusedByCode: stats.rejected,
    cancelsAcknowledged: stats.cancelsOk,
    cancelsRefusedByCode: stats.cancelRefused,
    onChainCancels: stats.onChainCancels,
    retriesAfterNoAnswer: stats.retriesAfterNoAnswer,
    duplicateAnswersToRetries: stats.duplicateAnswers,
    postLatencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat[lat.length - 1] ?? 0 },
    onChain: {
      fills: fillLogs.length,
      fillsPerSec: +(fillLogs.length / elapsed).toFixed(2),
      matchFailed: failedLogs.length,
      matchFailedByReason: failedBy,
      settlementTransactions: new Set([...fillLogs, ...failedLogs].map((l) => l.transactionHash)).size,
      liquidations: liquidations.length,
    },
    engineTrades: trades.size,
    ordersCheckedAgainstEngineState: checked,
    ordersForgottenByEngineAfterExpiry: forgotten,
    ordersRestingAtEnd: restingAtEnd,
    liquidation: LIQUIDATION ? { victimPositionOpened: liquidation.opened, indexDropped: liquidation.priceMoved, keeperPositionAtEnd: keeperPosition } : "off",
    engineHealthOk: !!health?.ok,
    healthWarnings: health?.warnings ?? null,
    contractLevelSanity: chainSanity.length === 0 ? "ok" : chainSanity,
    invariantsHeld: problems.length === 0,
    problems,
  };
  console.log(JSON.stringify(JSON.parse(j(report)), null, 2));
  console.log(problems.length === 0 ? "\nSOAK PASSED: all invariants held" : `\nSOAK FAILED: ${problems.length} problem(s)`);
  if (BLOCK_TIME_MS > 0) {
    await rpc("evm_setIntervalMining", [0]);
    await rpc("evm_setAutomine", [true]);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
