import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, isAddress, isHex, type Chain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Deployment } from "../../shared/src/index.ts";
import type { Hex } from "./types.ts";

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
  deadNoncesPath: string;
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
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    deployment: loadDeployment(env),
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
    deadNoncesPath: resolve(ENGINE_DIR, env.DEAD_NONCES_PATH || "data/dead-nonces.jsonl"),
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
}

export function loadKeeperConfig(env: Env = process.env): KeeperConfig {
  return {
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    deployment: loadDeployment(env),
    keeperKey: privateKey(env, "KEEPER_PRIVATE_KEY"),
    pollIntervalMs: int(env, "KEEPER_POLL_INTERVAL_MS", 5000, 100),
    fundingIntervalSec: int(env, "FUNDING_INTERVAL_SEC", 3600, 1),
    startBlock: BigInt(int(env, "KEEPER_START_BLOCK", 0)),
    minFreeCollateral: bigintEnv(env, "KEEPER_MIN_FREE_COLLATERAL", 1n),
  };
}
