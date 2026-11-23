# Baldwin contracts

On-chain part of the Baldwin perpetuals exchange: USDC custody, EIP-712 order
settlement, cross margin, funding and liquidation. Rules: [`docs/SPEC.md`](../docs/SPEC.md).
External interface (fixed, shared with the engine and the web app):
[`src/interfaces/IExchange.sol`](src/interfaces/IExchange.sol).

| File | What |
|---|---|
| `src/Exchange.sol` | The exchange |
| `src/interfaces/IOracle.sol` | `getPrice(marketId) -> (priceWad, updatedAt)` |
| `src/oracles/ChainlinkOracle.sol` | Chainlink adapter (one USD feed per market, normalized to 18 decimals) |
| `src/mocks/*` | Test/local only: `MockUSDC` (open mint), `MockOracle` (open price setter), test doubles |
| `scripts/deploy.ts` | Local/test deployment with mocks |

## Build, test, deploy

```sh
npm install
npm run build          # hardhat compile (solc-js 0.8.26 from node_modules, no download)
npm test               # unit tests + randomized solvency invariant

npm run node           # terminal 1: local chain on 127.0.0.1:8545 (chain id 31337)
npm run deploy:local   # terminal 2: deploys and writes deployments/localhost.json
```

`deploy.ts` deploys MockUSDC, MockOracle and Exchange, adds BTC-USD (id 0) and ETH-USD
(id 1), makes the deployer owner, operator and fee recipient, and mints 1,000,000 test
USDC to the first five accounts. `MAX_PRICE_AGE` (seconds, default one year because the
mock price is only set by hand) and `MAX_FUNDING_RATE_BPS` (per hour, default 10) can be
set through the environment. The script is for mocks only.

Constructor: `Exchange(usdc, oracle, owner, feeRecipient, maxPriceAge, maxFundingRateBps)`.
Admin functions (not part of `IExchange`): `addMarket`, `updateMarket`, `setOperator`,
`setFeeRecipient`, `setPaused`.

## How it works

- **Accounts.** One signed USDC balance per account, shared by all markets. A position is
  `(size, entryNotional, lastCumulativeFunding)`. Opening moves no cash; PnL is realized
  into the balance when size is closed (pro rata of `entryNotional`); a flip closes the old
  position and opens the remainder at the fill price.
  `accountValue = balance + Σ unrealized PnL − Σ pending funding` at index prices.
- **Fills.** `settleMatches` (operators only) runs every match in its own call frame; a
  failing match emits `MatchFailed` with the revert data and the batch continues. The
  price is the maker's `limitPrice` and must be within the taker's limit. Order hash =
  EIP-712 digest; fills are tracked per hash, `cancelOrder(nonce)` kills every order of the
  caller with that nonce. Only 65-byte, low-s EOA signatures are accepted.
- **Margin.** After a fill each side must either satisfy initial margin at fresh index
  prices, or have strictly reduced its position without flipping. In the second case the
  account must not end with negative value (see deviations). Withdrawals are allowed up to
  `freeCollateral = accountValue − initial margin`, so unrealized profit is withdrawable
  and the cash balance can be negative.
- **Funding.** `updateFunding` (anyone; also called by fills and liquidations of that
  market) acts at most once per hour: `rate = clamp((mark − index)/index, ±cap)`,
  `cumulativeFunding += index × rate × elapsed / 1h`, with `elapsed` capped at 8 hours.
  Mark is the last fill price. Positions settle the index difference whenever touched.
