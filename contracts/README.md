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
| `scripts/check-deployment.ts` | Read-only report of who controls a deployment; fails while the ownership handover is incomplete |
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
4. **Without a timelock, the multisig must call `acceptOwnership()` on the Exchange and
   on the ChainlinkOracle.** Until then the deployer key is still the owner of both;
   that window cannot be avoided in this mode. Check that it is closed with
   `OWNER_ADDRESS=<multisig> npm run check:testnet` (`scripts/check-deployment.ts`):
   it prints owner and pending owner of both contracts, guardian, operator status and,
   if present, the timelock's delay and roles, and exits non-zero while the handover is
   incomplete (also when only one of the two contracts was accepted).

   **With a timelock** (`TIMELOCK_DELAY_SECONDS`, at least 3600 unless
   `ALLOW_SHORT_TIMELOCK=true`) there is no such window and nothing for the multisig to
   do. The script deploys an OpenZeppelin `TimelockController` with no delay and the
   deployer in its roles, transfers both contracts to it, has it accept ownership at
   once, grants proposer/canceller/executor to the multisig, sets the delay through the
   timelock itself and gives up every role of the deployer (admin included). It then
   verifies all of that on-chain and fails loudly if anything is off. When the script
   exits successfully, the timelock owns both contracts with the configured delay and
   the deployer key has no power left. The multisig (or `GUARDIAN_ADDRESS`) is the
   guardian. From then on every owner action is `schedule` + wait + `execute` on the
   timelock, **including replacing a broken oracle or feed: recovery from an oracle
   failure also waits out the delay** (pausing does not). The timelock address is
   recorded as the optional `timelock` field of the deployment file.
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
npx hardhat compile        # first, so that the next command prints nothing but the variables
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
- **Funding.** `updateFunding` (anyone; also called by fills, liquidations and
  withdrawals) closes a market's funding period at most once per hour:
  `cumulativeFunding += index × rate × elapsed / 1h`, with `elapsed` capped at 8 hours.
  Positions settle the index difference whenever touched.
  The rate is built from *premiums*, not prices: every fill records
  `(fill price − index at that moment) / index`. Comparing old fill prices with a later
  index would charge plain index drift as funding.
  `rate = Σ clamp(premium_i, ±cap) × weight_i / T`, where `T` is the length of the
  period and `weight_i` the time from fill `i` to the next fill (the last one: to the
  accrual), at most one hour. All other time counts as zero premium: before the period's
  first fill, more than an hour after the last fill, a period without fills. Nothing is
  carried over from an earlier period. Consequences:
  - a fill one second before the accrual moves the hourly rate by at most cap/3600,
    however far from the index it was (1.4 cents per BTC at 50,000);
  - each observation is capped before averaging, so a band-edge fill that is followed by
    a fair fill a minute later counts for one minute at the cap;
  - if nobody accrues for hours, the last fill is charged for one hour at most;
  - trades at the index while the index drifts produce no funding.
  **No funding accrues while the exchange is paused or for an inactive market**, and
  fills in that state are not recorded: with opening trades blocked, the accounts still
  able to trade would set the rate unopposed. Pausing/unpausing (and switching a market's
  `active` flag) closes the running period first: charged normally up to the pause, at
  zero up to the unpause.
  `markPrice` (last fill) is informational. `markTwap(marketId)` is
  `index × (1 + average premium of the open period)`, uncapped;
  `currentFundingRate(marketId)` (WAD per hour) is the rate an accrual would use now.
  Both return 0 instead of reverting when the index is unavailable.
- **Insurance fund.** Fed by half of every liquidation penalty and by
  `depositInsurance(amount)`, which anyone can call. **Deposits are one-way: there is no
  withdrawal, for anyone.** A deposit first repays recorded bad debt (`totalBadDebt`
  goes down by `min(amount, totalBadDebt)`, which closes the real USDC shortfall) and
  only the remainder is added to the fund. The fund's share of liquidation penalties is
  booked the same way (bad debt first), so the fund never shows money the contract does
  not hold. The fund is spent only on deficits of liquidated accounts.
