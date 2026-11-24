// Rehearsal helper for scripts/deploy-testnet.ts. Deploys stand-ins for the external
// contracts (USDC, two Chainlink feeds, a sequencer uptime feed) to a LOCAL node and
// prints the environment variables that point deploy-testnet.ts at them.
// Refuses to run against anything that is not a local node. See README, "Dry run".
import hre from "hardhat";

async function main() {
  const { ethers, network } = hre;
  const url = (network.config as { url?: string }).url ?? "";
  const local = network.name === "hardhat" || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url);
  if (!local) throw new Error("dry-run-mocks.ts only runs against a local node");

  const [deployer, owner, operator, feeRecipient] = await ethers.getSigners();
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const Agg = await ethers.getContractFactory("MockAggregator", deployer);

  const token = await (await ethers.getContractFactory("MockUSDC", deployer)).deploy();
  await token.waitForDeployment();
  const btc = await Agg.deploy(8);
  await btc.waitForDeployment();
  await (await btc.set(65_000n * 10n ** 8n, now)).wait();
  const eth = await Agg.deploy(8);
  await eth.waitForDeployment();
  await (await eth.set(3_500n * 10n ** 8n, now)).wait();
  const sequencer = await Agg.deploy(0);
  await sequencer.waitForDeployment();
  await (await sequencer.setRound(0, now - 7 * 24 * 3600, now)).wait(); // up for a week

  // Only one account is configured when DEPLOYER_PRIVATE_KEY is set; fall back to it.
  const lines = [
    `USDC_ADDRESS=${await token.getAddress()}`,
    `BTC_USD_FEED=${await btc.getAddress()}`,
    `ETH_USD_FEED=${await eth.getAddress()}`,
    `BTC_USD_MAX_STALENESS=86400`,
    `ETH_USD_MAX_STALENESS=86400`,
    `SEQUENCER_UPTIME_FEED=${await sequencer.getAddress()}`,
    `OWNER_ADDRESS=${process.env.DRY_RUN_OWNER ?? (owner ?? deployer).address}`,
    `ALLOW_EOA_OWNER=true`,
    `OPERATOR_ADDRESS=${(operator ?? deployer).address}`,
    `FEE_RECIPIENT=${(feeRecipient ?? deployer).address}`,
  ];
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
