# Baldwin contracts

On-chain part of the Baldwin perpetuals exchange: USDC custody, EIP-712 order
settlement, cross margin, funding and liquidation. Rules: [`docs/SPEC.md`](../docs/SPEC.md).
External interface (fixed, shared with the engine and the web app):
[`src/interfaces/IExchange.sol`](src/interfaces/IExchange.sol).

| File | What |
|---|---|
| `src/Exchange.sol` | The exchange |
| `src/interfaces/IOracle.sol` | `getPrice(marketId) -> (priceWad, updatedAt)` |
| `src/oracles/ChainlinkOracle.sol` | Chainlink adapter: one USD feed per market, normalized to 18 decimals, per-feed staleness limit, optional L2 sequencer uptime check |
| `src/mocks/*` | Test/local only: `MockUSDC` (open mint), `MockOracle` (open price setter), test doubles |
| `scripts/deploy.ts` | Local deployment with mocks |
| `scripts/deploy-testnet.ts` | Testnet deployment against real USDC and Chainlink feeds (Arbitrum Sepolia) |
| `scripts/dry-run-mocks.ts` | Stand-ins for the external contracts, to rehearse the testnet deployment locally |

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
mock price is only set by hand), `MAX_FUNDING_RATE_BPS` (per hour, default 10) and
`MAX_PRICE_DEVIATION_BPS` (default 500) can be set through the environment. The script
is for mocks only.

Constructor: `Exchange(usdc, oracle, owner, feeRecipient, maxPriceAge, maxFundingRateBps,
maxPriceDeviationBps)`; the funding cap may be at most 100 bps per hour.
Admin functions (not part of `IExchange`): `addMarket`, `updateMarket`, `setOperator`,
`setFeeRecipient`, `setPaused`, `setOracle`, and the two-step `transferOwnership` /
`acceptOwnership` (`renounceOwnership` is disabled). At most 16 markets.
`deploy.ts` refuses to run on any chain but 31337.

## Testnet deployment (Arbitrum Sepolia)

`scripts/deploy-testnet.ts` deploys `ChainlinkOracle` and `Exchange` against an existing
USDC token and existing Chainlink feeds. It deploys no mocks and mints nothing.

