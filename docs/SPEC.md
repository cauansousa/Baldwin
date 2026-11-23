# Baldwin — perpetuals exchange (MVP spec)

Non-custodial perpetual futures. Traders sign orders in their wallet (EIP-712);
an off-chain engine matches them; an on-chain contract verifies both signatures,
enforces margin and moves balances. The operator can order and censor matches
but can never move funds without two valid trader signatures.

## Layout

| Dir | What | Stack |
|---|---|---|
| `contracts/` | `Exchange` (custody, margin, settlement, funding, liquidation), oracle adapters, deploy script | Solidity 0.8.26, Hardhat (solc-js) |
| `engine/` | Order book, matching, settlement submitter, REST/WS API, liquidation + funding keeper | TypeScript, Node 22, viem |
| `web/` | Trading UI | Vite, React, wagmi/viem |
| `shared/` | ABI, EIP-712 types, constants (no dependencies) | TypeScript |

The source of truth for the on-chain interface is
`contracts/src/interfaces/IExchange.sol`, mirrored in `shared/src/index.ts`.

## Rules

- Collateral: USDC only (6 decimals). Sizes and prices are 18-decimal WAD.
- Margin: cross-margin per account across all markets.
  `accountValue = balance + Σ unrealizedPnL − Σ pendingFunding`, at oracle (index) prices.
- A fill is accepted only if, after it, each side either satisfies initial margin
  or strictly reduced its position without flipping (risk-reducing fills always allowed).
- Withdrawals must leave initial margin satisfied.
- Fees: maker/taker bps of notional, charged in USDC, paid to the fee recipient.
- Funding: hourly; rate = clamp((mark − index) / index, ±cap), longs pay shorts when
  positive. Mark = last fill price. Accrued through a cumulative index, settled into
  balance whenever a position is touched.
- Liquidation: anyone may close a position of an account below maintenance margin at
  the index price. Penalty (bps of notional) is split between liquidator and insurance
  fund. Losses beyond the account's value are covered by the insurance fund; any
  remainder is recorded as bad debt (event) — socialized loss/ADL is out of MVP scope.
- Oracle: `IOracle.getPrice(marketId) → (priceWad, updatedAt)`; stale prices revert.
  Chainlink adapter for production, mock for tests/local.
- Admin: owner adds/updates markets, sets operators, fee recipient, pause. Pause blocks
  deposits and settlement of position-increasing matches; withdrawals, cancels and
  liquidations stay open.

## Engine API (default port 8080)

- `POST /orders` `{ order, signature }` → `{ orderHash, status, fills[] }`
- `DELETE /orders/:orderHash` `{ signature }` (EIP-712 `Cancel`)
- `GET /markets`, `GET /orderbook/:marketId?depth=`, `GET /trades/:marketId`
- `GET /orders?trader=0x..` (open orders), `GET /health`
- `WS /ws` — subscribe `{ op: "subscribe", channel: "orderbook" | "trades", marketId }`

All bigints travel as decimal strings in JSON.

## Local development

1. `cd contracts && npx hardhat node`
2. `cd contracts && npx hardhat run scripts/deploy.ts --network localhost`
   → writes `contracts/deployments/localhost.json`
3. `cd engine && npm run dev`
4. `cd web && npm run dev`
