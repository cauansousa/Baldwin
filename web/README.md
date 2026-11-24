# Baldwin — web

Trading UI for the Baldwin perpetuals exchange. Vite + React + TypeScript, wagmi v2 / viem,
injected wallet only (MetaMask and similar). The UI is in Brazilian Portuguese.

The app never asks for, sees or stores private keys: orders and cancels are EIP-712 messages
signed in the wallet, deposits/withdrawals are ordinary wallet transactions.

## Run

```sh
npm install
npm run dev          # http://localhost:5173 — local node + deployment + engine (see docs/SPEC.md)
npm run dev:mock     # standalone: fake engine, fake chain and a fake connected wallet
npm run dev:testnet  # dev server against Arbitrum Sepolia (reads .env.testnet.local)
```

Other scripts: `npm run build`, `npm run build:testnet`, `npm run typecheck`, `npm test` (vitest).

## Configuration

All values are public (bundled into the page): never put keys or secrets in them.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_CHAIN_ID` | `31337` | `31337` local node, `421614` Arbitrum Sepolia. A wallet on another chain gets a banner with a switch/add-network button |
| `VITE_ENGINE_URL` | `http://localhost:8080` | Engine REST base URL; the WebSocket is `<same host>/ws` (`wss` when the URL is `https`) |
| `VITE_RPC_URL` | chain default | JSON-RPC for chain reads. Local: `http://127.0.0.1:8545`; Arbitrum Sepolia: Arbitrum's public endpoint |
| `VITE_EXCHANGE_ADDRESS` | — | `Exchange` contract |
| `VITE_USDC_ADDRESS` | — | Collateral token |
| `VITE_EXPLORER_URL` | — | Explorer base URL, only for chain ids other than the two above |
| `VITE_MOCK` | — | `1` enables mock mode (dev server only) |

Env files: `.env.local` for local work (template: `.env.example`), `.env.testnet.local` for the
testnet mode (template: `.env.testnet.example`). Both `*.local` files are git-ignored.

**Addresses in dev.** The dev server reads every `../contracts/deployments/<network>.json` and uses
the one whose `chainId` equals `VITE_CHAIN_ID` for any address not set in the env; it restarts when
those files change. **Production builds ignore these files** and take addresses from env only.

**Networks.**
- Local (31337): the account panel has a "mint test USDC" button (calls `mint` on the mock token).
- Arbitrum Sepolia (421614): a "test network — do not use real funds" banner (dismissible per
  browser session), explorer links for transactions and for the exchange address in the footer, and
  a note that test USDC comes from Circle's faucet and gas ETH from an Arbitrum Sepolia faucet.

**Wallets.** Every wallet extension that announces itself (EIP-6963) is listed in the connect menu;
without any, the app falls back to `window.ethereum`.

## Deploying to the testnet (static site)

```sh
cp .env.testnet.example .env.testnet.local   # fill in engine URL and the two addresses
npm run build:testnet                        # typecheck + build into dist/
```

Host the contents of `dist/` on any static file host (it is a single page: `index.html` plus
hashed files under `assets/`, which can be cached indefinitely; do not cache `index.html`).
The site must be served over **https** (wallets require a secure context) and, because the page is
https, the engine must be too (`https://` / `wss://`), or the browser blocks the requests.

On the engine side set `CORS_ORIGIN` to the site's exact origin (scheme + host, no trailing slash,
e.g. `https://app.example.org`); otherwise the browser refuses every REST call. The addresses and
chain id in the build must be the ones the engine itself runs with.

To check a build locally: `npm run preview` serves `dist/`.

## Mock mode

`VITE_MOCK=1` (or `npm run dev:mock`) swaps in `src/mock/`: an in-memory engine (markets, a moving
book, trades, open orders) and a fake EIP-1193 provider that answers contract reads, "mines"
approve/deposit/withdraw/mint/cancel instantly and returns dummy signatures. Engine failures can be
injected from the URL: `?mockSubmit=timeout,unknown` (order registered, answer lost, then idempotent
success), `?mockSubmit=lost`, `?mockSubmit=refused`, `?mockCancel=fail`. It exists to develop
and screenshot the UI without a backend. It only works under the dev server and is not included in
production bundles. `VITE_MOCK=1 VITE_CHAIN_ID=421614 npx vite` shows the testnet variant of the UI.

## Layout

- `src/lib/units.ts` — bigint parsing/formatting (WAD = 18 decimals, USDC = 6). No float math on amounts.
- `src/lib/risk.ts` — notional, fee, margin, PnL and the liquidation-price **estimate**.
- `src/lib/order.ts` — nonce, expiry, EIP-712 typed data, JSON wire form.
- `src/lib/chains.ts` — chain definitions, explorer links, deployment selection.
- `src/api/` — engine client: REST, WebSocket with reconnect, tolerant response normalization.
- `src/hooks/` — react-query hooks for engine data, chain reads and transaction flows.
- `src/components/` — the panels. `src/mock/` — mock mode.

Protocol constants, ABIs and EIP-712 types come from `../shared/src/index.ts` (alias `@shared`).

## Notes

- Market parameters, index/mark prices, balances and positions are read from the contract; the
  engine supplies the market list, book, trades and open orders.
- Order cost (margin on the index-price notional + fee + loss versus index) and the liquidation price are estimates. The liquidation price assumes only that market moves and ignores
  future funding. The contract decides.
- Cancelling: "Cancelar" signs an EIP-712 `Cancel` for the engine (free, instant, but only the
  engine honours it). "On-chain" calls `cancelOrder(nonce)` and "Cancelar todas on-chain" calls
  `cancelAllOrders(newMinValidNonce)` with a value above every nonce this browser signed; only these bind
  the contract. New orders always get a nonce at or above the on-chain `minValidNonce`.
- Submitting: an order is signed once. If the engine's answer is lost (timeout, network error, a
  5xx that does not clearly say "not accepted"), the **same signed order** is resubmitted with
  backoff (the engine is idempotent by order hash) and nothing else can be signed meanwhile. If it
  still cannot be confirmed, the user chooses: resubmit, discard (signs a `Cancel` for the engine;
  the order is only forgotten once the engine confirms) or cancel on-chain. The signed order lives
  in memory only: reloading the page forgets it, so check "open orders" after a reload.
- Nonces: `ms timestamp << 64 | 64 random bits`, never below the on-chain `minValidNonce` and never
  beyond the contract's bound `((chain time + 1 day) in ms) << 64`. The highest nonce handed to
  the wallet is remembered per account in `localStorage` so a bulk cancel covers earlier sessions
  on this browser; after a bulk cancel the listed orders are checked with `isCancelled`.
- Transactions: the UI waits up to 3 minutes for inclusion (1 on a local node), follows speed-ups,
  reports wallet-side cancellation/replacement and reverts, and never blocks: a timeout says the
  transaction may still confirm and links to the explorer. Chain reads are retried and polled;
  failures show a banner while the last known values stay on screen.
- Orders expire 24 h after signing (the contract requires a non-zero expiry of at most 7 days). Post-only / IOC are sent as `postOnly` / `ioc` next to the
  signed order; they are not part of the signature.
