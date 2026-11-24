# Baldwin

Non-custodial perpetual futures exchange (MVP). Traders sign orders in their
wallet, an off-chain engine matches them, and an on-chain contract verifies both
signatures, enforces margin and moves balances.

**Unaudited. Do not deploy with real funds.**

| Dir | What |
|---|---|
| `contracts/` | `Exchange` contract, oracle adapters, tests, local deploy |
| `engine/` | Order book, matching, settlement, REST/WS API, keeper |
| `web/` | Trading UI |
| `shared/` | ABI and EIP-712 types used by engine and web |
| `docs/SPEC.md` | Rules and architecture |

Each package has its own README with how to run it and its known limitations.
For a full local run see "Local development" in `docs/SPEC.md`, then
`npx tsx scripts/e2e-local.ts` in `engine/` for an end-to-end check.

The Python scripts and HTML charts at the repository root predate the exchange
and are unrelated to it.
