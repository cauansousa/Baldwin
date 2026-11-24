import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, isAddress, isHex, parseEther, type Chain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Deployment } from "../../shared/src/index.ts";
import type { Hex, LogLevel } from "./types.ts";

const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === "") return def;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

/** Reads a private key from the environment. The value is never included in error messages. */
export function privateKey(env: Env, name: string): Hex {
  const raw = env[name];
  if (!raw) throw new Error(`${name} is required`);
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isHex(key) || key.length !== 66) throw new Error(`${name} must be a 32-byte hex private key`);
  return key;
}

/** Account for a key; a key the curve rejects is reported by variable name only, never by value. */
export function accountFromKey(key: Hex, name: string): PrivateKeyAccount {
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new Error(`${name} is not a valid secp256k1 private key`);
  }
}

function bigintEnv(env: Env, name: string, def: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(raw);
}

export function loadDeployment(env: Env = process.env): Deployment {
  const path = resolve(ENGINE_DIR, env.DEPLOYMENT_PATH || "../contracts/deployments/localhost.json");
  let d: Deployment;
  try {
    d = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  } catch (e) {
    throw new Error(`cannot read deployment file ${path}: ${(e as Error).message}`);
  }
  if (!Number.isInteger(d.chainId) || !isAddress(d.exchange) || !Array.isArray(d.markets)) {
    throw new Error(`deployment file ${path} is malformed`);
  }
  return d;
}

/**
 * The chain is whatever the deployment file says (id) and RPC_URL points to; nothing
 * is assumed about it beyond EIP-1559 transactions. Fees come from the node
 * (eth_maxPriorityFeePerGas + base fee) and gas limits from eth_estimateGas, which on
 * Arbitrum already includes the L1 data cost.
 */