1. `cp .env.example .env` and fill it in (`.env` is git-ignored and loaded by
   `hardhat.config.ts`). Look the external addresses up yourself; none are hard-coded:
   - `USDC_ADDRESS`: Circle's "USDC on test networks" page, Arbitrum Sepolia;
   - `BTC_USD_FEED`, `ETH_USD_FEED` and their heartbeats (for `*_MAX_STALENESS`, use
     heartbeat plus a margin): Chainlink's price feed address list, Arbitrum Sepolia;
   - `SEQUENCER_UPTIME_FEED` (optional): Chainlink's "L2 Sequencer Uptime Feeds" page;
   - `OWNER_ADDRESS` (multisig), `OPERATOR_ADDRESS` (the engine's key), `FEE_RECIPIENT`.
2. Fund the deployer with a little Sepolia ETH on Arbitrum Sepolia.
3. `npm run deploy:testnet` (= `hardhat run scripts/deploy-testnet.ts --network arbitrumSepolia`).
   Before the first transaction the script refuses to continue if
   - a required variable is missing or malformed, or the parameters break a contract rule;
   - the RPC is not chain 421614 (or is a known mainnet);
   - the deployer is one of the well-known Hardhat/Anvil test accounts (unless
     `ALLOW_TEST_KEY=true`, for rehearsals);
   - USDC, a feed or the sequencer feed has no code; the owner has no code, which
     includes the deployer itself (unless `ALLOW_EOA_OWNER=true`);
   - the operator or the fee recipient is one of the contracts involved;
   - USDC does not have 6 decimals;
   - a feed's answer is not positive, is older than its staleness limit, is outside a
     plausible range, or the two feeds look swapped; the sequencer is down or inside the
     grace period.

   Then it deploys, sets the feeds, adds BTC-USD (0) and ETH-USD (1), reads the index
   price of both through the exchange, sets the operator, starts the ownership transfer
   of both contracts and writes `deployments/arbitrumSepolia.json`. From the first
   deployed contract on, progress is kept in `deployments/arbitrumSepolia.json.incomplete`
   (addresses and completed steps); it is removed on success. If the script fails
   half-way, that file says what exists; fix the cause and run again (a new pair of
   contracts is deployed, the abandoned ones are harmless).
4. **The multisig must call `acceptOwnership()` on the Exchange and on the
   ChainlinkOracle.** Until then the deployer key is still the owner of both.
5. Verify the sources with the two commands the script prints, e.g.
   `npx hardhat verify --network arbitrumSepolia <exchange> <usdc> <oracle> <deployer> <feeRecipient> <maxPriceAge> <fundingCap> <band>`
   (needs `ETHERSCAN_API_KEY`).
6. Point the engine and the web app at `deployments/arbitrumSepolia.json`. The operator
   account needs ETH for gas; a keeper that liquidates needs USDC deposited.

### Dry run

The whole path (env loading, the `arbitrumSepolia` network entry, private-key account,
chain-id check, preflight, deployment, output file) can be rehearsed against a local node
that reports chain id 421614:

```sh
HARDHAT_CHAIN_ID=421614 npx hardhat node --port 8555            # terminal 1 (any free port)
# terminal 2 (the key is hardhat's public test account #0)
export ARBITRUM_SEPOLIA_RPC_URL=http://127.0.0.1:8555
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
npx hardhat run scripts/dry-run-mocks.ts --network arbitrumSepolia > /tmp/dry.env
set -a; . /tmp/dry.env; set +a      # includes ALLOW_TEST_KEY=true and ALLOW_EOA_OWNER=true
DEPLOYMENT_FILE=/tmp/dry-deployment.json npm run deploy:testnet
```

`test/DeployTestnet.test.ts` runs the same script in-process on every `npm test`,
including each refusal.

## How it works

- **Accounts.** One signed USDC balance per account, shared by all markets. A position is
  `(size, entryNotional, lastCumulativeFunding)`. Opening moves no cash; PnL is realized
  into the balance when size is closed (pro rata of `entryNotional`); a flip closes the old
  position and opens the remainder at the fill price.
  `accountValue = balance + Σ unrealized PnL − Σ pending funding` at index prices.
- **Fills.** `settleMatches` (operators only) runs every match in its own call frame; a
  failing match emits `MatchFailed` with the revert data and the batch continues. Before
  each match at least `MATCH_GAS_BASE + MATCH_GAS_PER_MARKET × marketCount` gas must be
  left, otherwise the whole batch reverts with `InsufficientGas` (an under-gassed
  transaction must not be able to report valid matches as failed). The price is the
  maker's `limitPrice` and must be within the taker's limit. Order hash = EIP-712 digest;
  fills are tracked per hash. Only 65-byte, low-s EOA signatures are accepted.
- **Order lifetime and cancellation.** Every order needs an `expiry` that is not zero and
  at most `maxOrderLifetime()` (30 days) ahead of the block in which it is filled
  (`InvalidExpiry`; an order dated further ahead becomes fillable once inside the window),
  and it is dead after its expiry (`OrderExpired`). `cancelOrder(nonce)` kills every order
  of the caller with that nonce; `cancelAllOrders(n)` kills every order with a nonce below
  `n` and can only be raised. Both make `isCancelled` true and fills fail with
  `OrderIsCancelled`. Clients must therefore use increasing nonces.
- **Price band.** Every fill needs a fresh index price and must satisfy
  `|price − index| × 10000 ≤ index × maxPriceDeviationBps` (inclusive), else
  `PriceOutOfBand(price, index)`. This stops accounts from moving equity between them
  through off-market fills and keeps the mark price next to the index. Market parameters
  must satisfy `band + maxFee × (1 + band) < maintenance` (the fee is charged on the fill
  notional, which can be up to `1 + band` of the index notional) and
  `8 × maxFundingRateBps + band < maintenance`.
- **Fill size.** Both orders must be at least `minOrderSize`; so must the fill, unless it
  completes one of the two orders or closes one side's position entirely.
- **Margin.** After a fill each side must satisfy initial margin, unless it strictly
  reduced its position without flipping. A reducing side must not end with negative value
  (`NegativeAccountValue`). If it then does not satisfy initial margin, it must not have
  lowered `accountValue − maintenance requirement`, and, if it was below maintenance
  before the fill, it must not have lowered `accountValue / maintenance requirement`
  either (`InsufficientMargin`). The last rule stops a liquidatable account from paying
  its remaining equity to a counterparty through band-edge reductions while keeping most
  of its position; it can still reduce at fair prices or close completely. Withdrawals
  are allowed up to `freeCollateral = accountValue − initial margin`, so unrealized
  profit is withdrawable and the cash balance can be negative.
- **Funding accrual.** `withdraw`, fills and liquidations first accrue due funding in
  every market the accounts involved hold a position in, so margin checks see it. The
  views (`accountValue`, `freeCollateral`, `isLiquidatable`) cannot accrue and may be
  ahead of what a transaction will find until `updateFunding` has run.
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
  The liquidated market needs a fresh price. The trader's positions in *other* markets
  whose price is unavailable (stale, or the oracle reverts) are valued at entry: no
  unrealized PnL, maintenance on the entry notional. Without this, one dead feed or a dust
  position in a market without a price would make an account unliquidatable everywhere.
  The trade-off: **a trader whose buffer is unrealized profit in a market without a price
  can be liquidated although truly healthy** (and one with an unrealized loss there is
  judged too kindly). `isLiquidatableIn(trader, marketId)` answers with the same
  valuation; `isLiquidatable` stays strict and reverts.
- **Rounding.** Always against the trader: buyers pay the notional rounded up, sellers
  receive it rounded down, fees/penalties/margin requirements round up, funding payers
  pay the ceiling and receivers get the floor. Dust stays in the contract unassigned.
  Invariant (tested): `USDC held + totalBadDebt ≥ Σ accountValue + insuranceFund`.
- **Stale oracle** (`updatedAt` older than `maxPriceAge`, or in the future): all fills in
  that market, all fills of accounts holding a position in that market, liquidations,
  withdrawals of accounts with open positions and the value/margin views revert. Funding
  accrues nothing for the period. On-chain cancels, deposits and withdrawals of accounts
  without positions keep working. Trade-off: there is no trading at all during an oracle
  outage, not even to close; in exchange nobody can trade at a price that can no longer
  be checked.
- **Pause** (and markets with `active = false`): only fills in which both sides reduce.
  Deposits, withdrawals, cancels, funding and liquidations stay open.

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
- **Owner**: fully trusted, for parameters and, through `setOracle`, for prices: **the
  owner can replace the oracle and thereby set any price, liquidate anyone and withdraw
  the collateral as "profit". `setOracle` exists so that a permanently broken oracle can
  be replaced; before mainnet the owner must be a multisig behind a timelock.** It can add/update markets (margins, fees up to
  1%, penalty up to the maintenance margin, caps), set operators and the fee recipient,
  and pause. Raising the maintenance margin makes accounts liquidatable, so the owner can
  effectively take traders' margin; it must be a multisig behind a timelock. Ownership
  moves in two steps (`Ownable2Step`): the new owner has to accept.
- **Oracle**: fully trusted. A wrong price lets positions be opened, liquidated and profits
  withdrawn at that price. The exchange's owner can replace the oracle; the Chainlink
  adapter's owner chooses the feeds, their staleness limits and the sequencer uptime
  feed (settable, `address(0)` disables it; two-step ownership too).
  The adapter reverts while the L2 sequencer is down and for a grace period after it is
  back, which freezes fills, liquidations and withdrawals of accounts with positions.
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
  can be liquidated completely. Liquidations are not subject to the minimum fill size.
- **Mark price = last fill** and funding samples it once per accrual. It can be old, and
  the operator (or two cooperating traders) can place it anywhere inside the price band
  with one minimum-size fill, so funding can still be steered up to the rate cap; a
  TWAP/impact price is needed. The rate sampled at accrual is charged for the whole
  elapsed period, also on positions opened just before the accrual. Funding is not
  charged for time beyond 8 hours without an accrual, nor while the index price is stale,
  and anyone may trigger that zero-rate accrual while the oracle is stale.
- **Off-chain cancels are not binding on-chain.** A cancel sent only to the engine (or an
  order the engine dropped) can still be settled by the operator while the signature is
  valid. What bounds this now: every order expires within 30 days at most, and
  `cancelOrder` / `cancelAllOrders` on-chain end it immediately. `cancelAllOrders` only
  helps if the client's nonces increase over time.
- **The operator picks the maker side** of two crossing orders and thereby the price
  (within both limits and the band) and who pays which fee.
- **Fee changes apply to resting orders**: an order signed under one fee schedule is
  charged the fees in force when it is filled (at most 1%).
- **Oracle**: no deviation check/circuit breaker and no fallback feed. The sequencer
  check and the feed reads were only tested against mock aggregators, never against the
  real feeds. A market whose oracle call reverts (including sequencer downtime) freezes
  fills and withdrawals of every account that has a position in it, and liquidations of
  positions in that market. Recovery is manual (`setOracle`, `setFeed`,
  `setSequencerUptimeFeed`); there is **no emergency settlement mode** that would let
  users exit a market whose price never comes back.
- **Gap risk**: unrealized profit is withdrawable immediately, while the losing side pays
  only when it closes or is liquidated. A price gap larger than the maintenance margin
  before liquidation becomes bad debt (also when both sides belong to one person).
  Open-interest caps are the only limit on exposure; there are no per-account position
  limits. The band and the maintenance margin are tied by a parameter check only.
- No trading during an oracle outage (see above); a market whose price band has moved
  away from resting orders simply stops matching them.
- `minOrderSize` also applies to reduce-only orders: a position below the minimum is
  closed with an order of at least the minimum size that is filled for exactly the
  position. A reducing fill worth less than a few millionths of a USDC can be rejected
  for an account under initial margin, because fee rounding outweighs the margin released.
- The batch gas floor (800k gas for 2 markets, 2.0M for 8) was measured with the Chainlink adapter
  over mock aggregators; real feeds sit behind a proxy and cost more per read. Re-measure
  on a fork or on the testnet. It grows with the number of markets.
- EOA signatures only (no ERC-1271 smart accounts, no compact signatures). Orders have no
  time-in-force or post-only semantics on-chain; nonces are only cancellation handles.
  `cancelAllOrders` accepts values up to one day ahead in the (ms timestamp << 64) nonce
  scheme, so a mistaken call can block new orders for at most a day.
- Every margin check loops over all markets (one storage read each, plus an oracle call
  per open position), so gas grows with the number of markets (capped at 16).
- A liquidatable account can still close its whole position in-band before it is
  liquidated and thereby pay no penalty; only partial reductions on bad terms are refused.
- No timelock and no parameter change delays; pause has no guardian role. Until the
  multisig accepts ownership after a deployment, a single deployer key is the owner.
- The testnet deployment script has only run against a local node with stand-in
  contracts. It has not run against Arbitrum Sepolia, and source verification
  (`hardhat verify`) has not been tried. There is no mainnet deployment script.
