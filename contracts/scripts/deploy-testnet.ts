// Testnet deployment (Arbitrum Sepolia) against REAL external contracts: an existing
// USDC token and Chainlink feeds. Deploys ChainlinkOracle and Exchange, adds BTC-USD and
// ETH-USD, sets the operator and starts the two-step ownership transfer to the multisig.
// It never deploys mock tokens and never mints anything.
//
//   cp .env.example .env   # fill in
//   npx hardhat run scripts/deploy-testnet.ts --network arbitrumSepolia
//
// All configuration comes from the environment (see .env.example). The script checks
// everything it can before sending the first transaction and refuses to run otherwise.
import hre from "hardhat";
import type { TimelockController } from "../typechain-types";
import fs from "fs";
import path from "path";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

export interface MarketParams {
  symbol: string;
  feed: string;
  maxStaleness: bigint;
  maxOpenInterest: bigint;
  minOrderSize: bigint;
  /** Plausible USD price range; anything outside means the wrong feed was configured. */
  sanePrice: [number, number];
}

export interface TestnetConfig {
  usdc: string;
  sequencerUptimeFeed: string; // zero address = disabled
  sequencerGracePeriod: bigint;
  owner: string;
  allowEoaOwner: boolean;
  allowTestKey: boolean;
  /** 0 = no timelock: the multisig becomes the owner directly. */
  timelockDelay: bigint;
  /** Account that may pause. Zero address = none. With a timelock it defaults to the owner (multisig). */
  guardian: string;
  operator: string;
  feeRecipient: string;
  maxPriceAge: bigint;
  maxFundingRateBps: bigint;
  maxPriceDeviationBps: bigint;
  initialMarginBps: bigint;
  maintenanceMarginBps: bigint;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
  liquidationPenaltyBps: bigint;
  markets: MarketParams[];
  deploymentFile?: string;
}

const AGGREGATOR_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
const LOCAL_CHAIN_ID = 31337;
const MIN_TIMELOCK_DELAY = 3600n;

/**
 * True for the 20 accounts of the Hardhat/Anvil default mnemonic. Their private keys are
 * public: anything they own on a public network can be taken by anyone.
 */
