# Baldwin — web

Trading UI for the Baldwin perpetuals exchange. Vite + React + TypeScript, wagmi v2 / viem,
injected wallet only (MetaMask and similar). The UI is in Brazilian Portuguese.

The app never asks for, sees or stores private keys: orders and cancels are EIP-712 messages
signed in the wallet, deposits/withdrawals are ordinary wallet transactions.

## Run

```sh
npm install
npm run dev        # http://localhost:5173 — needs the hardhat node, the deployment and the engine (see docs/SPEC.md)
npm run dev:mock   # standalone: fake engine, fake chain and a fake connected wallet
```

Other scripts: `npm run build`, `npm run typecheck`, `npm test` (vitest).

## Configuration

Copy `.env.example` to `.env.local`. Everything is public (bundled into the page).

| Variable | Default | Meaning |
|---|---|---|
| `VITE_ENGINE_URL` | `http://localhost:8080` | Engine REST base URL; the WebSocket is `<same host>/ws` |
| `VITE_RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC used for chain reads |
| `VITE_CHAIN_ID` | `31337` | Expected chain; a wallet on another chain gets a "switch network" banner |
| `VITE_EXCHANGE_ADDRESS` | — | `Exchange` contract |
| `VITE_USDC_ADDRESS` | — | Collateral token |
| `VITE_MOCK` | — | `1` enables mock mode (dev server only) |

**Local addresses.** When `npm run dev` starts it reads `../contracts/deployments/localhost.json`
(written by the deploy script) and uses its `exchange`, `usdc` and `chainId` for anything not set
in the env; the dev server restarts if that file changes. Production builds ignore the file and
need the `VITE_*` variables.

On chain id 31337 the account panel shows a "mint test USDC" button that calls `mint` on the mock token.

## Mock mode

`VITE_MOCK=1` (or `npm run dev:mock`) swaps in `src/mock/`: an in-memory engine (markets, a moving
book, trades, open orders) and a fake EIP-1193 provider that answers contract reads, "mines"
approve/deposit/withdraw/mint instantly and returns dummy signatures. It exists to develop and
screenshot the UI without a backend. It only works under the dev server and is not included in
production bundles.

## Layout

- `src/lib/units.ts` — bigint parsing/formatting (WAD = 18 decimals, USDC = 6). No float math on amounts.
- `src/lib/risk.ts` — notional, fee, margin, PnL and the liquidation-price **estimate**.
- `src/lib/order.ts` — nonce, expiry, EIP-712 typed data, JSON wire form.
- `src/api/` — engine client: REST, WebSocket with reconnect, tolerant response normalization.
- `src/hooks/` — react-query hooks for engine data, chain reads and transaction flows.
- `src/components/` — the panels. `src/mock/` — mock mode.

Protocol constants, ABIs and EIP-712 types come from `../shared/src/index.ts` (alias `@shared`).

## Notes

- Market parameters, index/mark prices, balances and positions are read from the contract; the
  engine supplies the market list, book, trades and open orders.
- Order cost (margin on the index-price notional + fee + loss versus index) and the liquidation price are estimates. The liquidation price assumes only that market moves and ignores
  future funding. The contract decides.
- Orders expire 24 h after signing (the contract requires a non-zero expiry of at most 7 days). Post-only / IOC are sent as `postOnly` / `ioc` next to the
  signed order; they are not part of the signature.
