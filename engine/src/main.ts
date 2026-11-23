import { createPublicClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { exchangeAbi } from "./abi.ts";
import { buildServer } from "./api/server.ts";
import { ViemChainReader } from "./chain/viemChain.ts";
import { chainFor, loadEngineConfig } from "./config.ts";
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
  const account = privateKeyToAccount(cfg.operatorKey);
  const client = createPublicClient({ chain: chainFor(deployment, cfg.rpcUrl), transport: http(cfg.rpcUrl) }) as PublicClient;

  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match the deployment file (${deployment.chainId})`);
  }
  const chain = new ViemChainReader(client, deployment.exchange);
  if (!(await chain.isOperator(account.address))) {
    throw new Error(`${account.address} is not an operator of the exchange ${deployment.exchange}`);
  }
  const markets = await Promise.all(deployment.markets.map((m) => chain.getMarket(m.marketId, m.symbol)));

  const settler = new ViemSettler({
    rpc: viemSettlerRpc(client),
    account,
    chainId,
    exchange: deployment.exchange,
    logger: log,
  });
  const engine = new Engine({
    domain: { chainId, verifyingContract: deployment.exchange },
    markets,
    settler,
    chain,
    preTradeChecks: cfg.preTradeChecks,
    expiryBufferSec: cfg.expiryBufferSec,
    maxBatchSize: cfg.maxBatchSize,
    logger: log,
  });
  engine.start();

  // On-chain cancels take orders out of the book without waiting for a failed match.
  const unwatch = client.watchContractEvent({
    address: deployment.exchange,
    abi: exchangeAbi,
    eventName: "OrderCancelled",
    onLogs: (logs) => {
      for (const l of logs) {
        if (l.args.trader !== undefined && l.args.nonce !== undefined) engine.cancelNonce(l.args.trader, l.args.nonce, "cancelled on-chain");
      }
    },
    onError: (e) => log.warn("OrderCancelled watcher error", { error: errMessage(e) }),
  });

  const app = await buildServer(engine, {
    corsOrigin: cfg.corsOrigin,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    trustProxy: cfg.trustProxy,
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
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