- **Liquidation.** If `accountValue < maintenance margin`, anyone can take over up to
  `maxSize` of a position at the index price. The liquidator therefore needs collateral
  and ends up holding the position. The penalty (bps of the liquidated notional, capped at
  the account's remaining value) is split 50/50 between liquidator and insurance fund.
  When the account has no positions left and a negative balance, the insurance fund
  covers it; the remainder is added to `totalBadDebt` and reported in the event.
- **Rounding.** Always against the trader: buyers pay the notional rounded up, sellers
  receive it rounded down, fees/penalties/margin requirements round up, funding payers
  pay the ceiling and receivers get the floor. Dust stays in the contract unassigned.
  Invariant (tested): `USDC held + totalBadDebt ≥ Σ accountValue + insuranceFund`.
- **Stale oracle** (`updatedAt` older than `maxPriceAge`): opening/increasing/flipping
  fills, liquidations, withdrawals of accounts with open positions and the value/margin
  views revert. Reducing fills still work (valued at the last known price), accounts
  without positions can withdraw, and funding accrues nothing for the period.
- **Pause** (and markets with `active = false`): no deposits (pause only) and only fills
  in which both sides reduce. Withdrawals, cancels, funding and liquidations stay open.

## Trust model

- **Traders** keep custody in the sense that no balance or position changes without their
  EIP-712 signature, except through funding, liquidation (when under maintenance margin)
  and fees. They can always cancel on-chain and withdraw free collateral without the
  operator. They cannot close a position without the operator (there is no on-chain order
  book or forced exit).
- **Operator** (allowlisted): chooses which signed orders are matched, in which order, and
  which side is the maker (i.e. which of two crossing limit prices is used). It can censor
  and it can move the mark price with small fills, but it cannot exceed any signed limit,
  size, expiry or reduce-only flag, and it cannot move funds on its own.
- **Owner**: fully trusted for parameters. It can add/update markets (margins, fees up to
  1%, penalty up to the maintenance margin, caps), set operators and the fee recipient,
  and pause. Raising the maintenance margin makes accounts liquidatable, so the owner can
  effectively take traders' margin; it must be a multisig behind a timelock.
- **Oracle**: fully trusted. A wrong price lets positions be opened, liquidated and profits
  withdrawn at that price. The oracle address is immutable in the exchange; the Chainlink
  adapter's owner chooses the feeds.
- **Collateral token**: assumed to be a standard 6-decimal ERC-20 without transfer fees,
  rebasing or hooks. (USDC is upgradeable and can blacklist addresses, including this
  contract.)

## Known limitations / before mainnet

- No external audit yet. Tests are example-based plus one randomized invariant test; there
  is no fuzzing/formal verification (Foundry was not available).
- **No socialized loss / ADL.** Bad debt is only recorded. When `totalBadDebt > 0` the
  contract holds less USDC than it owes and the last withdrawers cannot be paid. There is
  no way yet to repay bad debt or to top up or withdraw the insurance fund.
- **Underwater accounts pay no liquidation reward** (the penalty is capped at the account's
  value), so nobody but a protocol-run keeper has a reason to liquidate them.
- **Liquidators take inventory**: they receive the position at the index price and must
  hedge or unwind it themselves. No close factor: an account one unit under maintenance
  can be liquidated completely.
- **Mark price = last fill** and funding samples it once per accrual. It can be stale or
  pushed by small fills within the rate cap; a TWAP/impact price is needed. Funding is not
  charged for time beyond 8 hours without an accrual, nor while the index price is stale,
  and anyone may trigger that zero-rate accrual while the oracle is stale.
- **Oracle**: one global `maxPriceAge` for all feeds; no L2 sequencer-uptime check, no
  deviation/circuit breaker, no fallback feed. A market whose oracle call reverts freezes
  withdrawals and liquidations of every account that has a position in it. The oracle
  cannot be replaced without redeploying the exchange.
- **Gap risk**: unrealized profit is withdrawable immediately, while the losing side pays
  only when it closes or is liquidated. A price gap larger than the maintenance margin
  before liquidation becomes bad debt (also when both sides belong to one person).
  Open-interest caps are the only limit on exposure; there are no per-account position
  limits and no price bands for fills relative to the index.
- Fill prices far from the index are accepted if both traders signed them and margin
  holds; this lets two accounts transfer value between them at will (not below zero).
- `minOrderSize` applies to the order, not to the fill, and also to reduce-only orders, so
  positions smaller than the minimum can only be closed with a larger order or by first
  adding to them.
- EOA signatures only (no ERC-1271 smart accounts, no compact signatures). Orders have no
  time-in-force or post-only semantics on-chain; nonces are only cancellation handles.
- Every margin check loops over all markets (one storage read each, plus an oracle call
  per open position), so gas grows with the number of markets.
- Owner is a single-step `Ownable` key; no timelock, no parameter change delays, no
  two-step ownership transfer. Pause has no guardian role.
- `deployments/localhost.json` and the deploy script are for mocks only; a production
  deployment script (real USDC, Chainlink feeds, sane `maxPriceAge`) does not exist yet.
