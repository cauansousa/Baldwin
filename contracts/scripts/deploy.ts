// Deploys a complete local/test setup: MockUSDC, MockOracle and Exchange with the
// BTC-USD and ETH-USD markets, and writes deployments/<network>.json in the
// `Deployment` shape of shared/src/index.ts.
//
//   npx hardhat run scripts/deploy.ts --network localhost
//
// This script uses mock collateral and a mock oracle that anyone can write to.
// It must never be used for a deployment that holds real funds.
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

const wad = (n: string) => ethers.parseUnits(n, 18);
const usdc = (n: string) => ethers.parseUnits(n, 6);

// The mock oracle is only updated by hand, so prices are accepted for a long time
// by default. A production deployment needs a value matched to the feed heartbeat.
const MAX_PRICE_AGE = BigInt(process.env.MAX_PRICE_AGE ?? 365 * 24 * 3600);
// Funding rate cap per hour, in bps.
const MAX_FUNDING_RATE_BPS = BigInt(process.env.MAX_FUNDING_RATE_BPS ?? 10);
const MINT_PER_ACCOUNT = usdc("1000000");
const FUNDED_ACCOUNTS = 5;

const MARKETS = [
  { symbol: "BTC-USD", price: wad("65000"), maxOpenInterest: wad("1000"), minOrderSize: wad("0.001") },
  { symbol: "ETH-USD", price: wad("3500"), maxOpenInterest: wad("20000"), minOrderSize: wad("0.01") },
];

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId === 1) throw new Error("refusing to deploy mocks to mainnet");
  console.log(`network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);

  const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await token.waitForDeployment();
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
  await oracle.waitForDeployment();
  const exchange = await (
    await ethers.getContractFactory("Exchange")
  ).deploy(
    await token.getAddress(),
    await oracle.getAddress(),
    deployer.address, // owner
    deployer.address, // fee recipient
    MAX_PRICE_AGE,
    MAX_FUNDING_RATE_BPS,
  );
  await exchange.waitForDeployment();

  const markets: { marketId: number; symbol: string }[] = [];
  for (const [marketId, m] of MARKETS.entries()) {
    await (await oracle.setPrice(marketId, m.price)).wait();
    await (
      await exchange.addMarket({
        active: true,
        initialMarginBps: 2000,
        maintenanceMarginBps: 1000,
        makerFeeBps: 2,
        takerFeeBps: 5,
        liquidationPenaltyBps: 150,
        maxOpenInterest: m.maxOpenInterest,
        minOrderSize: m.minOrderSize,
        symbol: m.symbol,
      })
    ).wait();
    markets.push({ marketId, symbol: m.symbol });
  }
  if (Number(await exchange.marketCount()) !== MARKETS.length) throw new Error("unexpected market count");

  await (await exchange.setOperator(deployer.address, true)).wait();

  for (const s of signers.slice(0, FUNDED_ACCOUNTS)) {
    await (await token.mint(s.address, MINT_PER_ACCOUNT)).wait();
  }

  const deployment = {
    chainId,
    exchange: await exchange.getAddress(),
    usdc: await token.getAddress(),
    oracle: await oracle.getAddress(),
    markets,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");

  console.log(deployment);
  console.log(`operator / owner / fee recipient: ${deployer.address}`);
  console.log(`minted ${ethers.formatUnits(MINT_PER_ACCOUNT, 6)} USDC to ${Math.min(FUNDED_ACCOUNTS, signers.length)} accounts`);
  console.log(`written ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