export function isWellKnownTestAccount(address: string): boolean {
  const { ethers } = hre;
  const mnemonic = ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk");
  for (let i = 0; i < 20; i++) {
    if (ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`).address === ethers.getAddress(address)) return true;
  }
  return false;
}
/** Chains with real money: this script is for testnets only. */
const MAINNET_CHAIN_IDS = [1, 10, 56, 137, 8453, 42161, 43114];

/** Reads and validates the environment. Throws one error listing every problem found. */
export function loadConfig(env: Env): TestnetConfig {
  const { ethers } = hre;
  const problems: string[] = [];
  const raw = (name: string) => {
    const v = env[name]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const address = (name: string, required = true): string => {
    const v = raw(name);
    if (v === undefined) {
      if (required) problems.push(`${name} is not set`);
      return ethers.ZeroAddress;
    }
    if (!ethers.isAddress(v) || v === ethers.ZeroAddress) {
      problems.push(`${name} is not a valid non-zero address`);
      return ethers.ZeroAddress;
    }
    return ethers.getAddress(v);
  };
  const integer = (name: string, fallback?: bigint): bigint => {
    const v = raw(name);
    if (v === undefined) {
      if (fallback === undefined) problems.push(`${name} is not set`);
      return fallback ?? 0n;
    }
    if (!/^\d+$/.test(v)) {
      problems.push(`${name} must be a non-negative integer`);
      return 0n;
    }
    return BigInt(v);
  };
  const decimal18 = (name: string, fallback: string): bigint => {
    const v = raw(name) ?? fallback;
    try {
      const parsed = ethers.parseUnits(v, 18);
      if (parsed < 0n) throw new Error("negative");
      return parsed;
    } catch {
      problems.push(`${name} must be a non-negative decimal number`);
      return 0n;
    }
  };

  const btcStaleness = integer("BTC_USD_MAX_STALENESS");
  const ethStaleness = integer("ETH_USD_MAX_STALENESS");
  const config: TestnetConfig = {
    usdc: address("USDC_ADDRESS"),
    sequencerUptimeFeed: address("SEQUENCER_UPTIME_FEED", false),
    sequencerGracePeriod: integer("SEQUENCER_GRACE_PERIOD", 3600n),
    owner: address("OWNER_ADDRESS"),
    allowEoaOwner: raw("ALLOW_EOA_OWNER") === "true",
    allowTestKey: raw("ALLOW_TEST_KEY") === "true",
    timelockDelay: integer("TIMELOCK_DELAY_SECONDS", 0n),
    guardian: address("GUARDIAN_ADDRESS", false),
    operator: address("OPERATOR_ADDRESS"),
    feeRecipient: address("FEE_RECIPIENT"),
    maxPriceAge: integer("MAX_PRICE_AGE", btcStaleness > ethStaleness ? btcStaleness : ethStaleness),
    maxFundingRateBps: integer("MAX_FUNDING_RATE_BPS", 10n),
    maxPriceDeviationBps: integer("MAX_PRICE_DEVIATION_BPS", 500n),
    initialMarginBps: integer("INITIAL_MARGIN_BPS", 2000n),
    maintenanceMarginBps: integer("MAINTENANCE_MARGIN_BPS", 1000n),
    makerFeeBps: integer("MAKER_FEE_BPS", 2n),
    takerFeeBps: integer("TAKER_FEE_BPS", 5n),
    liquidationPenaltyBps: integer("LIQUIDATION_PENALTY_BPS", 150n),
    markets: [
      {
        symbol: "BTC-USD",
        feed: address("BTC_USD_FEED"),
        maxStaleness: btcStaleness,
        maxOpenInterest: decimal18("BTC_MAX_OPEN_INTEREST", "1000"),
        minOrderSize: decimal18("BTC_MIN_ORDER_SIZE", "0.001"),
        sanePrice: [1_000, 10_000_000],
      },
      {
        symbol: "ETH-USD",
        feed: address("ETH_USD_FEED"),
        maxStaleness: ethStaleness,
        maxOpenInterest: decimal18("ETH_MAX_OPEN_INTEREST", "20000"),
        minOrderSize: decimal18("ETH_MIN_ORDER_SIZE", "0.01"),
        sanePrice: [10, 1_000_000],
      },
    ],
    deploymentFile: raw("DEPLOYMENT_FILE"),
  };

  if (problems.length) throw new Error(`Configuration problems:\n  - ${problems.join("\n  - ")}`);

  // Behind a timelock the owner cannot pause quickly; unless told otherwise the multisig
  // keeps that ability as guardian.
  if (config.timelockDelay > 0n && config.guardian === ethers.ZeroAddress) config.guardian = config.owner;
  if (config.timelockDelay > 30n * 24n * 3600n) problems.push("TIMELOCK_DELAY_SECONDS must be at most 30 days");
  // A timelock that can be passed in minutes protects nobody.
  if (config.timelockDelay > 0n && config.timelockDelay < MIN_TIMELOCK_DELAY && raw("ALLOW_SHORT_TIMELOCK") !== "true") {
    problems.push(`TIMELOCK_DELAY_SECONDS must be at least ${MIN_TIMELOCK_DELAY} (set ALLOW_SHORT_TIMELOCK=true to override)`);
  }
  // A global limit below a feed's own limit would make that feed look stale to the
  // exchange while the adapter still accepts it.
  for (const m of config.markets) {
    if (config.maxPriceAge < m.maxStaleness) problems.push(`MAX_PRICE_AGE (${config.maxPriceAge}) must be at least the ${m.symbol} max staleness (${m.maxStaleness})`);
  }

  // The same rules the contracts enforce, checked here so that nothing is deployed in vain.
  const c = config;
  const maxFee = c.makerFeeBps > c.takerFeeBps ? c.makerFeeBps : c.takerFeeBps;
  if (c.maxPriceAge === 0n) problems.push("MAX_PRICE_AGE must be positive");
  for (const m of c.markets) {
    if (m.maxStaleness === 0n || m.maxStaleness > 0xffffffffn) problems.push(`${m.symbol}: max staleness must be between 1 and 2^32-1 seconds`);
  }
  if (c.maxFundingRateBps > 100n) problems.push("MAX_FUNDING_RATE_BPS must be at most 100");
  if (c.maxPriceDeviationBps === 0n || c.maxPriceDeviationBps >= 10_000n) problems.push("MAX_PRICE_DEVIATION_BPS must be between 1 and 9999");
  if (c.maintenanceMarginBps === 0n || c.maintenanceMarginBps > c.initialMarginBps || c.initialMarginBps > 10_000n) {
    problems.push("margins must satisfy 0 < MAINTENANCE_MARGIN_BPS <= INITIAL_MARGIN_BPS <= 10000");
  }
  if (maxFee > 100n) problems.push("fees must be at most 100 bps");
  if (c.liquidationPenaltyBps > c.maintenanceMarginBps) problems.push("LIQUIDATION_PENALTY_BPS must not exceed MAINTENANCE_MARGIN_BPS");
  if (c.maxPriceDeviationBps * 10_000n + maxFee * (10_000n + c.maxPriceDeviationBps) >= c.maintenanceMarginBps * 10_000n) {
    problems.push("MAX_PRICE_DEVIATION_BPS + highest fee x (1 + band) must be below MAINTENANCE_MARGIN_BPS");
  }
  if (c.maxFundingRateBps * 8n + c.maxPriceDeviationBps >= c.maintenanceMarginBps) {
    problems.push("8 x MAX_FUNDING_RATE_BPS + MAX_PRICE_DEVIATION_BPS must be below MAINTENANCE_MARGIN_BPS");
  }
  for (const m of c.markets) {
    if (m.minOrderSize === 0n) problems.push(`${m.symbol}: the minimum order size must be positive`);
    if (m.maxOpenInterest === 0n) problems.push(`${m.symbol}: the open interest cap must be positive`);
  }

  if (problems.length) throw new Error(`Configuration problems:\n  - ${problems.join("\n  - ")}`);
  return config;
}

/** Checks the external contracts, deploys, configures, and writes the Deployment file. */
export async function deployTestnet(config: TestnetConfig, log: Log = console.log) {
  const { ethers, network } = hre;
  const provider = ethers.provider;
  const problems: string[] = [];

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY");
  const chainId = Number((await provider.getNetwork()).chainId);
  // By chain id, whatever the network is called in the config.
  if (MAINNET_CHAIN_IDS.includes(chainId)) throw new Error(`Chain ${chainId} is a mainnet; this script is for testnets only`);
  if (chainId !== LOCAL_CHAIN_ID && !config.allowTestKey && isWellKnownTestAccount(deployer.address)) {
    throw new Error(
      `The deployer ${deployer.address} is a well-known Hardhat/Anvil test account whose private key is public. ` +
        "Use a real key (or set ALLOW_TEST_KEY=true for a local rehearsal).",
    );
  }
  if (network.name === "arbitrumSepolia" && chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
    throw new Error(`The RPC endpoint reports chain ${chainId}, expected ${ARBITRUM_SEPOLIA_CHAIN_ID}`);
  }
  const now = (await provider.getBlock("latest"))!.timestamp;
  log(`network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);

  // ------------------------------------------------------------ preflight
  const hasCode = async (a: string) => (await provider.getCode(a)) !== "0x";
  if ((await provider.getBalance(deployer.address)) === 0n) problems.push("the deployer has no ETH for gas");

  if (!(await hasCode(config.usdc))) {
    problems.push(`USDC_ADDRESS ${config.usdc} has no contract code`);
  } else {
    try {
      const token = new ethers.Contract(config.usdc, ERC20_ABI, provider);
      const decimals = Number(await token.decimals());
      if (decimals !== 6) problems.push(`USDC_ADDRESS has ${decimals} decimals, expected 6`);
      else log(`collateral ${await token.symbol().catch(() => "?")} at ${config.usdc}, 6 decimals`);
    } catch {
      problems.push("USDC_ADDRESS does not answer decimals(): not an ERC-20 token?");
    }
  }

  const feedPrices: number[] = [];
  for (const m of config.markets) {
    const name = `${m.symbol} feed ${m.feed}`;
    if (!(await hasCode(m.feed))) {
      problems.push(`${name} has no contract code`);
      continue;
    }
    try {
      const feed = new ethers.Contract(m.feed, AGGREGATOR_ABI, provider);
      const decimals = Number(await feed.decimals());
      const round = await feed.latestRoundData();
      const answer: bigint = round.answer;
      const updatedAt = Number(round.updatedAt);
      if (decimals > 36) problems.push(`${name}: ${decimals} decimals is not supported`);
      else if (answer <= 0n) problems.push(`${name}: answer ${answer} is not positive`);
      else if (updatedAt === 0 || updatedAt > now) problems.push(`${name}: updatedAt ${updatedAt} is not a past timestamp`);
      else if (BigInt(now - updatedAt) > m.maxStaleness) {
        problems.push(`${name}: last update is ${now - updatedAt}s old, more than the configured ${m.maxStaleness}s`);
      } else {
        const price = Number(ethers.formatUnits(answer, decimals));
        if (price < m.sanePrice[0] || price > m.sanePrice[1]) {
          problems.push(`${name}: price ${price} is outside the plausible range ${m.sanePrice[0]}..${m.sanePrice[1]} (wrong feed?)`);
        } else {
          log(`${m.symbol} feed ${m.feed}: ${price} USD, ${decimals} decimals, updated ${now - updatedAt}s ago`);
          feedPrices.push(price);
        }
      }
    } catch {
      problems.push(`${name} does not answer decimals()/latestRoundData(): not a Chainlink aggregator?`);
    }
  }

  // The plausible ranges overlap, so also catch swapped or duplicated feeds.
  if (config.markets[0].feed === config.markets[1].feed) problems.push("BTC_USD_FEED and ETH_USD_FEED are the same address");
  else if (feedPrices.length === 2 && feedPrices[0] <= feedPrices[1]) {
    problems.push(`the BTC-USD feed (${feedPrices[0]}) does not report a higher price than the ETH-USD feed (${feedPrices[1]}): feeds swapped?`);
  }

  if (config.sequencerUptimeFeed !== ethers.ZeroAddress) {
    const name = `SEQUENCER_UPTIME_FEED ${config.sequencerUptimeFeed}`;
    if (!(await hasCode(config.sequencerUptimeFeed))) {
      problems.push(`${name} has no contract code`);
    } else {
      try {
        const feed = new ethers.Contract(config.sequencerUptimeFeed, AGGREGATOR_ABI, provider);
        const round = await feed.latestRoundData();
        const startedAt = Number(round.startedAt);
        if (round.answer !== 0n) problems.push(`${name} reports the sequencer as down (answer ${round.answer})`);
        else if (startedAt === 0 || startedAt > now) problems.push(`${name}: startedAt ${startedAt} is not a past timestamp`);
        else if (BigInt(now - startedAt) <= config.sequencerGracePeriod) problems.push(`${name}: the sequencer came back ${now - startedAt}s ago, inside the grace period; retry later`);
        else log(`sequencer uptime feed ${config.sequencerUptimeFeed}: up for ${now - startedAt}s, grace period ${config.sequencerGracePeriod}s`);
      } catch {
        problems.push(`${name} does not answer latestRoundData()`);
      }
    }
  } else {
    log("sequencer uptime feed: disabled");
  }

  // Also when the owner is the deployer itself: a single key as owner must be a decision.
  if (!(await hasCode(config.owner)) && !config.allowEoaOwner) {
    problems.push(`OWNER_ADDRESS ${config.owner} has no contract code (expected a multisig); set ALLOW_EOA_OWNER=true to accept a plain account`);
  }

  // The operator and the fee recipient must be accounts somebody controls, not one of the
  // contracts involved (fees credited to such an address would be stuck).
  const deployerNonce = await provider.getTransactionCount(deployer.address);
  const reserved: Record<string, string> = {
    [config.usdc]: "the USDC token",
    [config.sequencerUptimeFeed]: "the sequencer uptime feed",
    [ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce })]: "the ChainlinkOracle about to be deployed",
    [ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 1 })]: "the Exchange about to be deployed",
  };
  if (config.timelockDelay > 0n) {
    reserved[ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 2 })] = "the TimelockController about to be deployed";
  }
  for (const m of config.markets) reserved[m.feed] = `the ${m.symbol} feed`;
  reserved[ethers.ZeroAddress] = "the zero address";
  for (const [name, value] of [
    ["OPERATOR_ADDRESS", config.operator],
    ["FEE_RECIPIENT", config.feeRecipient],
  ]) {
    if (reserved[value]) problems.push(`${name} ${value} is ${reserved[value]}`);
  }
  if (config.guardian !== ethers.ZeroAddress && reserved[config.guardian]) {
    problems.push(`GUARDIAN_ADDRESS ${config.guardian} is ${reserved[config.guardian]}`);
  }

  if (problems.length) throw new Error(`Preflight failed, nothing was deployed:\n  - ${problems.join("\n  - ")}`);

  // --------------------------------------------------------------- deploy
  const oracleArgs = [deployer.address, config.sequencerUptimeFeed, config.sequencerGracePeriod] as const;
  const oracle = await (await ethers.getContractFactory("ChainlinkOracle", deployer)).deploy(...oracleArgs);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  log(`ChainlinkOracle deployed at ${oracleAddress}`);

  // From here on contracts exist. Keep a record on disk after every step, so that a
  // failure half-way leaves a trace of what was deployed and how far the setup got.
  const file = config.deploymentFile ?? path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const incompleteFile = `${file}.incomplete`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const progress: Record<string, unknown> = {
    note: "INCOMPLETE deployment: the script did not finish. Do not use these contracts.",
    chainId,
    deployer: deployer.address,
    oracle: oracleAddress,
    completedSteps: ["deploy ChainlinkOracle"],
  };
  const record = (step?: string, extra: Record<string, unknown> = {}) => {
    Object.assign(progress, extra);
    if (step) (progress.completedSteps as string[]).push(step);
    fs.writeFileSync(incompleteFile, JSON.stringify(progress, null, 2) + "\n");
  };
  record();

  const exchangeArgs = [
    config.usdc,
    oracleAddress,
    deployer.address, // temporary owner, see the ownership transfer below
    config.feeRecipient,
    config.maxPriceAge,
    config.maxFundingRateBps,
    config.maxPriceDeviationBps,
  ] as const;
  const exchange = await (await ethers.getContractFactory("Exchange", deployer)).deploy(...exchangeArgs);
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  log(`Exchange deployed at ${exchangeAddress}`);
  record("deploy Exchange", { exchange: exchangeAddress });

  // Optional timelock between the multisig and the contracts. It starts with no delay
  // and the deployer in every role, so that this script can complete the whole handover
  // in one run (see below); it ends with the configured delay, the multisig as the only
  // proposer/canceller/executor and no role left with the deployer.
  let timelockAddress: string | undefined;
  let timelock: TimelockController | undefined;
  if (config.timelockDelay > 0n) {
    timelock = (await (
      await ethers.getContractFactory("TimelockController", deployer)
    ).deploy(0, [deployer.address], [deployer.address], deployer.address)) as unknown as TimelockController;
    await timelock.waitForDeployment();
    timelockAddress = await timelock.getAddress();
    log(`TimelockController deployed at ${timelockAddress}`);
    record("deploy TimelockController", { timelock: timelockAddress });
  }
  /** Who ends up as owner of Exchange and ChainlinkOracle. */
  const finalOwner = timelockAddress ?? config.owner;

  const markets: { marketId: number; symbol: string }[] = [];
  for (const [marketId, m] of config.markets.entries()) {
    await (await oracle.setFeed(marketId, m.feed, m.maxStaleness)).wait();
    await (
      await exchange.addMarket({
        active: true,
        initialMarginBps: config.initialMarginBps,
        maintenanceMarginBps: config.maintenanceMarginBps,
        makerFeeBps: config.makerFeeBps,
        takerFeeBps: config.takerFeeBps,
        liquidationPenaltyBps: config.liquidationPenaltyBps,
        maxOpenInterest: m.maxOpenInterest,
        minOrderSize: m.minOrderSize,
        symbol: m.symbol,
      })
    ).wait();
    // End-to-end check: exchange -> adapter -> (sequencer feed) -> price feed.
    const index = await exchange.indexPrice(marketId);
    log(`market ${marketId} ${m.symbol} added, index price ${ethers.formatUnits(index, 18)}`);
    markets.push({ marketId, symbol: m.symbol });
    record(`add market ${marketId} ${m.symbol}`);
  }
  if (Number(await exchange.marketCount()) !== config.markets.length) throw new Error("unexpected market count");

  await (await exchange.setOperator(config.operator, true)).wait();
  log(`operator ${config.operator}`);
  record("set operator");

  if (config.guardian !== ethers.ZeroAddress) {
    await (await exchange.setGuardian(config.guardian)).wait();
    log(`guardian ${config.guardian} (can pause, cannot unpause)`);
    record("set guardian", { guardian: config.guardian });
  }

  let ownershipPending = finalOwner !== deployer.address;
  if (ownershipPending) {
    await (await exchange.transferOwnership(finalOwner)).wait();
    await (await oracle.transferOwnership(finalOwner)).wait();
    record("start ownership transfer", { pendingOwner: finalOwner });
  }

  if (timelock && timelockAddress) {
    // Complete the handover now, while the timelock still has no delay and the deployer
    // holds its roles: nothing is left for later, and the deployer key is never the sole
    // owner for longer than this script runs.
    const zero = ethers.ZeroHash;
    const accept = exchange.interface.encodeFunctionData("acceptOwnership");
    const targets = [exchangeAddress, oracleAddress];
    await (await timelock.scheduleBatch(targets, [0, 0], [accept, accept], zero, zero, 0)).wait();
    await (await timelock.executeBatch(targets, [0, 0], [accept, accept], zero, zero)).wait();
    record("timelock accepted ownership of both contracts");

    const [PROPOSER, CANCELLER, EXECUTOR, ADMIN] = await Promise.all([
      timelock.PROPOSER_ROLE(),
      timelock.CANCELLER_ROLE(),
      timelock.EXECUTOR_ROLE(),
      timelock.DEFAULT_ADMIN_ROLE(),
    ]);
    for (const role of [PROPOSER, CANCELLER, EXECUTOR]) await (await timelock.grantRole(role, config.owner)).wait();
    record("granted timelock roles to the multisig");

    // The delay can only be changed by the timelock itself.
    const setDelay = timelock.interface.encodeFunctionData("updateDelay", [config.timelockDelay]);
    await (await timelock.schedule(timelockAddress, 0, setDelay, zero, zero, 0)).wait();
    await (await timelock.execute(timelockAddress, 0, setDelay, zero, zero)).wait();
    record(`timelock delay set to ${config.timelockDelay}`);

    for (const role of [PROPOSER, CANCELLER, EXECUTOR]) await (await timelock.revokeRole(role, deployer.address)).wait();
    await (await timelock.renounceRole(ADMIN, deployer.address)).wait();
    record("deployer gave up all timelock roles");
    ownershipPending = false;

    // Do not report success unless all of it is really in place.
    const failures: string[] = [];
    for (const [name, c] of [
      ["Exchange", exchange],
      ["ChainlinkOracle", oracle],
    ] as const) {
      if ((await c.owner()) !== timelockAddress) failures.push(`${name}.owner() is not the timelock`);
      if ((await c.pendingOwner()) !== ethers.ZeroAddress) failures.push(`${name} still has a pending owner`);
    }
    if ((await timelock.getMinDelay()) !== config.timelockDelay) failures.push("the timelock delay is not the configured one");
    for (const [roleName, role] of [
      ["proposer", PROPOSER],
      ["canceller", CANCELLER],
      ["executor", EXECUTOR],
    ] as const) {
      if (!(await timelock.hasRole(role, config.owner))) failures.push(`the multisig is not ${roleName} of the timelock`);
      if (await timelock.hasRole(role, deployer.address)) failures.push(`the deployer is still ${roleName} of the timelock`);
    }
    if (await timelock.hasRole(ADMIN, deployer.address)) failures.push("the deployer is still admin of the timelock");
    if (await timelock.hasRole(ADMIN, config.owner)) failures.push("the multisig is admin of the timelock (it must not be: roles would be changeable without delay)");
    if (failures.length) {
      throw new Error(`HANDOVER INCOMPLETE - DO NOT USE THIS DEPLOYMENT:\n  - ${failures.join("\n  - ")}\nSee ${incompleteFile}`);
    }
    log(`handover complete: the timelock owns Exchange and ChainlinkOracle, delay ${config.timelockDelay}s, multisig ${config.owner} is its proposer, canceller and executor; the deployer holds no role`);
  }

  // --------------------------------------------------------------- output
  // The block the Exchange was created in: where off-chain services start reading events.
  const exchangeReceipt = await exchange.deploymentTransaction()?.wait();
  const deployment = {
    chainId,
    exchange: exchangeAddress,
    usdc: config.usdc,
    oracle: oracleAddress,
    markets,
    ...(exchangeReceipt ? { deploymentBlock: exchangeReceipt.blockNumber } : {}),
    // Optional extra field: present only when a timelock was deployed.
    ...(timelockAddress ? { timelock: timelockAddress } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
  fs.rmSync(incompleteFile, { force: true });

  log("");
  log("=== summary ===");
  log(JSON.stringify(deployment, null, 2));
  log(`fee recipient ${config.feeRecipient}`);
  log(`maxPriceAge ${config.maxPriceAge}s, funding cap ${config.maxFundingRateBps} bps/h, price band ${config.maxPriceDeviationBps} bps`);
  log(`written ${file}`);
  if (timelockAddress) {
    log("");
    log(`OWNER: TimelockController ${timelockAddress} (delay ${config.timelockDelay}s). The handover is complete:`);
    log(`the deployer ${deployer.address} has no rights left on any contract.`);
    log(`Every owner action (markets, operators, oracle and feeds, guardian, unpause) must be scheduled on the`);
    log(`timelock by the multisig ${config.owner} and executed after the delay. That includes replacing a broken`);
    log("oracle or feed: recovery from an oracle failure also waits out the delay. Pausing does not: the guardian can pause.");
  } else if (ownershipPending) {
    log("");
    log(`OWNERSHIP IS NOT TRANSFERRED YET. The deployer ${deployer.address} remains owner until`);
    log(`${config.owner} calls acceptOwnership() on BOTH contracts:`);
    log(`  Exchange        ${exchangeAddress}`);
    log(`  ChainlinkOracle ${oracleAddress}`);
    log("Afterwards run the check below; it fails until the handover is complete:");
    log(`  OWNER_ADDRESS=${config.owner} npx hardhat run scripts/check-deployment.ts --network ${network.name}`);
  } else {
    log("owner: the deployer (OWNER_ADDRESS equals the deployer, no transfer started)");
  }
  log("");
  log("verify the sources (needs ETHERSCAN_API_KEY):");
  log(`  npx hardhat verify --network ${network.name} ${oracleAddress} ${oracleArgs.join(" ")}`);
  log(`  npx hardhat verify --network ${network.name} ${exchangeAddress} ${exchangeArgs.join(" ")}`);
  if (timelockAddress) {
    log(`  TimelockController ${timelockAddress}: its constructor takes arrays, so pass the arguments in a file:`);
    log(`    module.exports = [0, ["${deployer.address}"], ["${deployer.address}"], "${deployer.address}"];`);
    log(`    npx hardhat verify --network ${network.name} --constructor-args <that file> ${timelockAddress}`);
  }

  return { deployment, file, exchange, oracle, ownershipPending, timelock: timelockAddress, finalOwner };
}

async function main() {
  if (hre.network.name === "arbitrumSepolia") {
    const missing = ["ARBITRUM_SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter((n) => !process.env[n]?.trim());
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  await deployTestnet(loadConfig(process.env));
}

if (require.main === module) {
  main().catch((e) => {
    // Print the message only: never dump objects that could contain configuration.
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
