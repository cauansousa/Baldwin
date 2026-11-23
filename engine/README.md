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

The keeper account must hold collateral in the Exchange: in the current contract the
liquidator takes over the liquidated position and has to margin it. The keeper does not
unwind what it takes over.

## Layout

| Path | What |
|---|---|
| `src/book/orderbook.ts` | Pure order book (no I/O, bigint only) |
| `src/signing.ts` | EIP-712 hashing and signature checks |
| `src/engine/engine.ts` | Intake, books, settlement queue, reconciliation |
| `src/engine/reconcile.ts` | Who is at fault when a match fails on-chain |
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

HTTP codes: 400 malformed/invalid, 401 bad signature, 404 unknown order, 409 duplicate / nonce
cancelled or reused / already filled, 422 post-only would cross / insufficient margin /
reduce-only without position, 429 rate limit, 503 chain unreachable or settlement stalled.

## Matching rules

- Price-time priority; the fill price is the resting order's limit price. A "market order" is a
  limit order with an aggressive price (usually with `ioc`).
- **Self-trade prevention — cancel newest:** when the next order an incoming order would trade
  with belongs to the same trader, matching stops and the incoming order's unfilled remainder is
  cancelled. Earlier fills stand; resting orders are not touched.
- Minimum size: `order.size >= market.minOrderSize` (the remainder of a partly filled order may be smaller).
- Expiry: an order is dropped `EXPIRY_BUFFER_SEC` before its `expiry`, so that it cannot reach the
  chain too late.
- One order per (trader, nonce). A signed `Cancel` or an on-chain `OrderCancelled` blocks the nonce.
- Only canonical 65-byte EOA signatures (v 27/28, low s) are accepted, matching the contract's ECDSA check.

## Consistency model

**The book is optimistic, the tape is confirmed.**

1. A match takes liquidity out of the book immediately and is queued for settlement. The
   `POST /orders` response reports it as a `pending` fill; the orders show it under `pending`.
2. Matches are settled in match order, in batches, one transaction at a time. Nothing is
   published on `/trades` or the `trades` channel, and nothing counts as `filled`, until the
   transaction is mined and the match has no `MatchFailed` event.
3. If a match fails on-chain, neither order was filled by it, and the engine decides per side:
   - **At fault** → removed from the book for good (`rejected`). Fault is taken from the revert
     data when it names a trader (`InsufficientMargin`, `NegativeAccountValue`,
     `ReduceOnlyViolated`), otherwise from contract views: nonce cancelled, already filled,
     expired by block time, reduce-only that would not reduce, free collateral below the
     estimated margin for the fill.
   - **Innocent** → gets the size back with its original time priority. If orders that arrived
     in the meantime now cross it, they are matched right away (older order is the maker).
     Not given back: IOC orders, orders the trader cancelled meanwhile, expired orders.
   - **Nobody identifiable** (paused exchange, stale oracle, open-interest cap, chain unreadable)
     → the taker is dropped, the maker gets its size back and a strike; three consecutive strikes
     remove the maker. No order can keep retrying a failing match.
4. A cancel removes the unmatched remainder at once. Matches already queued or in flight are
   not recalled and may still settle.

### Submission failures

- Each batch is bound to one operator nonce when first signed. Re-broadcasts and fee bumps reuse
  that nonce and the same calldata, and the outcome is looked up by the locally computed
  transaction hashes, so a batch cannot settle twice whatever the RPC answers.
- While a batch's outcome is unknown the engine keeps retrying *that* batch, submits nothing
  else, reports `stalled` on `/health`, and refuses new orders with 503.
- A batch whose transaction reverted as a whole (or would revert in gas estimation) did not
  settle; it is retried up to three times and then its matches are failed as "nobody identifiable".
- A mined transaction is final for the engine (one confirmation).

## Known limitations

- **All state is in memory.** A restart loses the book, order history and trades. Matches that
  were queued but not yet sent are lost; a transaction in flight still lands on-chain. Traders
  must resubmit their orders; with `PRETRADE_CHECKS=true` the on-chain filled size and cancels
  are honoured on resubmission. Order records are never evicted (memory grows with order count).
- **Single operator key, single process.** Sequential transactions bound the throughput to one
  batch (`MAX_BATCH_SIZE` matches) per block. No other process may use the operator key.
- **No reorg handling**, and no fee cap when bumping a stuck transaction.
- **Optimistic fills can be undone.** A `pending` fill is a promise the chain may refuse.
- **Fault attribution is partly heuristic** when the revert data names nobody; a wrong guess
  costs an order its place in the book, never a wrong settlement.
- **Pre-trade margin check is per order**: it ignores the trader's other open orders and is
  advisory. Reduce-only is enforced by the contract, not the book.
- **Operator trust**: the engine decides ordering and can censor; it cannot move funds. Traders
  can always cancel on-chain.
- EOA signatures only (no EIP-1271). Rate limiting is per IP and in memory; set `TRUST_PROXY`
  only behind a proxy. The WebSocket book feed sends full snapshots, not deltas.
- Keeper: only knows accounts from `Fill`/`Liquidation` events since `KEEPER_START_BLOCK`
  (rescanned on every start), does not hedge or unwind positions it takes over, does not check
  profitability, and calls `updateFunding` on a local timer.
