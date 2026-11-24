import { HardhatUserConfig, subtask } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import fs from "fs";
import path from "path";

// Load contracts/.env if present (Node >= 20.12 built-in, no dependency). Variables that
// are already set in the environment win. See .env.example.
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Use the solc-js build shipped in node_modules instead of downloading a
// native compiler, so builds work offline and in restricted networks.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion === "0.8.26") {
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: "0.8.26",
      longVersion: "0.8.26+commit.8a97fa7a",
    };
  }
  return runSuper();
});

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  paths: { sources: "./src" },
  networks: {
    // HARDHAT_CHAIN_ID lets `hardhat node` impersonate a chain id for deploy rehearsals.
    hardhat: { chainId: Number(process.env.HARDHAT_CHAIN_ID ?? 31337) },
    // `npx hardhat node`
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Used by scripts/deploy-testnet.ts; the script refuses to run without the two variables.
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "",
      chainId: 421614,
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
  // `npx hardhat verify --network arbitrumSepolia <address> <constructor args...>`
  // One Etherscan (API v2) key works for Arbiscan and its testnets.
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY ?? "" },
  sourcify: { enabled: false },
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: false },
  },
};
export default config;
