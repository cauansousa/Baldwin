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

Needs Node 22.13+ (it uses the built-in `node:sqlite`), a running chain and a deployment file
(`../contracts/deployments/localhost.json` by default, see `docs/SPEC.md`). All settings are in
`.env.example`; `.env.testnet.example` is a starting point for Arbitrum Sepolia. Keys come from
the environment only and are never logged. The engine refuses to start if the RPC's chain id
differs from the deployment file, if its account is not an operator of the Exchange, or if that
account has no ETH.

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
| `src/engine/deadNonces.ts` | Interface of the set of (trader, nonce) pairs that must never be accepted again |
| `src/store/` | Durable state: `EngineStore` interface and its SQLite implementation |
| `src/chain/logPoller.ts`, `cancelWatcher.ts` | Block-range log polling with a stored cursor; on-chain cancels |
| `src/metrics.ts` | Prometheus text metrics |
| `src/settlement/` | `Settler` interface, viem implementation, in-memory fake |
| `src/chain/` | `ChainReader` interface (pre-trade checks, failure diagnosis) + viem implementation |
| `src/api/` | REST + WebSocket |
| `src/keeper/` | Liquidations and funding |

## API

As in `docs/SPEC.md`. Every bigint is a decimal string.

- `POST /orders` `{ order, signature, postOnly?, ioc? }` →
  `{ orderHash, status, fills[], remaining, pending, filled, reason?, duplicate? }`.
  `fills[]` are the matches made on arrival: `{ makerOrderHash, takerOrderHash, price, size, status: "pending" }`.
  `postOnly` / `ioc` are engine-side flags, not part of the signed order.
  **Idempotent by order hash**: see "Retrying" below.
