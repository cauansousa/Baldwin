import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, loadKeeperConfig } from "../config.ts";
import { consoleLogger as log, errMessage } from "../types.ts";
import { Keeper } from "./keeper.ts";
import { ViemKeeperChain } from "./viemKeeperChain.ts";

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }
  const cfg = loadKeeperConfig();
  const { deployment } = cfg;
  const account = privateKeyToAccount(cfg.keeperKey);
  if (process.env.OPERATOR_PRIVATE_KEY && process.env.OPERATOR_PRIVATE_KEY.replace(/^0x/, "").toLowerCase() === cfg.keeperKey.slice(2).toLowerCase()) {
    throw new Error("KEEPER_PRIVATE_KEY must differ from OPERATOR_PRIVATE_KEY: the engine manages the operator's nonces on its own");
  }
  const chain = chainFor(deployment, cfg.rpcUrl);
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match the deployment file (${deployment.chainId})`);
  }

  const keeper = new Keeper({
    chain: new ViemKeeperChain(client, wallet, account, deployment.exchange),
    marketIds: deployment.markets.map((m) => m.marketId),
    self: account.address,
    startBlock: cfg.startBlock,
    fundingIntervalSec: cfg.fundingIntervalSec,
    logger: log,
  });
  log.info("keeper started", { chainId, exchange: deployment.exchange, keeper: account.address });

  let stop = false;
  let wake: (() => void) | null = null;
  const onSignal = () => {
    stop = true;
    wake?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  while (!stop) {
    await keeper.tick();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, cfg.pollIntervalMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
  log.info("keeper stopped");
}

main().catch((e) => {
  log.error("fatal", { error: errMessage(e) });
  process.exit(1);
});
