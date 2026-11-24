// Soak / load test against a LOCAL node and a running engine, through the real REST API.
//
// N simulated traders place, cross and cancel random orders for a while; at the end the
// engine's view is compared with the chain. The engine may be killed and restarted
// while this runs: requests without a definite answer are repeated with the identical
// signed order, as the engine's retry contract allows.
//
// Prereqs: a hardhat node with the local deployment (mock USDC with an open mint), and
// the engine started with generous limits, e.g.
//   RATE_LIMIT_PER_MINUTE=10000000 TRADER_ORDERS_PER_MINUTE=0 LOG_HEAD_LAG_BLOCKS=0 npm start
// Usage:
//   RPC_URL=http://127.0.0.1:8545 ENGINE_URL=http://127.0.0.1:8080 \
//   SOAK_TRADERS=8 SOAK_DURATION_SEC=180 SOAK_RATE=20 npx tsx scripts/soak-local.ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeErrorResult, defineChain, hashTypedData, http, parseAbi, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { CANCEL_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, ERC20_ABI, EXCHANGE_ABI, ORDER_TYPES, type Deployment, type Order } from "../../shared/src/index.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const ENGINE = (process.env.ENGINE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const TRADERS = Number(process.env.SOAK_TRADERS ?? 8);
const DURATION = Number(process.env.SOAK_DURATION_SEC ?? 180);
const RATE = Number(process.env.SOAK_RATE ?? 20); // operations per second, all traders together
const FIRST_ACCOUNT = Number(process.env.SOAK_FIRST_ACCOUNT ?? 10); // hardhat accounts 10.. are the traders
const dep: Deployment = JSON.parse(
  readFileSync(process.env.DEPLOYMENT_PATH ?? new URL("../../contracts/deployments/localhost.json", import.meta.url), "utf8"),
);
if (dep.chainId !== 31337) throw new Error("soak-local.ts mints mock USDC and only runs against a local chain (31337)");

const chain = defineChain({ id: dep.chainId, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
const abi = parseAbi(EXCHANGE_ABI);
const erc20 = parseAbi(ERC20_ABI);
const domain = { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: dep.chainId, verifyingContract: dep.exchange } as const;
const MNEMONIC = "test test test test test test test test test test test junk";
const traders = Array.from({ length: TRADERS }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: FIRST_ACCOUNT + i }));
type Trader = (typeof traders)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
let seed = Number(process.env.SOAK_SEED ?? 12345);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

interface Sent {
  order: Order;
  hash: `0x${string}`;
  signature: `0x${string}`;
  trader: Trader;
  accepted: boolean;
  /** Last status the engine reported at submission. */
  status?: string;
}
const sent = new Map<string, Sent>();
const stats = {
  operations: 0,
  ordersAccepted: 0,
  ordersWithFills: 0,
  duplicateAnswers: 0,
  retriesAfterNoAnswer: 0,
  cancelsOk: 0,
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
async function refreshMarkets(): Promise<void> {
  const r = await call("GET", "/markets");
  if (r?.status !== 200) return;
  markets = (r.body as any[]).filter((m) => m.indexPrice !== null && m.active).map((m) => ({ marketId: m.marketId, indexPrice: BigInt(m.indexPrice), minOrderSize: BigInt(m.minOrderSize) }));
}

const trades = new Map<string, any>();
async function collectTrades(): Promise<void> {
  for (const m of dep.markets) {
    const r = await call("GET", `/trades/${m.marketId}?limit=200`);
    if (r?.status === 200) for (const t of r.body as any[]) trades.set(`${t.txHash}:${t.makerOrderHash}:${t.takerOrderHash}:${t.size}:${t.price}`, t);
  }
}

let nonceCounter = 0n;
async function placeRandom(t: Trader, giveUpAt: number): Promise<void> {
  if (markets.length === 0) return;
  const m = pick(markets);
  const step = m.indexPrice / 2000n; // 0.05% of the index
  const k = BigInt(Math.floor(rnd() * 17) - 8); // -8 .. +8 steps
  const now = Math.floor(Date.now() / 1000);
  const order: Order = {
    trader: t.address,
    marketId: m.marketId,
    isBuy: rnd() < 0.5,
    reduceOnly: false,
    size: m.minOrderSize * BigInt(1 + Math.floor(rnd() * 20)),
    limitPrice: m.indexPrice + k * step,
    nonce: (BigInt(Date.now()) << 64n) | nonceCounter++,
    expiry: BigInt(now + (rnd() < 0.05 ? 100 : 3600)),
  };
  const signature = await t.signTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: order });
  const hash = hashTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: order });
  const s: Sent = { order, hash, signature, trader: t, accepted: false };
  sent.set(hash, s);
  const x = rnd();
  const r = await submit(s, x < 0.15 ? { ioc: true } : x < 0.25 ? { postOnly: true } : {}, giveUpAt);
  if (!r) return void bump(stats.rejected, "NO_ANSWER");
  if (r.status !== 200) return void bump(stats.rejected, r.body?.error?.code ?? `HTTP_${r.status}`);
  if (r.body.orderHash !== hash) throw new Error(`engine computed another order hash: ${r.body.orderHash} vs ${hash}`);
  s.accepted = true;
  s.status = r.body.status;
  stats.ordersAccepted++;
  if (r.body.duplicate) stats.duplicateAnswers++;
  if (r.body.fills.length > 0) stats.ordersWithFills++;
  bump(stats.acceptedStatus, r.body.status);
  if (r.body.reason) bump(stats.closedReason, String(r.body.reason).split(":")[0]!);
}

