import { createPublicClient, formatEther, type PublicClient } from "viem";
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

  // ---- durable state, settlement, engine
  const store = new SqliteStore(cfg.storePath);
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
    // The contract's per-match gas floor (MATCH_GAS_BASE + MATCH_GAS_PER_MARKET x markets).
    gasFloorPerMatch: 400_000n + 150_000n * BigInt(marketCount),
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
    logger: log,
  });

  // Restored orders and the batch that was in flight are reconciled with the chain,
  // and cancels that happened while the engine was down are applied, before the API opens.
  await engine.recover();
  const watcher = cancelWatcher({
    client,
    exchange: deployment.exchange,
    engine,
    store,
    logger: log,
    startBlock: cfg.startBlock,
    maxRange: cfg.logMaxBlockRange,
    overlap: BigInt(Math.max(0, cfg.confirmations - 1)),
  });
  await watcher.catchUp();
  watcher.start(cfg.logPollIntervalMs);
  engine.start(1000, cfg.chainRefreshMs);

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

  const app = await buildServer(engine, {
    corsOrigin: cfg.corsOrigin,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    trustProxy: cfg.trustProxy,
    wsMaxConnections: cfg.wsMaxConnections,
    wsMaxConnectionsPerIp: cfg.wsMaxConnectionsPerIp,
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
    markets: markets.map((m) => m.symbol),
  });
  if (operatorBalance < cfg.operatorMinBalance) {
    log.warn("operator ETH balance is low", { operator: account.address, balanceEth: formatEther(operatorBalance), thresholdEth: formatEther(cfg.operatorMinBalance) });
  }

  // ---- graceful shutdown: stop intake, let the in-flight batch resolve (bounded), flush, exit
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal, drainTimeoutMs: cfg.shutdownTimeoutMs });
    try {
      await engine.stop(cfg.shutdownTimeoutMs);
      watcher.stop();
      clearInterval(balanceTimer);
      await app.close();
      store.close();
      log.info("shutdown complete", { ...engine.settlementStatus() });
    } catch (e) {
      log.error("error during shutdown", { error: errMessage(e) });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