- `DELETE /orders/:orderHash` `{ signature, trader?, nonce? }` (EIP-712 `Cancel(trader, nonce)`)
  → the order view. The cancel (dead nonce and the order's new state, one transaction) is on disk
  before the answer is sent. If the engine does not know the order hash:
  - with `trader` and `nonce`: the signature is checked against them, the nonce is recorded as
    dead durably, and the answer is 200 `{ orderHash, status: "cancelled", known: false }` — an
    order still in transit cannot land afterwards;
  - without them the signature cannot be checked: 404 `NOT_FOUND`, nothing recorded.
  Clients should always send `trader` and `nonce`.
- `GET /orders?trader=0x…` → orders that rest or have matches awaiting settlement:
  `{ orderHash, order, status, remaining, pending, filled, postOnly, ioc, reason?, createdAt }`.
- `GET /markets`, `GET /orderbook/:marketId?depth=` (default 50, max 500) → `{ marketId, bids: [{price,size}], asks }`,
  `GET /trades/:marketId?limit=` (newest first), `GET /health`, `GET /metrics`.
- `WS /ws`: `{ op: "subscribe"|"unsubscribe", channel: "orderbook"|"trades", marketId }`, `{ op: "ping" }`.
  `orderbook` sends `{ type: "snapshot", channel, marketId, data: { bids, asks } }` on subscribe and after
  every change (full top-50 book each time). `trades` sends a `snapshot` of recent trades, then
  `{ type: "update", …, data: [trade] }` per confirmed fill. Connections are capped per IP and in total.

Order status: `open`, `partially_filled`, `pending_settlement` (fully matched, not yet all confirmed),
`filled` (fully confirmed on-chain), `cancelled`, `expired`, `rejected` (removed after an on-chain failure).

### Errors

Every error is `{ "error": { "code", "message", "outcome" } }`. `outcome` says what the client
may conclude:

- `not_applied` — the request changed nothing. Fix it or retry it.
- `unknown` — the request may or may not have taken effect. Only `STATE_UNKNOWN` and `INTERNAL`.

| HTTP | code | outcome | meaning |
|---|---|---|---|
| 400 | `BAD_REQUEST` | not_applied | malformed JSON / fields |
| 400 | `UNKNOWN_MARKET`, `MARKET_INACTIVE`, `INVALID_ORDER`, `BELOW_MIN_SIZE`, `EXPIRED`, `INVALID_EXPIRY` | not_applied | the order itself is unacceptable (`INVALID_ORDER` includes a nonce above `((now + 1 day) in ms) << 64`) |
| 401 | `BAD_SIGNATURE` | not_applied | order or cancel signature does not match |
| 404 | `NOT_FOUND` | not_applied | unknown route; cancel of an unknown order without `trader`/`nonce` |
| 409 | `NONCE_CANCELLED` | not_applied | the nonce is dead (cancelled off-chain or on-chain, below `minValidNonce`, or its order was closed) |
| 409 | `NONCE_REUSED` | not_applied | a different order of this trader already uses the nonce |
| 409 | `ALREADY_FILLED` | not_applied | fully filled on-chain |
| 422 | `POST_ONLY_WOULD_CROSS`, `PRICE_OUTSIDE_BAND` | not_applied | post-only order would take, or is on the wrong side of the band |
| 422 | `INSUFFICIENT_MARGIN`, `REDUCE_ONLY_NO_POSITION`, `REDUCE_ONLY_EXCEEDS_POSITION` | not_applied | pre-trade checks |
| 429 | `RATE_LIMITED` | not_applied | per IP (all routes, `Retry-After` set) or per trader (orders) |
| 429 | `TRADER_SUSPENDED` | not_applied | too many of the trader's orders failed on-chain recently |
| 503 | `CHAIN_UNAVAILABLE` | not_applied | chain unreadable, chain checks exceeded `INTAKE_TIMEOUT_MS`, or settlement stalled |
| 503 | `MARKET_HALTED`, `EXCHANGE_PAUSED` | not_applied | no index price for the market / exchange paused (non-reduce-only orders) |
| 503 | `RECOVERING`, `SHUTTING_DOWN` | not_applied | engine starting up after a restart / shutting down |
| 503 | `STORE_UNAVAILABLE` | not_applied | the engine cannot persist; for a cancel: the cancel was **not** recorded |
| 503 | `STATE_UNKNOWN` | **unknown** | the order was processed but could not be persisted |
| 500 | `INTERNAL` | **unknown** | bug or broken dependency (logged) |

(`DUPLICATE_ORDER` is no longer returned for a resubmission; it remains in the type for the
order book's own duplicate guard.)

### Retrying

`POST /orders` is idempotent by order hash. Submitting the **identical signed order** again
returns **200** with the order's current state and `duplicate: true` (`fills` is empty then; use
`status`, `remaining`, `pending`, `filled`), and changes nothing; the flags of the first submission
stay in force. So after a timeout, a dropped connection, `STATE_UNKNOWN` or any 5xx a client
simply sends the same request again:

- 200 without `duplicate` → it was not there before and is accepted now;
- 200 with `duplicate: true` → the earlier attempt had gone through; this is its state;
- 409 `NONCE_CANCELLED` → it was cancelled or closed in the meantime (or pruned after expiry: `EXPIRED`).

Server-side time per request is bounded: chain reads and waiting for the trader's earlier
submissions may take at most `INTAKE_TIMEOUT_MS` (8 s), after which the order is refused with
`CHAIN_UNAVAILABLE` and is definitely not accepted. `DELETE /orders` is idempotent as well.

### Health

`GET /health` → `{ ok, recovering, warnings[], settlement, chain, operator, operatorBalanceWei,
operatorBalanceEth, confirmations, cancelWatcherBlock, … }`. `ok` is false while the engine is
recovering, settlement is stalled or the store is broken. `warnings` lists: recovering, a low
operator balance, a stalled settlement, the operator being unable to pay for a settlement
transaction, a transaction stuck at the fee cap, a broken store, a paused exchange, halted markets.
`chain` is what the engine currently believes: pause flag and, per market, index price and price band.

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
- Nonces are expected to grow over time (a millisecond timestamp in the high bits). A nonce above
  `((now + 1 day) in ms) << 64` is refused: the contract could never bulk-cancel it.
- One order per (trader, nonce). A signed `Cancel` or an on-chain `cancelOrder` kills the nonce;
  an on-chain `cancelAllOrders(minValidNonce)` kills every nonce of the trader below it. Both
  on-chain cancels are picked up from events within `LOG_POLL_INTERVAL_MS` and remove the
  resting orders; they are also checked at intake and when a match fails.
- Only canonical 65-byte EOA signatures (v 27/28, low s) are accepted, matching the contract's ECDSA check.
- **Pre-trade check** (`PRETRADE_CHECKS`): nonce not cancelled and order not filled on-chain;
  reduce-only has an opposite position; free collateral covers this order **together with all
  the trader's other open orders**: initial margin on the worst-case exposure, plus taker fees
  and the loss of filling at the limit (clamped into the band) rather than at the index.
  Submissions of one trader are processed one at a time so that concurrent orders cannot dodge it.
  Reduce-only orders are not margin-checked, but all of a trader's reduce-only orders on one
  side of a market together may not exceed the position they reduce. Chain reads are reused per
  trader for `PRETRADE_CACHE_MS`, and orders are also rate-limited per trader address
  (`TRADER_ORDERS_PER_MINUTE`, counted only for validly signed orders).
- **Faults and suspension:** when an order fails on-chain through its trader's own doing
  (margin, reduce-only), the trader's other resting orders that would fail the same way are
  cancelled at once (margin: all non-reduce-only orders; reduce-only: the reduce-only orders on
  that side of that market). `FAULT_THRESHOLD` such failures within `FAULT_WINDOW_SEC` suspend
  the trader: all resting orders are cancelled and new ones refused (429) until the window has
  passed. An order that merely turns out cancelled, filled or expired on-chain is removed
  without counting.

## Dead nonces (what a cancel is worth)

A signed `Cancel` reaches only the engine; the contract knows nothing about it. The engine
therefore keeps a durable set of dead (trader, nonce) pairs in its store (written and fsync'd
before a cancel is acknowledged) and refuses any order whose pair is in it. A pair goes in when
the order is cancelled by its trader (off-chain or on-chain), is an IOC order, has its remainder
cancelled by the engine (self-trade, band, pause, post-only), or is rejected after an on-chain
failure. Entries are dropped once the order's expiry has passed, which, with the 7-day expiry
cap, bounds the set.

- Protects against: anyone re-posting a cancelled or closed order (the order and its signature
  are public once one fill of it is on-chain), including after an engine restart.
- Does **not** protect against the operator: a signed, unexpired order stays valid on-chain. A
  compromised or malicious operator can still settle an order its trader cancelled off-chain.
  Only `cancelOrder` / `cancelAllOrders` bind the contract; the mandatory expiry limits how long
  such an order stays executable.
- If the store is lost, cancelled orders that have not yet expired can be re-posted again.

## Durable state and restarts

**Storage: one SQLite file (`STORE_PATH`) through Node's built-in `node:sqlite`.** Chosen over a
hand-written journal because the engine needs multi-row atomicity (a match changes two orders
and adds a settlement record; a batch result changes many orders, removes matches and adds
trades), and SQLite's write-ahead log gives that, plus crash recovery and compaction, without
code of ours to get wrong and without a native build step. `node:sqlite` is synchronous, which
fits: every engine operation is a synchronous critical section followed by one commit. The cost:
the module is still marked experimental in Node 22 (pin the Node version), and each commit is an
fsync (`journal_mode=WAL`, `synchronous=FULL`), which bounds order throughput to what the disk
can sync. All SQL sits behind the `EngineStore` interface.

What is stored: every accepted order (signed order, signature, post-only/IOC flags, time
priority, resting / pending / filled sizes, cancel and close state) until it is finished and
past its expiry; every match that has no final on-chain outcome yet, with its batch; the
settler's record of the batch in flight (nonce, every signed transaction, the `filledSize`
baseline); recent trades; dead nonces and `minValidNonce` per trader; the log cursor.

