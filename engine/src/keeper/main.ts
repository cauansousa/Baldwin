import { createPublicClient, createWalletClient, formatEther, type PublicClient } from "viem";
import { exchangeAbi } from "../abi.ts";
import { rpcTransport } from "../chain/transport.ts";
import { accountFromKey, chainFor, loadKeeperConfig } from "../config.ts";
import { Metrics } from "../metrics.ts";
import { createLogger, errMessage } from "../types.ts";
import { Keeper } from "./keeper.ts";
import { keeperServer } from "./server.ts";
import { FileKeeperState } from "./state.ts";
import { httpEngineClient, Unwinder } from "./unwinder.ts";
import { ViemKeeperChain } from "./viemKeeperChain.ts";

let log = createLogger("info", "keeper");

/** Set once the keeper is running; until then a signal simply ends the process. */
let onSignal: () => void = () => process.exit(0);
process.on("SIGINT", () => onSignal());
process.on("SIGTERM", () => onSignal());

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }
  const cfg = loadKeeperConfig();
  log = createLogger(cfg.logLevel, "keeper");
  const { deployment } = cfg;
  const account = accountFromKey(cfg.keeperKey, "KEEPER_PRIVATE_KEY");
  if (process.env.OPERATOR_PRIVATE_KEY && process.env.OPERATOR_PRIVATE_KEY.replace(/^0x/, "").toLowerCase() === cfg.keeperKey.slice(2).toLowerCase()) {
    throw new Error("KEEPER_PRIVATE_KEY must differ from OPERATOR_PRIVATE_KEY: the engine manages the operator's nonces on its own");
  }
  const metrics = new Metrics("foxy_keeper_");
  metrics.counter("rpc_errors_total", "JSON-RPC requests that failed after retries, by method");
  const chain = chainFor(deployment, cfg.rpcUrl);
  const transport = rpcTransport(cfg.rpcUrl, (method) => metrics.inc("rpc_errors_total", { method }));
  const client = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport });
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match the deployment file (${deployment.chainId})`);
  }
  const balance = await client.getBalance({ address: account.address });
  if (balance === 0n) throw new Error(`keeper ${account.address} has no ETH on chain ${chainId}; it cannot pay for transactions`);

  const keeperChain = new ViemKeeperChain(client, wallet, account, deployment.exchange);
  const marketIds = deployment.markets.map((m) => m.marketId);
  // Liquidating means taking the position over, which the keeper has to margin itself.
  let freeCollateral: bigint | null = await keeperChain.ownFreeCollateral().catch((e) => {
    // The view reverts while the oracle is unavailable; that must not stop the keeper.
    log.warn("could not read the keeper's free collateral", { error: errMessage(e) });
    return null;
  });
  if (cfg.minFreeCollateral > 0n && freeCollateral !== null && freeCollateral < cfg.minFreeCollateral) {
    log.warn("keeper has too little free collateral in the Exchange: it will not be able to take over positions", {
      keeper: account.address,
      freeCollateral,
      expectedAtLeast: cfg.minFreeCollateral,
    });
  }

  // ---- inventory unwind: close what liquidations left the keeper holding, through the engine
  let unwinder: Unwinder | null = null;
  if (cfg.unwind) {
    const bandBps = await client.readContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "maxPriceDeviationBps" }).catch(() => 500n);
    unwinder = new Unwinder({
      chain: { positionSize: (m) => keeperChain.positionSize(account.address, m), indexPrice: (m) => keeperChain.indexPrice(m) },
      engine: httpEngineClient(cfg.engineUrl),
      account,
      domain: { chainId, verifyingContract: deployment.exchange },
      marketIds,
      offsetBps: cfg.unwindOffsetBps,
      repriceBps: cfg.unwindRepriceBps,
      expirySec: cfg.unwindExpirySec,
      bandBps,
      logger: log,
    });
  }

  const keeper = new Keeper({
    chain: keeperChain,
    marketIds,
    self: account.address,
    startBlock: cfg.startBlock,
    maxBlockRange: cfg.logMaxBlockRange,
    headLag: cfg.logHeadLag,
    overlap: cfg.logRescan,
    fundingIntervalSec: cfg.fundingIntervalSec,
    state: new FileKeeperState(cfg.statePath),
    beforeLiquidate: unwinder ? (marketId) => unwinder.withdraw(marketId) : undefined,
    logger: log,
  });

  // ---- observability
  const startedAt = Date.now();
  const status = () => {
    const k = keeper.status();
    const sinceTick = Date.now() - (k.lastTickAt > 0 ? k.lastTickAt * 1000 : startedAt);
    const ticking = sinceTick < Math.max(60_000, cfg.pollIntervalMs * 10);
    const engineReachable = unwinder ? unwinder.isEngineReachable() : null;
    return {
      // ok: ticks are completing, the event scan has reached the head, and (if it
      // unwinds) the engine answers. Anything else needs a look.
      ok: ticking && k.eventsCaughtUp && engineReachable !== false,
      ticking,
      engineReachable,
      keeper: account.address,
      chainId,
      exchange: deployment.exchange,
      freeCollateral,
      ...k,
      unwind: unwinder ? unwinder.status() : "off",
    };
  };
  metrics.gauge("tracked_accounts", "Accounts with positions the keeper watches", () => keeper.status().trackedAccounts);
  metrics.gauge("liquidations", "Liquidations performed since start", () => keeper.status().liquidations);
  metrics.gauge("liquidation_failures", "Liquidation attempts that failed since start", () => keeper.status().liquidationFailures);
  metrics.gauge("last_liquidation_timestamp", "Unix time of the last liquidation", () => keeper.status().lastLiquidation?.at ?? null);
  metrics.gauge("positions_in_backoff", "Liquidatable positions the keeper is backing off from", () => keeper.status().positionsInBackoff);
  metrics.gauge("event_cursor_block", "Last block whose events were processed", () => Number(keeper.status().eventCursor ?? 0n));
  metrics.gauge("events_caught_up", "1 once the event scan has reached the head", () => (keeper.status().eventsCaughtUp ? 1 : 0));
  metrics.gauge("last_tick_timestamp", "Unix time of the last keeper tick", () => keeper.status().lastTickAt);
  metrics.gauge("engine_reachable", "1 if the engine answered the unwinder's last pass", () => (unwinder ? (unwinder.isEngineReachable() ? 1 : 0) : null));
  metrics.gauge("free_collateral_usdc", "The keeper's free collateral in the Exchange, USDC", () => (freeCollateral === null ? null : Number(freeCollateral) / 1e6));
  metrics.gauge("position", "Position the keeper holds (base units), by market", () =>
    (unwinder?.status() ?? []).filter((m) => m.position !== null).map((m) => ({ labels: { market: String(m.marketId) }, value: Number(m.position) / 1e18 })),
  );
  metrics.gauge("unwind_order_working", "1 if an unwind order is working in the market", () =>
    (unwinder?.status() ?? []).map((m) => ({ labels: { market: String(m.marketId) }, value: m.order ? 1 : 0 })),
  );
  const server = cfg.port > 0 ? keeperServer({ health: status, metrics }) : null;
  if (server) await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));

  log.info("keeper started", {
    chainId,
    exchange: deployment.exchange,
    keeper: account.address,
    balanceEth: formatEther(balance),
    state: cfg.statePath,
    trackedAccounts: keeper.trackedAccounts().length,
    unwind: cfg.unwind ? { engine: cfg.engineUrl, offsetBps: cfg.unwindOffsetBps, intervalMs: cfg.unwindIntervalMs } : "off",
    port: cfg.port || "off",
  });

  // ---- shutdown: the orders resting in the engine go first, at once; everything else after
  let stop = false;
  let wake: (() => void) | null = null;
  let withdrawn: Promise<void> | null = null;
  onSignal = () => {
    if (stop) process.exit(1); // second signal
    stop = true;
    if (unwinder) withdrawn = Promise.race([unwinder.shutdown(), new Promise<void>((r) => setTimeout(r, 8000).unref())]);
    wake?.();
  };

  // ---- the unwinder runs on its own timer: a quote must be watched every second or so,
  // not once per liquidation pass (which can take long when the node is slow).
  let unwindTimer: NodeJS.Timeout | null = null;
  if (unwinder) {
    const loop = () => {
      if (stop) return;
      void unwinder.tick().finally(() => {
        if (!stop) unwindTimer = setTimeout(loop, cfg.unwindIntervalMs);
      });
    };
    loop();
  }

  // ---- watchdog: a keeper whose ticks no longer complete (a hung RPC call) cannot heal
  // itself and a container health check does not restart it. Exit and let the process
  // manager start a fresh one.
  let lastTickDone = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastTickDone < cfg.stuckExitMs) return;
    log.error("no keeper tick has completed for too long; exiting to be restarted", { stuckForMs: Date.now() - lastTickDone });
    const bye = () => process.exit(1);
    if (unwinder) void Promise.race([unwinder.shutdown(), new Promise((r) => setTimeout(r, 5000))]).then(bye, bye);
    else bye();
  }, 5000);
  watchdog.unref();

  let ticks = 0;
  const heartbeatEvery = Math.max(1, Math.round(300_000 / cfg.pollIntervalMs));
  while (!stop) {
    await keeper.tick();
    lastTickDone = Date.now();
    if (ticks % 6 === 0) freeCollateral = await keeperChain.ownFreeCollateral().catch(() => freeCollateral);
    // A status line every ~5 minutes, so that a silent keeper can be told from a dead one.
    if (++ticks % heartbeatEvery === 0) log.info("keeper status", status());
    if (stop) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, cfg.pollIntervalMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
  if (unwindTimer) clearTimeout(unwindTimer);
  clearInterval(watchdog);
  await withdrawn;
  server?.close();
  log.info("keeper stopped", status());
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
