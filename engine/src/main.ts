import { createPublicClient, formatEther, type PublicClient } from "viem";
import { exchangeAbi } from "./abi.ts";
import { buildServer } from "./api/server.ts";
import { cancelWatcher } from "./chain/cancelWatcher.ts";
import { rpcTransport } from "./chain/transport.ts";
import { ViemChainReader } from "./chain/viemChain.ts";
import { accountFromKey, chainFor, loadEngineConfig } from "./config.ts";
import { Engine } from "./engine/engine.ts";
import { Metrics } from "./metrics.ts";
import { ViemSettler, viemSettlerRpc } from "./settlement/viemSettler.ts";
import { SqliteStore } from "./store/sqliteStore.ts";
import { createLogger, errMessage } from "./types.ts";

let log = createLogger("info", "engine");

/** Until the engine is up, a signal simply ends the process (there is nothing to flush yet). */
let onSignal: (signal: string) => void = () => process.exit(0);
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: use the process environment as is
  }
  const cfg = loadEngineConfig();
  log = createLogger(cfg.logLevel, "engine");
  const { deployment } = cfg;
  const account = accountFromKey(cfg.operatorKey, "OPERATOR_PRIVATE_KEY");
  const metrics = new Metrics();
  metrics.counter("rpc_errors_total", "JSON-RPC requests that failed after retries, by method");
  const client = createPublicClient({
    chain: chainFor(deployment, cfg.rpcUrl),
    transport: rpcTransport(cfg.rpcUrl, (method) => metrics.inc("rpc_errors_total", { method })),
  }) as PublicClient;

  // ---- fail fast on anything that would make the engine useless
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match the deployment file (${deployment.chainId})`);
  }
  const chain = new ViemChainReader(client, deployment.exchange, deployment.markets);
  if (!(await chain.isOperator(account.address))) {
    throw new Error(`${account.address} is not an operator of the exchange ${deployment.exchange}; have the owner call setOperator`);
  }
  let operatorBalance = await client.getBalance({ address: account.address });
  if (operatorBalance === 0n) {
    throw new Error(`operator ${account.address} has no ETH on chain ${chainId}; it cannot pay for settlement transactions`);
  }
  const markets = await Promise.all(deployment.markets.map((m) => chain.getMarket(m.marketId)));
  const marketCount = await chain.marketCount();

  // The contract's per-match gas floor, read from its public constants; the configured
  // values are the fallback for a contract that does not expose them.
  let floorBase = cfg.matchGasFloorBase;
  let floorPerMarket = cfg.matchGasFloorPerMarket;
  try {
    [floorBase, floorPerMarket] = await Promise.all([
      client.readContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "MATCH_GAS_BASE" }),
      client.readContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "MATCH_GAS_PER_MARKET" }),
    ]);
  } catch {
    log.warn("could not read the contract's match gas floor; using MATCH_GAS_FLOOR_BASE / MATCH_GAS_FLOOR_PER_MARKET", {
      base: floorBase,
      perMarket: floorPerMarket,
    });
  }
  const gasFloorPerMatch = floorBase + floorPerMarket * BigInt(marketCount);

  // ---- durable state, settlement, engine
  // Exclusive: a second engine process on the same file fails here instead of fighting this one.
  const store = new SqliteStore(cfg.storePath, { exclusive: true });
  const settler = new ViemSettler({
    rpc: viemSettlerRpc(client, deployment.exchange),
    account,
    chainId,
    exchange: deployment.exchange,
    logger: log,
    store,
    confirmations: cfg.confirmations,
    receiptTimeoutMs: cfg.receiptTimeoutMs,
    pollIntervalMs: cfg.receiptPollMs,
    gasLimitCap: cfg.gasLimitCap,
    gasFloorPerMatch,
    maxFeePerGasCap: cfg.maxFeePerGasCap,
  });
  const engine = new Engine({
    domain: { chainId, verifyingContract: deployment.exchange },
    markets,
    settler,
    chain,
    store,
    metrics,
    preTradeChecks: cfg.preTradeChecks,
    expiryBufferSec: cfg.expiryBufferSec,
    minTimeToExpirySec: cfg.minTimeToExpirySec,
    maxTimeToExpirySec: cfg.maxTimeToExpirySec,
    faultThreshold: cfg.faultThreshold,
    faultWindowSec: cfg.faultWindowSec,
    maxBatchSize: cfg.maxBatchSize,
    intakeTimeoutMs: cfg.intakeTimeoutMs,
    traderOrdersPerMinute: cfg.traderOrdersPerMinute,
    preTradeCacheMs: cfg.preTradeCacheMs,
    fundingIntervalSec: cfg.fundingIntervalSec,
    logger: log,
  });
  const watcher = cancelWatcher({
    client,
    exchange: deployment.exchange,
    engine,
    store,
    logger: log,
    startBlock: cfg.startBlock,
    maxRange: cfg.logMaxBlockRange,
    headLag: cfg.logHeadLag,
    // Always re-read a few blocks; more when fills wait for several confirmations.
    overlap: cfg.logRescan > BigInt(cfg.confirmations) ? cfg.logRescan : BigInt(cfg.confirmations),
  });

  // ---- operator balance
  const balanceTimer = setInterval(() => {
    client.getBalance({ address: account.address }).then(
      (b) => {
        if (b < cfg.operatorMinBalance && operatorBalance >= cfg.operatorMinBalance) {
          log.warn("operator ETH balance is low", { operator: account.address, balanceEth: formatEther(b), thresholdEth: formatEther(cfg.operatorMinBalance) });
        }
        operatorBalance = b;
      },
      (e) => log.warn("could not read the operator balance", { error: errMessage(e) }),
    );
  }, 30_000);
  balanceTimer.unref();
  metrics.gauge("operator_balance_eth", "ETH balance of the operator account", () => Number(formatEther(operatorBalance)));
  metrics.gauge("cancel_watcher_block", "Last block whose cancel events were processed", () => Number(watcher.position ?? 0n));

  // ---- API: up before recovery, so that /health can say "recovering" (orders are refused until it is done)
  const app = await buildServer(engine, {
    corsOrigin: cfg.corsOrigin,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    trustProxy: cfg.trustProxy,
    wsMaxConnections: cfg.wsMaxConnections,
    wsMaxConnectionsPerIp: cfg.wsMaxConnectionsPerIp,
    logger: log,
    info: () => ({
      chainId,
      exchange: deployment.exchange,
      operator: account.address,
      operatorBalanceWei: operatorBalance,
      operatorBalanceEth: formatEther(operatorBalance),
      confirmations: cfg.confirmations,
      cancelWatcherBlock: watcher.position ?? null,
      warnings:
        operatorBalance < cfg.operatorMinBalance
          ? [`operator ETH balance ${formatEther(operatorBalance)} is below ${formatEther(cfg.operatorMinBalance)}`]
          : [],
    }),
  });

  // ---- shutdown: stop intake, let the in-flight batch resolve (bounded), flush, exit.
  // A second signal, or the hard deadline, always ends the process after closing the store.
  let closing = false;
  const exitNow = (code: number) => {
    try {
      store.close();
    } catch {
      // already closed
    }
    process.exit(code);
  };
  const shutdown = async (signal: string) => {
    if (closing) {
      log.warn("second signal: exiting now", { signal });
      exitNow(1);
    }
    closing = true;
    log.info("shutting down", { signal, drainTimeoutMs: cfg.shutdownTimeoutMs });
    setTimeout(() => {
      log.error("shutdown did not finish in time; exiting");
      exitNow(1);
    }, cfg.shutdownTimeoutMs + 10_000).unref();
    try {
      await engine.stop(cfg.shutdownTimeoutMs);
      watcher.stop();
      clearInterval(balanceTimer);
      // Closes WebSocket clients first, then idle keep-alive connections, then the listener.
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000).unref())]);
      log.info("shutdown complete", { ...engine.settlementStatus() });
    } catch (e) {
      log.error("error during shutdown", { error: errMessage(e) });
      exitNow(1);
    }
    exitNow(0);
  };
  onSignal = (signal) => void shutdown(signal);

  await app.listen({ port: cfg.port, host: cfg.host });
  log.info("engine listening", {
    port: cfg.port,
    host: cfg.host,
    chainId,
    exchange: deployment.exchange,
    operator: account.address,
    operatorBalanceEth: formatEther(operatorBalance),
    confirmations: cfg.confirmations,
    store: cfg.storePath,
    gasFloorPerMatch,
    recovering: engine.isRecovering(),
    markets: markets.map((m) => m.symbol),
  });
  if (operatorBalance < cfg.operatorMinBalance) {
    log.warn("operator ETH balance is low", { operator: account.address, balanceEth: formatEther(operatorBalance), thresholdEth: formatEther(cfg.operatorMinBalance) });
  }

  // ---- recovery, bounded: cancels first (chain views and replayed events), then the
  // batch that was in flight and queued matches, then fill state. If the chain cannot
  // be reached for RECOVERY_TIMEOUT_MS the process exits non-zero and the process
  // manager starts it again.
  let recoveryTimer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    recoveryTimer = setTimeout(() => reject(new Error(`start-up recovery did not finish within ${cfg.recoveryTimeoutMs} ms`)), cfg.recoveryTimeoutMs);
  });
  try {
    await Promise.race([engine.recover({ replayCancels: () => watcher.catchUp() }), timedOut]);
  } catch (e) {
    if (closing) return;
    log.error("fatal: start-up recovery failed", { error: errMessage(e) });
    exitNow(1);
  } finally {
    clearTimeout(recoveryTimer);
  }
  watcher.start(cfg.logPollIntervalMs);
  engine.start(1000, cfg.chainRefreshMs);
  log.info("recovery complete; accepting orders", { ...engine.settlementStatus() });
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