Durability guarantees:

- An order is on disk, together with the matches it produced (and, for IOC orders, its dead
  nonce), in one commit before `POST /orders` answers. If that commit fails the client gets 503
  `STATE_UNKNOWN`, intake halts (`STORE_UNAVAILABLE`) until writes work again, and nothing of
  the order is broadcast before it is on disk (a batch is only sent after a successful commit
  that includes everything pending).
- A cancel — the dead nonce **and** the order's cancelled state — is one commit, made before
  anything changes in memory and before `DELETE /orders/:hash` answers. If it fails the client
  gets 503 `STORE_UNAVAILABLE` and the order is exactly as it was. As a second line of defence,
  an order found resting in the store although its nonce is dead is closed when the store is loaded.
- Writes whose failure is not reported to a client (expiry sweeps, band cancels, settlement
  results) are re-derivable: after a restart the same facts are found again from the chain and
  the clock. They are retried with the next write.
- The store file belongs to one engine process: it is opened in exclusive locking mode with a
  short busy timeout, so a second process pointed at it fails at once.
- A commit is atomic. After a crash, including in the middle of a write, the store opens at the
  last complete commit; a torn tail of the log is discarded.
- A settlement transaction is recorded (signed bytes and nonce) **before** it is broadcast, and
  the matches of a batch are marked as belonging to it before the settler is called.

