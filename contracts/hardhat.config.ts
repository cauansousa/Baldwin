import { HardhatUserConfig, subtask } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import path from "path";

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

const config: HardhatUserConfig = {
  paths: { sources: "./src" },
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: false },
  },
};
export default config;
