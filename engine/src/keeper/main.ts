import { createPublicClient, createWalletClient, formatEther, type PublicClient } from "viem";
import { rpcTransport } from "../chain/transport.ts";
import { accountFromKey, chainFor, loadKeeperConfig } from "../config.ts";
import { createLogger, errMessage } from "../types.ts";
import { Keeper } from "./keeper.ts";
import { FileKeeperState } from "./state.ts";
import { ViemKeeperChain } from "./viemKeeperChain.ts";

let log = createLogger("info", "keeper");

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
  let rpcErrors = 0;
  const chain = chainFor(deployment, cfg.rpcUrl);
  const transport = rpcTransport(cfg.rpcUrl, () => rpcErrors++);
  const client = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport });
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match the deployment file (${deployment.chainId})`);
  }
  const balance = await client.getBalance({ address: account.address });
  if (balance === 0n) throw new Error(`keeper ${account.address} has no ETH on chain ${chainId}; it cannot pay for transactions`);

  const keeperChain = new ViemKeeperChain(client, wallet, account, deployment.exchange);
  // Liquidating means taking the position over, which the keeper has to margin itself.
  if (cfg.minFreeCollateral > 0n) {
    const free = await keeperChain.ownFreeCollateral();
    if (free < cfg.minFreeCollateral) {
      log.warn("keeper has too little free collateral in the Exchange: it will not be able to take over positions", {
        keeper: account.address,
        freeCollateral: free,
        expectedAtLeast: cfg.minFreeCollateral,
      });
    }
  }

  const keeper = new Keeper({
    chain: keeperChain,
    marketIds: deployment.markets.map((m) => m.marketId),
    self: account.address,
    startBlock: cfg.startBlock,
    maxBlockRange: cfg.logMaxBlockRange,
    fundingIntervalSec: cfg.fundingIntervalSec,
    state: new FileKeeperState(cfg.statePath),
    logger: log,
  });
  log.info("keeper started", {
    chainId,
    exchange: deployment.exchange,
    keeper: account.address,
    balanceEth: formatEther(balance),
    state: cfg.statePath,
    trackedAccounts: keeper.trackedAccounts().length,
  });

  let stop = false;
  let wake: (() => void) | null = null;
  const onSignal = () => {
    stop = true;
    wake?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let ticks = 0;
  while (!stop) {
    await keeper.tick();
    // A heartbeat line every ~5 minutes so that a silent keeper can be told from a dead one.
    if (++ticks % Math.max(1, Math.round(300_000 / cfg.pollIntervalMs)) === 0) {
      log.info("keeper alive", { trackedAccounts: keeper.trackedAccounts().length, rpcErrors });
    }
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