On start-up the API is opened at once, `GET /health` reports `recovering: true` and orders are
refused with 503 `RECOVERING` until `engine.recover()` has finished:

1. Orders, books (same time priority), unsettled matches and trades are loaded.
2. Cancels first: every resting order is checked against `isCancelled` (covers `cancelOrder`
   and `cancelAllOrders`), cancel events since the stored cursor are replayed, expired orders
   are dropped. Nothing cancelled while the engine was down can be matched or re-crossed.
3. The batch that was in flight when the process died is resolved from the chain: the settler
   looks up the receipts of the transactions it recorded; if none was mined it re-broadcasts the
   same signed transaction (same nonce). If the nonce is gone and no receipt exists, on-chain
   `filledSize` decides whether anything of the batch was applied. Results are then applied
   exactly as in normal operation, so matches that settled are never sent again and matches that
   failed give their liquidity back. Matches that were queued but never sent are sent now.
4. Every resting order's fill state is corrected to on-chain `filledSize`.

If the chain cannot be read, or recovery is not done within `RECOVERY_TIMEOUT_MS` (an in-flight
batch with the RPC down), the process exits non-zero instead of serving unverified state; the
process manager starts it again.

Not stored: per-order strike counters are, but trader fault counters and suspensions are not
(they reset on restart). Losing the file means losing the book and the dead nonces: traders must
resubmit, and on-chain state (`filledSize`, cancels) is still honoured through the pre-trade checks.

## Chain watching

The engine never relies on websocket subscriptions or server-side filters. On-chain cancels
(`OrderCancelled`, `OrdersCancelledBelow`) are read with `eth_getLogs` over block ranges, with
the cursor (last fully handled block) in the store.

- The block span is halved when a query is refused (range or response limits, rate limits) and
  grows back after successes; failed passes are retried with exponential backoff up to 30 s.
- `eth_getLogs` is not trusted up to the head: a backend that is a block behind the one that
  reported the head answers with fewer logs and no error. Scanning stops `LOG_HEAD_LAG_BLOCKS`
  (default 2) short of the head, and every pass reads the last `LOG_RESCAN_BLOCKS` (default 5,
  at least `CONFIRMATIONS`) blocks again. Events are applied idempotently, so re-reading is harmless.
  The price is that an on-chain cancel takes effect in the engine `LOG_HEAD_LAG_BLOCKS` blocks
  late; on a local automine chain set it to 0.
- The cursor only advances after a range was applied, so a restart continues where it stopped.
- Pause flag, index prices and market parameters are polled (`CHAIN_REFRESH_MS`); every JSON-RPC
  request is retried a few times by the transport. RPC URLs never appear in logs or error
  messages (they commonly carry an API key).

Oracle failures (stale feed, L2 sequencer down or in its grace period, …) make `indexPrice` and
the account views revert. The engine treats that as "market halted": no new orders for that
market (503), resting orders kept, nothing matched; a match that fails for such a reason costs
nobody a strike. It resumes by itself when the views work again.

## Finality

`CONFIRMATIONS` (default 1) is the number of blocks a settlement transaction must be buried under
before its fills are reported as confirmed (trade tape, `filled`). While waiting, the engine
re-reads the receipt: if the transaction was reorged out it goes back to waiting for it (the
signed transaction stays valid and is re-broadcast), and reports whatever outcome it finally has.

