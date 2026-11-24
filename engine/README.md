# Baldwin engine

Off-chain matching engine for the Baldwin perpetuals exchange: order intake (EIP-712),
price-time order books, settlement through `Exchange.settleMatches`, REST/WS API, and a
separate liquidation + funding keeper. The contract is the source of truth; the engine
only decides *which* signed orders are matched and in what order.

## Run

```sh
npm install
cp .env.example .env        # set OPERATOR_PRIVATE_KEY (must be an Exchange operator)
npm run dev                 # engine with reload      (npm start: without)
npm run keeper              # separate process, needs KEEPER_PRIVATE_KEY (not the operator key)
npm test && npm run typecheck
```

Needs a running chain and `../contracts/deployments/localhost.json` (see `docs/SPEC.md`).
All settings are in `.env.example`. Private keys are never logged.

The keeper account must hold collateral in the Exchange: the liquidator takes over the
liquidated position and has to margin it. At start-up the keeper warns if its free collateral
is below `KEEPER_MIN_FREE_COLLATERAL`. It does not unwind what it takes over.

`scripts/e2e-local.ts` runs a maker/taker round trip against a local node and a running engine.

## Layout

| Path | What |
|---|---|
| `src/book/orderbook.ts` | Pure order book (no I/O, bigint only) |
| `src/signing.ts` | EIP-712 hashing and signature checks |
| `src/engine/engine.ts` | Intake, books, settlement queue, reconciliation |
| `src/engine/reconcile.ts` | Who is at fault when a match fails on-chain; aggregate margin estimate |
| `src/engine/deadNonces.ts` | Durable set of (trader, nonce) pairs that must never be accepted again |
| `src/settlement/` | `Settler` interface, viem implementation, in-memory fake |
| `src/chain/` | `ChainReader` interface (pre-trade checks, failure diagnosis) + viem implementation |
| `src/api/` | REST + WebSocket |
| `src/keeper/` | Liquidations and funding |

## API

As in `docs/SPEC.md`. Every bigint is a decimal string. Errors: `{ "error": { "code", "message" } }`.

- `POST /orders` `{ order, signature, postOnly?, ioc? }` → `{ orderHash, status, fills[], remaining, reason? }`.
  `fills[]` are the matches made on arrival: `{ makerOrderHash, takerOrderHash, price, size, status: "pending" }`.
  `postOnly` / `ioc` are engine-side flags, not part of the signed order.
- `DELETE /orders/:orderHash` `{ signature }` (EIP-712 `Cancel(trader, nonce)`) → the order view.
- `GET /orders?trader=0x…` → orders that rest or have matches awaiting settlement:
  `{ orderHash, order, status, remaining, pending, filled, postOnly, ioc, reason?, createdAt }`.
- `GET /markets`, `GET /orderbook/:marketId?depth=` (default 50, max 500) → `{ marketId, bids: [{price,size}], asks }`,
  `GET /trades/:marketId?limit=` (newest first), `GET /health`.
- `WS /ws`: `{ op: "subscribe"|"unsubscribe", channel: "orderbook"|"trades", marketId }`, `{ op: "ping" }`.
  `orderbook` sends `{ type: "snapshot", channel, marketId, data: { bids, asks } }` on subscribe and after
  every change (full top-50 book each time). `trades` sends a `snapshot` of recent trades, then
  `{ type: "update", …, data: [trade] }` per confirmed fill.

Order status: `open`, `partially_filled`, `pending_settlement` (fully matched, not yet all confirmed),
`filled` (fully confirmed on-chain), `cancelled`, `expired`, `rejected` (removed after an on-chain failure).

HTTP codes: 400 malformed/invalid (including a missing or out-of-range expiry), 401 bad signature,
404 unknown order, 409 duplicate / nonce dead or reused / already filled, 422 post-only would
cross or is outside the band / insufficient margin / reduce-only without position, 429 rate limit
or trader suspended, 503 exchange paused, market halted (no index price), chain unreachable or
settlement stalled.

`GET /health` also shows what the engine currently believes about the chain: pause flag, and per
market the index price and price band. WebSocket connections are capped per IP and in total.

## Matching rules

- Price-time priority; the fill price is the resting order's limit price. A "market order" is a
  limit order with an aggressive price (usually with `ioc`).
- **Self-trade prevention — cancel newest:** when the next order an incoming order would trade
  with belongs to the same trader, matching stops and the incoming order's unfilled remainder is
  cancelled. Earlier fills stand; resting orders are not touched.