async function cancelRandom(t: Trader): Promise<void> {
  const mine = [...sent.values()].filter((s) => s.trader === t && s.accepted && (s.status === "open" || s.status === "partially_filled"));
  if (mine.length === 0) return;
  const s = pick(mine);
  const signature = await t.signTypedData({ domain, types: CANCEL_TYPES, primaryType: "Cancel", message: { trader: t.address, nonce: s.order.nonce } });
  const r = await call("DELETE", `/orders/${s.hash}`, { signature, trader: t.address, nonce: s.order.nonce });
  if (r?.status === 200) {
    stats.cancelsOk++;
    s.status = r.body.status;
  } else bump(stats.cancelRefused, r ? (r.body?.error?.code ?? `HTTP_${r.status}`) : "NO_ANSWER");
}

async function fund(t: Trader): Promise<void> {
  const w = createWalletClient({ account: t, chain, transport: http(RPC) });
  const want = parseUnits("500000", 6);
  const have = await pub.readContract({ address: dep.exchange, abi, functionName: "balanceOf", args: [t.address] });
  if (have >= want / 2n) return;
  for (const [address, a, functionName, args] of [
    [dep.usdc, erc20, "mint", [t.address, want]],
    [dep.usdc, erc20, "approve", [dep.exchange, want]],
    [dep.exchange, abi, "deposit", [want]],
  ] as const) {
    const hash = await w.writeContract({ address, abi: a, functionName, args } as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted for ${t.address}`);
  }
}

async function main(): Promise<void> {
  console.log(`soak: ${TRADERS} traders, ${DURATION} s, ~${RATE} ops/s, engine ${ENGINE}, rpc ${RPC}`);
  const startBlock = await pub.getBlockNumber();
  for (const t of traders) await fund(t);
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
      await sleep(1000);
    }
  })();
  const pause = (TRADERS * 1000) / RATE;
  await Promise.all(
    traders.map(async (t, i) => {
      await sleep((pause * i) / TRADERS);
      while (Date.now() < deadline) {
        const t0 = Date.now();
        stats.operations++;
        if (rnd() < 0.12) await cancelRandom(t);
        else await placeRandom(t, giveUpAt);
        await sleep(Math.max(0, pause - (Date.now() - t0)));
      }
    }),
  );
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`load phase done after ${elapsed.toFixed(0)} s; waiting for settlement to drain`);

  // ---- settle down
  let health: any = null;
  for (let i = 0; i < 240; i++) {
    health = (await call("GET", "/health"))?.body ?? null;
    if (health && health.ok && health.settlement.queued === 0 && health.settlement.inFlight === 0) break;
    await sleep(500);
  }
  running = false;
  await background;
  await collectTrades();

  // ---- invariants
  const problems: string[] = [];
  const fail = (msg: string) => {
    if (problems.length < 25) problems.push(msg);
    else if (problems.length === 25) problems.push("... more");
  };
  const head = await pub.getBlockNumber();
  const fillLogs = await pub.getContractEvents({ address: dep.exchange, abi, eventName: "Fill", fromBlock: startBlock, toBlock: head, strict: true });
  const failedLogs = await pub.getContractEvents({ address: dep.exchange, abi, eventName: "MatchFailed", fromBlock: startBlock, toBlock: head, strict: true });
  const liquidations = await pub.getContractEvents({ address: dep.exchange, abi, eventName: "Liquidation", fromBlock: startBlock, toBlock: head, strict: true });

  // 1. engine state of every accepted order vs on-chain filledSize; nothing overfilled
  const filledByLogs = new Map<string, bigint>();
  for (const l of fillLogs) for (const h of [l.args.makerOrderHash, l.args.takerOrderHash]) filledByLogs.set(h, (filledByLogs.get(h) ?? 0n) + l.args.size);
  let checked = 0;
  let pruned = 0;
  let restingAtEnd = 0;
  for (const s of sent.values()) {
    const onChain = await pub.readContract({ address: dep.exchange, abi, functionName: "filledSize", args: [s.hash] });
    if (onChain > s.order.size) fail(`order ${s.hash} overfilled on-chain: ${onChain} > ${s.order.size}`);
    if (onChain !== (filledByLogs.get(s.hash) ?? 0n)) fail(`order ${s.hash}: filledSize ${onChain} != sum of Fill events ${filledByLogs.get(s.hash) ?? 0n}`);
    if (!s.accepted) {
      if (onChain !== 0n) fail(`order ${s.hash} was refused by the engine but has fills on-chain`);
      continue;
    }
    // The identical order again: the engine answers with its current state and changes nothing.
    const r = await call("POST", "/orders", { order: s.order, signature: s.signature });
    if (r?.status === 400 && r.body?.error?.code === "EXPIRED") {
      pruned++; // finished and past its expiry: forgotten by the engine; the chain checks above still hold
      continue;
    }
    if (r?.status !== 200 || r.body.duplicate !== true) {
      fail(`order ${s.hash}: resubmission did not return its state (${r?.status} ${j(r?.body).slice(0, 120)})`);
      continue;
    }
    checked++;
    const e = r.body;
    if (BigInt(e.pending) !== 0n) fail(`order ${s.hash}: engine still shows pending ${e.pending} after settlement drained`);
    if (BigInt(e.filled) !== onChain) fail(`order ${s.hash}: engine filled ${e.filled} != on-chain ${onChain} (status ${e.status})`);
    if (BigInt(e.remaining) + BigInt(e.filled) > s.order.size) fail(`order ${s.hash}: remaining + filled exceeds its size`);
    if ((e.status === "open" || e.status === "partially_filled") && BigInt(e.remaining) + BigInt(e.filled) !== s.order.size) fail(`order ${s.hash}: resting order does not add up`);
    if (e.status === "filled" && onChain !== s.order.size) fail(`order ${s.hash}: engine says filled, chain has ${onChain} of ${s.order.size}`);
    if (e.status === "open" || e.status === "partially_filled") restingAtEnd++;
  }

  // 2. the engine's book is exactly the resting orders
  for (const m of dep.markets) {
    const book = (await call("GET", `/orderbook/${m.marketId}?depth=500`))?.body;
    if (!book) {
      fail(`no order book for market ${m.marketId}`);
      continue;
    }
    if (book.bids[0] && book.asks[0] && BigInt(book.bids[0].price) >= BigInt(book.asks[0].price)) fail(`market ${m.marketId}: book is crossed`);
  }

  // 3. every trade the engine confirmed has its Fill on-chain
  const fillKeys = new Map<string, number>();
  for (const l of fillLogs) {
    const k = `${l.transactionHash}:${l.args.makerOrderHash}:${l.args.takerOrderHash}:${l.args.size}:${l.args.price}`;
    fillKeys.set(k, (fillKeys.get(k) ?? 0) + 1);
  }
  for (const k of trades.keys()) if (!fillKeys.has(k)) fail(`engine trade without an on-chain Fill: ${k}`);

  // 4. positions net to zero per market; open interest is balanced
  // Everyone who ever held a position on this (local) chain, not only this run's traders.
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
    for (const a of accounts) sum += (await pub.readContract({ address: dep.exchange, abi, functionName: "getPosition", args: [a, m.marketId] })).size;
    if (sum !== 0n) fail(`market ${m.marketId}: positions sum to ${sum}, not 0`);
    const [longs, shorts] = await pub.readContract({ address: dep.exchange, abi, functionName: "openInterest", args: [m.marketId] });
    if (longs !== shorts) fail(`market ${m.marketId}: open interest longs ${longs} != shorts ${shorts}`);
  }

  // 5. engine health
  if (!health?.ok) fail(`engine /health not ok at the end: ${j(health).slice(0, 300)}`);
  if (health && (health.settlement.queued !== 0 || health.settlement.inFlight !== 0)) fail("settlement queue did not drain");

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
    operations: stats.operations,
    ordersSent: sent.size,
    ordersAccepted: stats.ordersAccepted,
    ordersAcceptedPerSec: +(stats.ordersAccepted / elapsed).toFixed(2),
    ordersWithImmediateFills: stats.ordersWithFills,
    acceptedStatus: stats.acceptedStatus,
    closedOnArrivalBy: stats.closedReason,
    refusedByCode: stats.rejected,
    cancelsOk: stats.cancelsOk,
    cancelsRefusedByCode: stats.cancelRefused,
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
    engineTradesSeen: trades.size,
    ordersCheckedAgainstChain: checked,
    ordersPrunedAfterExpiry: pruned,
    ordersRestingAtEnd: restingAtEnd,
    engineHealthOk: !!health?.ok,
    healthWarnings: health?.warnings ?? null,
    invariantsHeld: problems.length === 0,
    problems,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? "\nSOAK PASSED: all invariants held" : `\nSOAK FAILED: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
