// End-to-end smoke test against a local hardhat node + running engine.
// Prereqs: `npx hardhat node`, `npm run deploy:local` (contracts/), `npm start` (engine/).
// Usage: npx tsx scripts/e2e-local.ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import {
  EXCHANGE_ABI, ERC20_ABI, ORDER_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION,
  type Deployment,
} from "../../shared/src/index.ts";

const ENGINE = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const dep: Deployment = JSON.parse(readFileSync(new URL("../../contracts/deployments/localhost.json", import.meta.url), "utf8"));
const exchangeAbi = parseAbi(EXCHANGE_ABI);
const erc20Abi = parseAbi(ERC20_ABI);
const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });

// Hardhat accounts #2 and #3 (well-known test keys; never use on a real network).
const alice = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const bob = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`ok  ${msg}`);
}

async function fund(acct: typeof alice, usdc: bigint) {
  const w = createWalletClient({ account: acct, chain: hardhat, transport: http(RPC) });
  for (const [address, abi, functionName, args] of [
    [dep.usdc, erc20Abi, "approve", [dep.exchange, usdc]],
    [dep.exchange, exchangeAbi, "deposit", [usdc]],
  ] as const) {
    const hash = await w.writeContract({ address, abi, functionName, args } as never);
    await pub.waitForTransactionReceipt({ hash });
  }
}

async function place(acct: typeof alice, isBuy: boolean, size: string, price: string) {
  const order = {
    trader: acct.address, marketId: 0, isBuy, reduceOnly: false,
    size: parseUnits(size, 18), limitPrice: parseUnits(price, 18),
    nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const signature = await acct.signTypedData({
    domain: { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: dep.chainId, verifyingContract: dep.exchange },
    types: ORDER_TYPES, primaryType: "Order", message: order,
  });
  const body = JSON.stringify({ order, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const res = await fetch(`${ENGINE}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const json = await res.json();
  if (!res.ok) throw new Error(`POST /orders ${res.status}: ${JSON.stringify(json)}`);
  return json as { orderHash: string; status: string; fills: unknown[] };
}

const pos = (who: `0x${string}`) =>
  pub.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: "getPosition", args: [who, 0] });

async function main() {
  const index = await pub.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: "indexPrice", args: [0] });
  const px = (index / 10n ** 18n).toString();
  console.log(`index price BTC-USD: ${px}`);

  await fund(alice, parseUnits("50000", 6));
  await fund(bob, parseUnits("50000", 6));
  const before = { a: (await pos(alice.address)).size, b: (await pos(bob.address)).size };

  const maker = await place(alice, false, "0.5", px); // resting sell
  assert(maker.status === "open", `maker order rests in the book (status=${maker.status})`);

  const book = await (await fetch(`${ENGINE}/orderbook/0`)).json();
  assert(JSON.stringify(book).includes(parseUnits(px, 18).toString()), "order book shows the resting ask");

  const taker = await place(bob, true, "0.2", px); // crossing buy, partial fill of the maker
  assert(taker.fills.length === 1, `taker matched once (status=${taker.status})`);

  const want = parseUnits("0.2", 18);
  for (let i = 0; i < 40; i++) {
    if ((await pos(bob.address)).size - before.b === want) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert((await pos(bob.address)).size - before.b === want, "taker is long 0.2 BTC on-chain");
  assert((await pos(alice.address)).size - before.a === -want, "maker is short 0.2 BTC on-chain");

  const trades = await (await fetch(`${ENGINE}/trades/0`)).json();
  assert(JSON.stringify(trades).includes(want.toString()), "confirmed trade appears in /trades");

  const open = await (await fetch(`${ENGINE}/orders?trader=${alice.address}`)).json();
  assert(JSON.stringify(open).includes(maker.orderHash), "maker's remaining 0.3 is still an open order");
  console.log("\nE2E PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