A reorg **deeper** than `CONFIRMATIONS` is not detected while running. The engine would then
show trades whose transaction no longer exists or ended differently, and order `filled` sizes
that differ from the chain. Funds are not affected (the chain decides), and a transaction that
was dropped can still be mined later as it stays valid. Restarting the engine repairs resting
orders (step 3 above); trades already published are not retracted. On Arbitrum, reorgs of blocks
the sequencer has published are not expected in normal operation; choose `CONFIRMATIONS` for the
chain you run on.

## Operations

- **Logs**: one JSON object per line (`level`, `time`, `component`, `msg`, context). `info` on
  stdout, `warn`/`error` on stderr. `LOG_LEVEL` filters.
- **`GET /health`**: see API. Use `ok` for liveness/readiness and alert on `warnings`.
- **`GET /metrics`** (Prometheus text, no dependency): `baldwin_orders_accepted_total`,
  `baldwin_orders_rejected_total{code}`, `baldwin_orders_duplicate_total`, `baldwin_orders_cancelled_total`,
  `baldwin_matches_settled_total`, `baldwin_matches_failed_total`, `baldwin_batches_total`,
  `baldwin_batch_errors_total`, `baldwin_batch_latency_seconds` (histogram),
  `baldwin_settlement_queue_depth`, `baldwin_settlement_stalled`, `baldwin_resting_orders`,
  `baldwin_exchange_paused`, `baldwin_settler_insufficient_funds`, `baldwin_settler_fee_cap_reached`,
  `baldwin_store_broken`, `baldwin_recovering`, `baldwin_operator_balance_eth`, `baldwin_rpc_errors_total{method}`,
  `baldwin_cancel_watcher_block`. The endpoint is not authenticated: expose it to your
  monitoring network only.
- **Shutdown**: on SIGTERM/SIGINT the engine refuses new orders (503 `SHUTTING_DOWN`; cancels and
  reads still work), waits up to `SHUTDOWN_TIMEOUT_MS` for the batch in flight, terminates
  WebSocket clients, closes idle connections and the listener, closes the store and exits.
  A second signal, or `SHUTDOWN_TIMEOUT_MS` + 10 s, ends the process in any case (the store is
  closed first). Anything unresolved is picked up by the next start.
- Unexpected errors in a request (HTTP 500) are written to the JSON log with route and a short stack.

## Running on testnet (Arbitrum Sepolia)

1. Deploy with `contracts/scripts/deploy-testnet.ts`; it writes
   `contracts/deployments/arbitrumSepolia.json` and sets the operator.
2. `cp .env.testnet.example .env` and set at least:
   - `RPC_URL` (a provider endpoint; the public one is rate-limited), `DEPLOYMENT_PATH`;
   - `OPERATOR_PRIVATE_KEY`: the operator account, funded with Arbitrum Sepolia ETH, used by
     nothing else;
   - `KEEPER_PRIVATE_KEY`: a different account with ETH, and USDC deposited in the Exchange;
   - `KEEPER_START_BLOCK` and `START_BLOCK`: the block in which the Exchange was deployed.
     Both default to `deploymentBlock` from the deployment file, which
     `contracts/scripts/deploy-testnet.ts` records. Set them only for a deployment file
     without it (the keeper then refuses to start on a non-local chain until it is given);
   - `STORE_PATH` / `KEEPER_STATE_PATH` on a persistent disk; `CORS_ORIGIN`; `CONFIRMATIONS`.
   Nothing in the engine is tied to a particular chain: the chain id comes from the deployment
   file, fees are EIP-1559 values from the node, and gas limits come from `eth_estimateGas`,
   which on Arbitrum includes the L1 data cost.