- **Price band.** The contract only accepts fills with `|price − index| · 10000 ≤ index ·
  maxPriceDeviationBps`. The engine re-reads the index every `CHAIN_REFRESH_MS` and mirrors
  the band `[lo, hi]`:
  - no bid may rest above `hi` and no ask below `lo` (an order there could only ever fill outside
    the band). An incoming order's remainder that would rest there is cancelled instead; resting
    orders that end up there after the index moved are cancelled at the next refresh;
  - an incoming order trades as if its limit were clamped into the band. Nothing is skipped:
    makers outside the band are behind every maker inside it in price priority, so matching just
    stops when the next maker is outside;
  - orders beyond the far side (bid below `lo`, ask above `hi`) rest normally and become
    matchable when the band reaches them.
- **Post-only** orders never take: rejected on arrival if they would cross, and cancelled if
  liquidity returned to an older order would make them the taker.
- **IOC** orders never rest, also not after a restart (their nonce is dead once accepted).
- **Paused exchange / inactive market:** only reduce-only orders are accepted while the exchange
  is paused (none for an inactive market), and an order trades only with reduce-only makers:
  matching stops at the first maker that is not reduce-only and the remainder is cancelled.
  (`reduceOnly` is the engine's proxy for "reducing"; the contract checks the real position.)
- **Halted market:** while a market's index price cannot be read, new orders for it are refused
  (503); cancels still work.
- Minimum size: `order.size >= market.minOrderSize`. Fills can be smaller only when they complete
  one of the two orders, which is what the contract allows (a remainder below the minimum,
  including one resubmitted after a restart, rests and is filled in one piece).
- **Expiry is mandatory**: at least `MIN_TIME_TO_EXPIRY_SEC` (60 s) and at most
  `MAX_TIME_TO_EXPIRY_SEC` (7 days) ahead. Resting orders leave the book `EXPIRY_BUFFER_SEC`
  (30 s) before their expiry so that a match cannot reach the chain too late.
- One order per (trader, nonce). A signed `Cancel` or an on-chain `OrderCancelled` kills the nonce.
- Only canonical 65-byte EOA signatures (v 27/28, low s) are accepted, matching the contract's ECDSA check.
- **Pre-trade check** (`PRETRADE_CHECKS`): nonce not cancelled and order not filled on-chain;
  reduce-only has an opposite position; free collateral covers this order **together with all
  the trader's other open orders**: initial margin on the worst-case exposure, plus taker fees
  and the loss of filling at the limit (clamped into the band) rather than at the index.
  Submissions of one trader are processed one at a time so that concurrent orders cannot dodge it.
- **Suspension:** a trader whose orders were at fault in `FAULT_THRESHOLD` on-chain failures
  within `FAULT_WINDOW_SEC` gets new orders refused (429) until the window has passed.

## Dead nonces (what a cancel is worth)

A signed `Cancel` reaches only the engine; the contract knows nothing about it. The engine
therefore keeps a durable set of dead (trader, nonce) pairs in `DEAD_NONCES_PATH` (append-only,
fsync'd before a cancel is acknowledged, loaded at start-up) and refuses any order whose pair is
in it. A pair goes in when the order is cancelled by its trader (off-chain or on-chain), is an
IOC order, has its remainder cancelled by the engine (self-trade, band, pause, post-only), or is
rejected after an on-chain failure. Entries are dropped once the order's expiry has passed,
which, with the 7-day expiry cap, bounds the set. The file is compacted on start-up.

- Protects against: anyone re-posting a cancelled or closed order (the order and its signature
  are public once one fill of it is on-chain), including after an engine restart.
- Does **not** protect against the operator: a signed, unexpired order stays valid on-chain. A
  compromised or malicious operator can still settle an order its trader cancelled off-chain.
  Only `Exchange.cancelOrder(nonce)` binds the contract; the mandatory expiry limits how long
  such an order stays executable.
- If the file is lost, cancelled orders that have not yet expired can be re-posted again.

## Consistency model

**The book is optimistic, the tape is confirmed.**

1. A match takes liquidity out of the book immediately and is queued for settlement. The
   `POST /orders` response reports it as a `pending` fill; the orders show it under `pending`.
2. Matches are settled in match order, in batches, one transaction at a time. Nothing is
   published on `/trades` or the `trades` channel, and nothing counts as `filled`, until the
   transaction is mined and the match has no `MatchFailed` event.
3. If a match fails on-chain, neither order was filled by it. The engine first re-reads pause
   flag and index prices, then decides:
   - **Revert data names a trader** (`InsufficientMargin`, `NegativeAccountValue`,
     `ReduceOnlyViolated`) → that side is at fault, the other is innocent.
   - **Revert data is a global condition** (`StalePrice`, `PriceOutOfBand`, `OnlyReducingAllowed`,
     `OpenInterestCapExceeded`; also `FillTooSmall`, which can only follow an earlier failure)
     → nobody is at fault.
   - **Otherwise contract views**, in this order: a definitive per-order cause (nonce cancelled,
     already filled, expired by block time) puts exactly those sides at fault and clears the
     other; else a global condition seen in views (paused, index unreadable, price outside the
     band, open interest at the cap); else, as a last resort, a margin estimate per side.
   What happens to the orders:
   - **At fault** → removed for good (`rejected`), nonce dead, counted against the trader.
   - **Innocent** → gets the size back. A resting order returns with its original time priority;
     if orders that arrived in the meantime now cross it, they are matched right away (older
     order is the maker). An IOC order is matched once more against the remaining book and
     whatever is left is cancelled. Not given back: orders the trader cancelled meanwhile,
     expired orders, orders now on the wrong side of the band.
   - **Global condition** → the taker is cancelled (not its fault, no penalty), the maker gets
     its size back, **no strike**.
   - **Nothing identifiable** → the taker is dropped, the maker gets its size back and a strike;
     three consecutive strikes remove the maker.
   In every case the same pair cannot be matched again, so no order retries a failing match forever.
4. A cancel removes the unmatched remainder at once. Matches already queued or in flight are
   not recalled and may still settle.

### Submission failures

- Each batch is bound to one operator nonce when first signed. Re-broadcasts and fee bumps reuse
  that nonce and the same calldata, and the outcome is looked up by the locally computed
  transaction hashes, so a batch cannot settle twice whatever the RPC answers.
- A transaction that stays unmined for two broadcast rounds is replaced with 25% higher fees,
  whether or not the broadcast call itself reported an error, up to `MAX_FEE_PER_GAS_GWEI`.
- The binding is released only when one of the batch's transactions is mined, or when the nonce
  is gone on-chain, none of the batch's transactions has a receipt after extra polls **and**
  on-chain `filledSize` of every order in the batch is unchanged since before the first
  broadcast (so the chain itself shows nothing of the batch was applied). If `filledSize` moved,
  the settler keeps waiting for the receipt.
- While a batch's outcome is unknown the engine keeps retrying *that* batch, submits nothing
  else, reports `stalled` on `/health`, and refuses new orders with 503.
- A batch whose transaction reverted as a whole (e.g. the contract's `InsufficientGas`), or would
  revert in gas estimation, did not settle; it is retried up to three times and then its matches
  are failed as "nothing identifiable". The gas limit is 1.5× the estimate plus the contract's
  per-match gas floor.
- A mined transaction is final for the engine (one confirmation).

## Known limitations

- **The book is in memory.** A restart loses the book, order history and trades (dead nonces are
  kept). Matches that were queued but not yet sent are lost; a transaction in flight still lands
  on-chain. Traders must resubmit their orders; with `PRETRADE_CHECKS=true` the on-chain filled
  size and cancels are honoured on resubmission. Order records are never evicted.
- **Single operator key, single process.** Sequential transactions bound the throughput to one
  batch (`MAX_BATCH_SIZE` matches) per block. No other process may use the operator key.
- **One-confirmation finality**, no reorg handling.
- **Operator trust**: the engine decides ordering and can censor; it cannot move funds without
  two valid signatures, but it can settle a signed order its trader cancelled only off-chain
  (see "Dead nonces"). Traders can always cancel on-chain.
- **Optimistic fills can be undone.** A `pending` fill is a promise the chain may refuse.
- **The band follows the engine's last index read** (`CHAIN_REFRESH_MS`). Between an oracle move
  and the next refresh, matches can still fail with `PriceOutOfBand`; that costs a failed match,
  no strike. Orders pushed onto the wrong side of the band by an index move are cancelled, not
  parked.
- **Margin is still only estimated off-chain.** The aggregate pre-trade check is conservative but
  balances change after it (withdrawals, losses); such makers are removed after their first
  failed match and their trader is suspended after a few. Reduce-only orders are not
  margin-checked. The last-resort fault estimate can be wrong; that costs an order its place in
  the book, never a wrong settlement.
- While paused, "reducing" is approximated by the `reduceOnly` flag: reducing orders without the
  flag do not trade until the pause ends.
- Fault counters, strikes and the suspension list are in memory and reset on restart.
- The dead-nonce file is written synchronously (one fsync per cancel or closed order) and is only
  compacted at start-up.
- EOA signatures only (no EIP-1271). Rate limiting is per IP and in memory; set `TRUST_PROXY`
  only behind a proxy. The WebSocket book feed sends full snapshots, not deltas.
- Keeper: only knows accounts from `Fill`/`Liquidation` events since `KEEPER_START_BLOCK`
  (rescanned on every start), does not hedge or unwind positions it takes over, and does not
  check profitability.
