import { createPublicClient, http, type PublicClient } from "viem";
import { exchangeAbi } from "./abi.ts";
import { buildServer } from "./api/server.ts";
import { ViemChainReader } from "./chain/viemChain.ts";
import { accountFromKey, chainFor, loadEngineConfig } from "./config.ts";
import { FileDeadNonceStore } from "./engine/deadNonces.ts";
import { Engine } from "./engine/engine.ts";
import { ViemSettler, viemSettlerRpc } from "./settlement/viemSettler.ts";
import { consoleLogger as log, errMessage } from "./types.ts";

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: use the process environment as is
  }
  const cfg = loadEngineConfig();
  const { deployment } = cfg;
  const account = accountFromKey(cfg.operatorKey, "OPERATOR_PRIVATE_KEY");
  const client = createPublicClient({ chain: chainFor(deployment, cfg.rpcUrl), transport: http(cfg.rpcUrl) }) as PublicClient;

  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match the deployment file (${deployment.chainId})`);
  }
  const chain = new ViemChainReader(client, deployment.exchange, deployment.markets);
  if (!(await chain.isOperator(account.address))) {
    throw new Error(`${account.address} is not an operator of the exchange ${deployment.exchange}`);
  }
  const markets = await Promise.all(deployment.markets.map((m) => chain.getMarket(m.marketId)));
  const marketCount = await chain.marketCount();

  const settler = new ViemSettler({
    rpc: viemSettlerRpc(client, deployment.exchange),
    account,
    chainId,
    exchange: deployment.exchange,
    logger: log,
    // The contract's per-match gas floor (MATCH_GAS_BASE + MATCH_GAS_PER_MARKET x markets).
    gasFloorPerMatch: 300_000n + 100_000n * BigInt(marketCount),
    maxFeePerGasCap: cfg.maxFeePerGasCap,
  });
  const deadNonces = new FileDeadNonceStore(cfg.deadNoncesPath, BigInt(Math.floor(Date.now() / 1000)));
  const engine = new Engine({
    domain: { chainId, verifyingContract: deployment.exchange },
    markets,
    settler,
    chain,
    deadNonces,
    preTradeChecks: cfg.preTradeChecks,
    expiryBufferSec: cfg.expiryBufferSec,
    minTimeToExpirySec: cfg.minTimeToExpirySec,
    maxTimeToExpirySec: cfg.maxTimeToExpirySec,
    faultThreshold: cfg.faultThreshold,
    faultWindowSec: cfg.faultWindowSec,
    maxBatchSize: cfg.maxBatchSize,
    logger: log,
  });
  await engine.refreshChainState();
  engine.start(1000, cfg.chainRefreshMs);

  // On-chain cancels take orders out of the book without waiting for a failed match.
  const unwatch = client.watchContractEvent({
    address: deployment.exchange,
    abi: exchangeAbi,
    eventName: "OrderCancelled",
    onLogs: (logs) => {
      for (const l of logs) {
        if (l.args.trader === undefined || l.args.nonce === undefined) continue;
        try {
          engine.cancelNonce(l.args.trader, l.args.nonce, "cancelled on-chain");
        } catch (e) {
          log.error("could not record on-chain cancel", { error: errMessage(e) });
        }
      }
    },
    onError: (e) => log.warn("OrderCancelled watcher error", { error: errMessage(e) }),
  });

  const app = await buildServer(engine, {
    corsOrigin: cfg.corsOrigin,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    trustProxy: cfg.trustProxy,
    wsMaxConnections: cfg.wsMaxConnections,
    wsMaxConnectionsPerIp: cfg.wsMaxConnectionsPerIp,
    info: { chainId, exchange: deployment.exchange, operator: account.address },
  });
  await app.listen({ port: cfg.port, host: cfg.host });
  log.info("engine listening", {
    port: cfg.port,
    host: cfg.host,
    chainId,
    exchange: deployment.exchange,
    operator: account.address,
    markets: markets.map((m) => m.symbol),
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    unwatch();
    await app.close();
    await engine.stop();
    deadNonces.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