3. Run engine and keeper as two long-lived processes under a process manager that restarts
   them and sends SIGTERM to stop. With systemd, per unit:
   ```ini
   [Service]
   WorkingDirectory=/srv/baldwin/engine
   EnvironmentFile=/srv/baldwin/engine/.env
   ExecStart=/usr/bin/npm start          # keeper unit: npm run keeper
   Restart=always
   RestartSec=2
   TimeoutStopSec=45                     # more than SHUTDOWN_TIMEOUT_MS
   ```
   (pm2 or a container with a restart policy work the same way; `stop_grace_period` /
   `kill_timeout` must exceed `SHUTDOWN_TIMEOUT_MS`.) Run exactly **one** engine per operator
   key and per store file. Put a TLS-terminating reverse proxy in front (it must pass WebSocket
   upgrades on `/ws`; set `TRUST_PROXY=true`), and do not expose `/metrics` publicly.
4. Monitor:
   - `/health`: `ok` false or any `warnings` (stalled settlement, low operator balance, paused
     exchange, halted market);
   - `baldwin_settlement_stalled` = 1 or `baldwin_settlement_queue_depth` growing;
   - `baldwin_operator_balance_eth` falling towards zero (settlement stops when it is empty),
     `baldwin_settler_insufficient_funds` / `baldwin_settler_fee_cap_reached` = 1,
     `baldwin_store_broken` = 1, `baldwin_recovering` staying at 1;
   - `rate(baldwin_rpc_errors_total)` and `baldwin_cancel_watcher_block` not advancing (RPC trouble);
   - `rate(baldwin_matches_failed_total)` against `…_settled_total` (stale band, unfunded makers);
   - `baldwin_batch_latency_seconds` (inclusion time), `rate(baldwin_batch_errors_total)`;
   - process restarts, `error` log lines, disk space for the store;
   - keeper: its "keeper alive" log line every ~5 minutes, `liquidation failed` warnings, its ETH
     and its free collateral in the Exchange.
5. Back up `STORE_PATH` with the engine stopped (or copy it together with its `-wal` file).

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
   - **At fault** → removed for good (`rejected`), nonce dead. If the cause is the trader's own
     doing (margin, reduce-only) it counts against the trader and their similar resting orders
     are pulled (see "Faults and suspension"); an order that was merely cancelled, filled or
     expired on-chain is removed without counting.
   - **Innocent** → gets the size back. A resting order returns with its original time priority;
     if orders that arrived in the meantime now cross it, they are matched right away (older
     order is the maker; a post-only order is never made the taker). An IOC order is matched
     once more against the remaining book and whatever is left is cancelled. Not given back:
     orders the trader cancelled meanwhile, expired orders, orders now on the wrong side of the band.
   - **Global condition** → nobody is at fault, **no strike**, and only the failed fill is
     undone. If the taker no longer rests (fully matched, or IOC), the maker gets the size back
     and the taker's failed slice is dropped. If the taker still rests, re-posting the slice
     would re-match the same pair at once and fail again, so the slice is dropped on **both**
     sides and both orders keep everything else they have resting.
   - **`FillTooSmall`** (a sub-minimum fill only fails when an earlier fill of the order it was
     to complete has failed) → both sides get the size back and are matched again, now for the
     maker's whole remainder; the maker gets a strike so that this cannot repeat for ever.
   - **Nothing identifiable** → the taker is dropped, the maker gets its size back and a strike;
     three consecutive strikes remove the maker.
   In every case the same pair cannot be matched again unchanged, so nothing retries for ever.
4. A cancel removes the unmatched remainder at once. Matches already queued or in flight are
   not recalled and may still settle.

### Submission failures

- Each batch is bound to one operator nonce when first signed. Re-broadcasts and fee bumps reuse
  that nonce and the same calldata, and the outcome is looked up by the locally computed
  transaction hashes, so a batch cannot settle twice whatever the RPC answers.
- A transaction that stays unmined for two broadcast rounds is replaced with 25% higher fees,
  whether or not the broadcast call itself reported an error, up to `MAX_FEE_PER_GAS_GWEI`
  (100 gwei unless configured). If a node refuses a replacement because the operator cannot pay
  for it, bumping stops and the highest-fee transaction a node did accept keeps being
  re-broadcast. Both conditions show in `/health` (`warnings`, `settlement.insufficientFunds`,
  `settlement.feeCapReached`) and in the metrics until the batch is mined.
