// Reports who controls a deployment and fails (non-zero exit) while the ownership
// handover is incomplete. Read-only: it sends no transaction and needs no private key.
//
//   OWNER_ADDRESS=<multisig> npx hardhat run scripts/check-deployment.ts --network arbitrumSepolia
//
// Reads deployments/<network>.json (or DEPLOYMENT_FILE). Optional environment:
//   OWNER_ADDRESS     the multisig that must end up in control (directly, or through the timelock)
//   OPERATOR_ADDRESS  must be an operator of the exchange
//   DEPLOYER_ADDRESS  must hold no role on the timelock and must not be an owner
import hre from "hardhat";
import fs from "fs";
import path from "path";

type Log = (line: string) => void;

export interface DeploymentRecord {
  chainId: number;
  exchange: string;
  oracle: string;
  timelock?: string;
}

export interface CheckOptions {
  expectedOwner?: string;
  operator?: string;
  deployer?: string;
}

/** Returns the list of problems; empty means the handover is complete. */
export async function checkDeployment(deployment: DeploymentRecord, opts: CheckOptions = {}, log: Log = console.log): Promise<string[]> {
  const { ethers } = hre;
  const problems: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const provider = ethers.provider;

  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== deployment.chainId) problems.push(`connected to chain ${chainId}, the deployment is on chain ${deployment.chainId}`);
  for (const [name, address] of [
    ["Exchange", deployment.exchange],
    ["ChainlinkOracle", deployment.oracle],
  ]) {
    if ((await provider.getCode(address)) === "0x") problems.push(`${name} ${address} has no code on this chain`);
  }
  if (problems.length) return problems;

  const exchange = await ethers.getContractAt("Exchange", deployment.exchange);
  const oracle = await ethers.getContractAt("ChainlinkOracle", deployment.oracle);
  // The owner that must be in place: the timelock if there is one, else the multisig.
  const wantedOwner = deployment.timelock ?? opts.expectedOwner;

  for (const [name, c] of [
    ["Exchange", exchange],
    ["ChainlinkOracle", oracle],
  ] as const) {
    const owner = await c.owner();
    const pending = await c.pendingOwner();
    log(`${name} ${await c.getAddress()}: owner ${owner}, pending owner ${pending === ethers.ZeroAddress ? "none" : pending}`);
    if (pending !== ethers.ZeroAddress) problems.push(`${name}: ownership transfer to ${pending} has not been accepted; ${owner} is still the owner`);
    if (wantedOwner && !same(owner, wantedOwner)) problems.push(`${name}: owner is ${owner}, expected ${wantedOwner}`);
    if (opts.deployer && same(owner, opts.deployer)) problems.push(`${name}: the deployer is still the owner`);
    if ((await provider.getCode(owner)) === "0x") log(`  note: the owner of ${name} is a plain account, not a contract`);
  }
  if (!wantedOwner) log("note: neither a timelock nor OWNER_ADDRESS given: cannot tell whether the owner is the intended one");
  if (!same(await exchange.owner(), await oracle.owner())) problems.push("Exchange and ChainlinkOracle have different owners");
  if (!same(await exchange.oracle(), deployment.oracle)) problems.push(`the Exchange uses oracle ${await exchange.oracle()}, not the recorded ${deployment.oracle}`);

  const guardian = await exchange.guardian();
  log(`guardian ${guardian === ethers.ZeroAddress ? "none" : guardian}; paused ${await exchange.paused()}; markets ${await exchange.marketCount()}`);
  if (opts.operator) {
    const isOperator = await exchange.isOperator(opts.operator);
    log(`operator ${opts.operator}: ${isOperator ? "allowed" : "NOT allowed"}`);
    if (!isOperator) problems.push(`${opts.operator} is not an operator`);
  }

  if (deployment.timelock) {
    if ((await provider.getCode(deployment.timelock)) === "0x") {
      problems.push(`timelock ${deployment.timelock} has no code on this chain`);
      return problems;
    }
    const timelock = await ethers.getContractAt("TimelockController", deployment.timelock);
    const delay = await timelock.getMinDelay();
    log(`timelock ${deployment.timelock}: minimum delay ${delay}s`);
    if (delay === 0n) problems.push("the timelock has no delay");
    const roles = {
      proposer: await timelock.PROPOSER_ROLE(),
      canceller: await timelock.CANCELLER_ROLE(),
      executor: await timelock.EXECUTOR_ROLE(),
      admin: await timelock.DEFAULT_ADMIN_ROLE(),
    };
    if (opts.expectedOwner) {
      for (const name of ["proposer", "canceller", "executor"] as const) {
        const has = await timelock.hasRole(roles[name], opts.expectedOwner);
        log(`  ${opts.expectedOwner} is ${has ? "" : "NOT "}${name}`);
        if (!has) problems.push(`the multisig ${opts.expectedOwner} is not ${name} of the timelock`);
      }
      if (await timelock.hasRole(roles.admin, opts.expectedOwner)) problems.push("the multisig is admin of the timelock (roles could be changed without delay)");
    } else {
      log("  note: OWNER_ADDRESS not given: the timelock's roles were not checked against a multisig");
    }
    if (opts.deployer) {
      for (const [name, role] of Object.entries(roles)) {
        if (await timelock.hasRole(role, opts.deployer)) problems.push(`the deployer ${opts.deployer} is still ${name} of the timelock`);
      }
    }
  }
  return problems;
}

async function main() {
  const { ethers, network } = hre;
  const file = process.env.DEPLOYMENT_FILE?.trim() || path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    const hint = fs.existsSync(`${file}.incomplete`) ? ` (but ${file}.incomplete exists: the deployment script did not finish)` : "";
    throw new Error(`No deployment file at ${file}${hint}`);
  }
  const deployment = JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentRecord;
  const address = (name: string) => {
    const v = process.env[name]?.trim();
    if (!v) return undefined;
    if (!ethers.isAddress(v)) throw new Error(`${name} is not a valid address`);
    return ethers.getAddress(v);
  };
  console.log(`checking ${file} on ${network.name}`);
  const problems = await checkDeployment(deployment, {
    expectedOwner: address("OWNER_ADDRESS"),
    operator: address("OPERATOR_ADDRESS"),
    deployer: address("DEPLOYER_ADDRESS"),
  });
  if (problems.length) throw new Error(`HANDOVER INCOMPLETE OR DEPLOYMENT INCONSISTENT:\n  - ${problems.join("\n  - ")}`);
  console.log("OK: ownership is where it should be");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
