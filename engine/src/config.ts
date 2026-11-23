import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, isAddress, isHex, type Chain } from "viem";
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
    expiryBufferSec: int(env, "EXPIRY_BUFFER_SEC", 5),
  };
}

export interface KeeperConfig extends CommonConfig {
  keeperKey: Hex;
  pollIntervalMs: number;
  fundingIntervalSec: number;
  startBlock: bigint;
}

export function loadKeeperConfig(env: Env = process.env): KeeperConfig {
  return {
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    deployment: loadDeployment(env),
    keeperKey: privateKey(env, "KEEPER_PRIVATE_KEY"),
    pollIntervalMs: int(env, "KEEPER_POLL_INTERVAL_MS", 5000, 100),
    fundingIntervalSec: int(env, "FUNDING_INTERVAL_SEC", 3600, 1),
    startBlock: BigInt(int(env, "KEEPER_START_BLOCK", 0)),
  };
}
