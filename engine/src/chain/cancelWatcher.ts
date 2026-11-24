import { getAbiItem, type PublicClient } from "viem";
import { exchangeAbi } from "../abi.ts";
import type { Engine } from "../engine/engine.ts";
import type { KeyValueStore } from "../store/types.ts";
import { errMessage, type Address, type Logger } from "../types.ts";
import { LogPoller } from "./logPoller.ts";

export type CancelEvent =
  | { kind: "nonce"; trader: Address; nonce: bigint }
  | { kind: "below"; trader: Address; minValidNonce: bigint };

const CANCEL_EVENTS = [getAbiItem({ abi: exchangeAbi, name: "OrderCancelled" }), getAbiItem({ abi: exchangeAbi, name: "OrdersCancelledBelow" })] as const;

/** On-chain cancel events (`cancelOrder`, `cancelAllOrders`) in a block range. */
export async function fetchCancelEvents(client: PublicClient, exchange: Address, from: bigint, to: bigint): Promise<CancelEvent[]> {
  const logs = await client.getLogs({ address: exchange, events: CANCEL_EVENTS, fromBlock: from, toBlock: to, strict: true });
  return logs.map((l): CancelEvent =>
    l.eventName === "OrderCancelled"
      ? { kind: "nonce", trader: l.args.trader, nonce: l.args.nonce }
      : { kind: "below", trader: l.args.trader, minValidNonce: l.args.minValidNonce },
  );
}

/** Apply cancel events to the engine. Idempotent. */
export function applyCancelEvents(engine: Engine, events: CancelEvent[], log: Logger): void {
  for (const ev of events) {
    try {
      if (ev.kind === "nonce") engine.cancelNonce(ev.trader, ev.nonce, "cancelled on-chain");
      else engine.cancelBelow(ev.trader, ev.minValidNonce);
    } catch (e) {
      log.error("could not record on-chain cancel", { error: errMessage(e) });
      throw e; // keep the cursor where it is: the range is handled again
    }
  }
}

const CURSOR_KEY = "watcher.cancels.cursor";

/** Poller that feeds on-chain cancels into the engine, with its cursor in the engine store. */
export function cancelWatcher(opts: {
  client: PublicClient;
  exchange: Address;
  engine: Engine;
  store: KeyValueStore;
  logger: Logger;
  startBlock?: bigint | undefined;
  maxRange?: bigint;
  overlap?: bigint;
  onError?: (e: unknown) => void;
}): LogPoller<CancelEvent> {
  return new LogPoller<CancelEvent>({
    name: "cancel watcher",
    head: () => opts.client.getBlockNumber({ cacheTime: 0 }),
    fetch: (from, to) => fetchCancelEvents(opts.client, opts.exchange, from, to),
    handle: (events) => applyCancelEvents(opts.engine, events, opts.logger),
    loadCursor: () => {
      const v = opts.store.getMeta(CURSOR_KEY);
      return v ? BigInt(v) : undefined;
    },
    saveCursor: (b) => opts.store.setMeta(CURSOR_KEY, b.toString()),
    startBlock: opts.startBlock,
    maxRange: opts.maxRange,
    overlap: opts.overlap,
    logger: opts.logger,
    onError: opts.onError,
  });
}