- The binding is released only when one of the batch's transactions is mined, or when — all read
  as of one pinned block that is `CONFIRMATIONS` deep — the nonce is consumed, none of the
  batch's transactions has a receipt after extra polls **and** on-chain `filledSize` of every
  order in the batch is unchanged since before the first broadcast (so the chain itself shows
  nothing of the batch was applied). If `filledSize` moved, the settler keeps waiting for the receipt.
- After a restart with no batch in flight, the next operator nonce is taken from the chain.
- While a batch's outcome is unknown the engine keeps retrying *that* batch, submits nothing
  else, reports `stalled` on `/health`, and refuses new orders with 503.
- A batch whose transaction reverted as a whole (e.g. the contract's `InsufficientGas`), or would
  revert in gas estimation, did not settle; it is retried up to three times and then its matches
  are failed as "nothing identifiable". The gas limit is `max(estimate × 1.5, matches × floor +
  300,000)`, where floor is the contract's per-match gas floor (`MATCH_GAS_FLOOR_BASE` +
  `MATCH_GAS_FLOOR_PER_MARKET` × markets, currently 400,000 + 200,000 × markets): the estimate
  alone would be too low when a match fails cheaply at estimation but runs fully at inclusion.
  The two constants are read from the contract at start-up; the settings are the fallback.
- A transaction counts as final once it is `CONFIRMATIONS` blocks deep (see "Finality").
- All of this survives a restart: the batch in flight is recorded before it is broadcast (see
  "Durable state and restarts").

## Known limitations

- **Single operator key, single process, single store file.** No replication or fail-over.
  Sequential transactions bound the throughput to one batch (`MAX_BATCH_SIZE` matches) per
  inclusion; every accepted order costs one fsync.
- **Reorgs deeper than `CONFIRMATIONS` are not detected** while running (see "Finality").
- **`node:sqlite` is experimental in Node 22.** The store is one file on one disk; if it is lost
  the book and the dead nonces are lost with it.
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
- Start-up reads `filledSize` and `isCancelled` once per resting order (in parallel chunks, no
  multicall): slow with a very large book and a rate-limited RPC.
- Trader fault counters, suspensions and per-trader rate-limit windows are in memory and reset
  on restart.
- Under a global condition the failed slice of a still-resting taker (and of its maker) is
  dropped rather than re-posted; such an order ends `cancelled` with less than its size filled.
  Its nonce is not dead: the remainder can only be traded with a new order.
- The contract's rule that a reducing fill by an account already below maintenance must not
  worsen its health is not mirrored pre-trade; it shows up as `InsufficientMargin(trader)` and
  is handled as a fault of that trader.
- A cancel for an order the engine has never seen needs `trader` and `nonce` in the request;
  with only the hash it is a 404 and protects nothing.
- Some nodes cannot estimate gas for `settleMatches` (seen with Hardhat's node, whose search
  does not cope with the contract's per-match gas floor). The engine then uses the computed
  budget after an `eth_call` check; that fallback does not include an L2's L1 data cost.
- The per-match gas floor is read once at start-up (public constants `MATCH_GAS_BASE`,
  `MATCH_GAS_PER_MARKET`; settings as fallback) and the market count likewise: restart the
  engine after markets are added.
- `/metrics` and `/health` are unauthenticated. Rate limiting is per IP and in memory; set
  `TRUST_PROXY` only behind a proxy. EOA signatures only (no EIP-1271). The WebSocket book feed
  sends full snapshots, not deltas.
- Keeper: knows accounts from `Fill`/`Liquidation` events since `KEEPER_START_BLOCK` (cursor and
  accounts are saved in `KEEPER_STATE_PATH`; a long history is read a few ranges per tick while
  known accounts are already being checked), forgets a position only after it read as zero on
  three consecutive ticks, backs off (2, 4, … 64 ticks) on a position it could not liquidate,
  uses `isLiquidatableIn` when another market's feed is down, calls `updateFunding` only when
  the latest block's timestamp is a full interval past `lastFundingTime`, does not hedge or unwind positions it takes over,
  does not check profitability, exposes no metrics endpoint (logs only), and sends its
  transactions without the engine's nonce/fee-bump machinery.