export function chainFor(deployment: Deployment, rpcUrl: string): Chain {
  return defineChain({
    id: deployment.chainId,
    name: `baldwin-${deployment.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface CommonConfig {
  rpcUrl: string;
  deployment: Deployment;
  logLevel: LogLevel;
  /** Largest block span per eth_getLogs query. */
  logMaxBlockRange: bigint;
}

function common(env: Env): CommonConfig {
  const level = (env.LOG_LEVEL || "info").toLowerCase();
  if (!["info", "warn", "error", "silent"].includes(level)) throw new Error("LOG_LEVEL must be info, warn, error or silent");
  const rpcUrl = env.RPC_URL || "http://127.0.0.1:8545";
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error("RPC_URL must be an http(s) URL");
  return {
    rpcUrl,
    deployment: loadDeployment(env),
    logLevel: level as LogLevel,
    logMaxBlockRange: BigInt(int(env, "LOG_MAX_BLOCK_RANGE", 2000, 1)),
  };
}

/** "0.01" (ETH) -> wei. */
function ethEnv(env: Env, name: string, def: string): bigint {
  const raw = env[name] === undefined || env[name] === "" ? def : env[name]!;
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(raw)) throw new Error(`${name} must be a decimal amount of ETH`);
  return parseEther(raw);
}

function optionalBlock(env: Env, name: string): bigint | undefined {
  return env[name] === undefined || env[name] === "" ? undefined : BigInt(int(env, name, 0));
}

export interface EngineConfig extends CommonConfig {
  operatorKey: Hex;
  port: number;
  host: string;
  corsOrigin: string;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  maxBatchSize: number;
  preTradeChecks: boolean;
  expiryBufferSec: number;
  minTimeToExpirySec: number;
  maxTimeToExpirySec: number;
  /** SQLite file with the engine's durable state. */
  storePath: string;
  /** Blocks a settlement must be buried under before fills are reported as confirmed. */
  confirmations: number;
  /** /health warns when the operator's ETH balance is below this (wei). */
  operatorMinBalance: bigint;
  /** How long SIGTERM waits for the in-flight batch. */
  shutdownTimeoutMs: number;
  /** How often on-chain cancel events are polled. */
  logPollIntervalMs: number;
  /** First block to scan for cancels when the store has no cursor (default: current head). */
  startBlock: bigint | undefined;
  gasLimitCap: bigint;
  receiptTimeoutMs: number;
  receiptPollMs: number;
  chainRefreshMs: number;
  faultThreshold: number;
  faultWindowSec: number;
  /** wei; undefined = no cap. */
  maxFeePerGasCap: bigint | undefined;
  wsMaxConnections: number;
  wsMaxConnectionsPerIp: number;
}

export function loadEngineConfig(env: Env = process.env): EngineConfig {
  return {
    ...common(env),
    operatorKey: privateKey(env, "OPERATOR_PRIVATE_KEY"),
    port: int(env, "PORT", 8080, 1),
    host: env.HOST || "127.0.0.1",
    corsOrigin: env.CORS_ORIGIN || "*",
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 600, 1),
    trustProxy: bool(env, "TRUST_PROXY", false),
    maxBatchSize: int(env, "MAX_BATCH_SIZE", 20, 1),
    preTradeChecks: bool(env, "PRETRADE_CHECKS", true),
    expiryBufferSec: int(env, "EXPIRY_BUFFER_SEC", 30),
    minTimeToExpirySec: int(env, "MIN_TIME_TO_EXPIRY_SEC", 60),
    maxTimeToExpirySec: int(env, "MAX_TIME_TO_EXPIRY_SEC", 7 * 24 * 3600, 1),
    storePath: resolve(ENGINE_DIR, env.STORE_PATH || "data/engine.sqlite"),
    confirmations: int(env, "CONFIRMATIONS", 1, 1),
    operatorMinBalance: ethEnv(env, "OPERATOR_MIN_BALANCE_ETH", "0.01"),
    shutdownTimeoutMs: int(env, "SHUTDOWN_TIMEOUT_MS", 30_000, 0),
    logPollIntervalMs: int(env, "LOG_POLL_INTERVAL_MS", 2000, 100),
    startBlock: optionalBlock(env, "START_BLOCK"),
    gasLimitCap: BigInt(int(env, "GAS_LIMIT_CAP", 25_000_000, 21_000)),
    receiptTimeoutMs: int(env, "RECEIPT_TIMEOUT_MS", 30_000, 100),
    receiptPollMs: int(env, "RECEIPT_POLL_MS", 500, 10),
    chainRefreshMs: int(env, "CHAIN_REFRESH_MS", 2000, 100),
    faultThreshold: int(env, "FAULT_THRESHOLD", 3, 1),
    faultWindowSec: int(env, "FAULT_WINDOW_SEC", 600, 1),
    maxFeePerGasCap: env.MAX_FEE_PER_GAS_GWEI ? BigInt(int(env, "MAX_FEE_PER_GAS_GWEI", 0, 1)) * 10n ** 9n : undefined,
    wsMaxConnections: int(env, "WS_MAX_CONNECTIONS", 1000, 1),
    wsMaxConnectionsPerIp: int(env, "WS_MAX_CONNECTIONS_PER_IP", 10, 1),
  };
}

export interface KeeperConfig extends CommonConfig {
  keeperKey: Hex;
  pollIntervalMs: number;
  fundingIntervalSec: number;
  startBlock: bigint;
  /** Warn at start-up when the keeper's free collateral (USDC units) is below this; 0 disables. */
  minFreeCollateral: bigint;
  /** JSON file with the keeper's event cursor and tracked accounts. */
  statePath: string;
}

export function loadKeeperConfig(env: Env = process.env): KeeperConfig {
  return {
    ...common(env),
    keeperKey: privateKey(env, "KEEPER_PRIVATE_KEY"),
    pollIntervalMs: int(env, "KEEPER_POLL_INTERVAL_MS", 5000, 100),
    fundingIntervalSec: int(env, "FUNDING_INTERVAL_SEC", 3600, 1),
    startBlock: BigInt(int(env, "KEEPER_START_BLOCK", 0)),
    minFreeCollateral: bigintEnv(env, "KEEPER_MIN_FREE_COLLATERAL", 1n),
    statePath: resolve(ENGINE_DIR, env.KEEPER_STATE_PATH || "data/keeper-state.json"),
  };
}