- **Liquidation.** If `accountValue < maintenance margin`, anyone can take over up to
  `maxSize` of a position at the index price. The liquidator therefore needs collateral
  and ends up holding the position. The penalty (bps of the liquidated notional, capped at
  the account's remaining value) is split 50/50 between liquidator and insurance fund.
  When the account has no positions left and a negative balance, the insurance fund
  covers it; the remainder is added to `totalBadDebt` and reported in the event.
  The liquidated market needs a fresh price. The trader's positions in *other* markets
  whose price is unavailable (stale, or the oracle reverts) are valued at the last index
  price a transaction read for that market (`lastGoodPrice(marketId)`: stored by fills,
  funding accruals and liquidations of that market), or at entry if there is none.
  Without this, one dead feed or a dust position in a market without a price would make
  an account unliquidatable everywhere. The trade-off: the valuation of that market is
  as old as its last good price, so **a trader can be liquidated although healthy at the
  true price, or be judged too kindly**. Because the penalty cap then rests on an
  estimate, **the liquidator gets no share of the penalty whenever such a fallback was
  used**: all of it goes to the insurance fund, which is who pays if the estimate was too
  high. Residual: the penalty can still exceed the account's true value and turn into a
  deficit when the account is closed out; the fund then gives back at most what it
  received, and bad debt arises only if the account was truly underwater anyway.
  `isLiquidatableIn(trader, marketId)` answers with the same valuation; `isLiquidatable`
  stays strict and reverts.
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
- **Pause** (and markets with `active = false`): only fills in which both sides reduce,
  and no funding. Deposits, withdrawals, cancels and liquidations stay open. The owner or the
  guardian (`setGuardian`, owner only) can pause; only the owner can unpause.

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
  be replaced; before mainnet the owner must be a multisig behind a timelock (the
  deployment script can set one up, see above).** It can add/update markets (margins, fees up to
  1%, penalty up to the maintenance margin, caps), set operators and the fee recipient,
  and pause. Raising the maintenance margin makes accounts liquidatable, so the owner can
  effectively take traders' margin; it must be a multisig behind a timelock. Ownership
  moves in two steps (`Ownable2Step`): the new owner has to accept.
- **Guardian**: can pause, nothing else, and cannot unpause. A malicious guardian can
  halt new position-taking until the owner (through the timelock, if any) unpauses and
  replaces it.
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
  contract holds less USDC than it owes and the last withdrawers cannot be paid, unless
  somebody volunteers to repay it through `depositInsurance`. The insurance fund cannot
  be withdrawn or redeployed.
- **No emergency settlement**: there is no mode in which users can exit a market whose
  price never comes back (see Oracle below).
- **Underwater accounts pay no liquidation reward** (the penalty is capped at the account's
  value), so nobody but a protocol-run keeper has a reason to liquidate them.
- **Liquidators take inventory**: they receive the position at the index price and must
  hedge or unwind it themselves. No close factor: an account one unit under maintenance
  can be liquidated completely. Liquidations are not subject to the minimum fill size.
- **Funding is driven by fills, not by an order-book price.** A fill shortly before an
  accrual, a far-off fill, a stale last trade or a pause can no longer steer it, but in a
  thin market whoever trades alone still sets the premium: a fill above the index early
  in an otherwise quiet period carries that period at up to the capped rate, and
  repeating it every hour costs only fees on the minimum size. An impact/mid price from
  the book would be needed to close this. The rate found at accrual is charged on every
  position open at that moment, also one opened just before it. Funding is not charged
  for time beyond 8 hours without an accrual, nor while the index price is stale, and
  anyone may trigger that zero-rate accrual while the oracle is stale.
  `FundingUpdated.fundingRateBps` is truncated to whole bps; the exact rate is in the
  change of `cumulativeFunding`.
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
- The batch gas floor (800k gas for 2 markets, 2.0M for 8; measured 413k and 998k) was measured with the Chainlink adapter
  over mock aggregators; real feeds sit behind a proxy and cost more per read. Re-measure
  on a fork or on the testnet. It grows with the number of markets.
- EOA signatures only (no ERC-1271 smart accounts, no compact signatures). Orders have no
  time-in-force or post-only semantics on-chain; nonces are only cancellation handles.
  `cancelAllOrders` accepts values up to one day ahead in the (ms timestamp << 64) nonce
  scheme, so a mistaken call can block new orders for at most a day.
- Every margin check loops over all markets (one storage read each, plus an oracle call
  per open position), so gas grows with the number of markets (capped at 16).
- A liquidatable account can still reduce or close its position in-band before it is
  liquidated and thereby pay no penalty. A partial reduction is refused only when it
  would lower `value / maintenance`, i.e. when its cost per unit of maintenance released
  exceeds the account's ratio: at the edge of the band (5% + fee against a 10% maintenance
  rate) that is the case only when the account's value is below roughly half of its
  maintenance requirement. Above that, band-edge reductions are allowed; they avoid the
  penalty and move some equity to the counterparty, but create no bad debt. A full close
  is allowed whenever the account ends with non-negative value.
- Liquidations with a missing price rely on `lastGoodPrice`, which can be arbitrarily
  old if nobody traded or accrued in that market; see Liquidation above.
- The timelock is optional (`TIMELOCK_DELAY_SECONDS`); nothing in the contracts enforces
  a delay, and a deployment without it leaves the multisig as direct owner, with the
  deployer key as owner until the multisig has accepted (`check-deployment.ts` tells).
  With a timelock, oracle and feed recovery also wait out the delay; there is no faster
  emergency path than pausing.
- The testnet deployment script has only run against a local node with stand-in
  contracts. It has not run against Arbitrum Sepolia, and source verification
  (`hardhat verify`) has not been tried. There is no mainnet deployment script.
