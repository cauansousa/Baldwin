// Fake EIP-1193 provider for VITE_MOCK=1: answers chain reads from
// mock/state.ts, "mines" writes instantly and returns dummy signatures.
// It never holds or uses a private key.

import { ERC20_ABI, EXCHANGE_ABI } from "@shared";
import { decodeFunctionData, encodeFunctionResult, numberToHex, parseAbi, type Hex } from "viem";
import { config } from "../config";
import * as state from "./state";

const exchangeAbi = parseAbi(EXCHANGE_ABI);
const erc20Abi = parseAbi(ERC20_ABI);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sameAddress = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const startedAt = Date.now();
/** The clock of the mock chain simply follows the device clock. */
const chainTimeSec = () => Math.floor(Date.now() / 1000);
const blockNumber = () => Math.floor((Date.now() - startedAt) / 1000) + 1;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function requireMarket(marketId: number) {
  const m = state.getMarket(marketId);
  if (!m) throw new RpcError(3, "execution reverted: unknown market");
  return m;
}

function callExchange(data: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: exchangeAbi, data });
  switch (functionName) {
    case "getMarket": {
      const m = requireMarket(args[0]);
      return encodeFunctionResult({
        abi: exchangeAbi,
        functionName,
        result: {
          active: true,
          initialMarginBps: m.initialMarginBps,
          maintenanceMarginBps: m.maintenanceMarginBps,
          makerFeeBps: m.makerFeeBps,
          takerFeeBps: m.takerFeeBps,
          liquidationPenaltyBps: m.liquidationPenaltyBps,
          maxOpenInterest: 10n ** 24n,
          minOrderSize: m.minOrderSize,
          symbol: m.symbol,
        },
      });
    }
    case "indexPrice":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: state.indexPrice(requireMarket(args[0])) });
    case "markPrice":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: state.markPrice(requireMarket(args[0])) });
    case "getPosition": {
      const pos = state.account.positions.get(args[1]);
      return encodeFunctionResult({
        abi: exchangeAbi,
        functionName,
        result: { size: pos?.size ?? 0n, entryNotional: pos?.entryNotional ?? 0n, lastCumulativeFunding: 0n },
      });
    }
    case "balanceOf":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: state.account.balance });
    case "accountValue":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: state.accountValue() });
    case "marginRequirement": {
      const { initial, maintenance } = state.marginRequirement();
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: [initial, maintenance] });
    }
    case "isCancelled":
      return encodeFunctionResult({
        abi: exchangeAbi,
        functionName,
        result: args[1] < state.account.minValidNonce || state.account.cancelledNonces.has(args[1]),
      });
    case "minValidNonce":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: state.account.minValidNonce });
    case "maxOrderLifetime":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: 604_800n });
    case "paused":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: false });
    case "maxPriceDeviationBps":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: 500n });
    case "freeCollateral":
      return encodeFunctionResult({ abi: exchangeAbi, functionName, result: state.freeCollateral() });
    default:
      throw new RpcError(-32601, `mock: exchange.${functionName} not implemented`);
  }
}

function callUsdc(data: Hex): Hex {
  const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
  switch (functionName) {
    case "balanceOf":
      return encodeFunctionResult({ abi: erc20Abi, functionName, result: state.account.walletUsdc });
    case "allowance":
      return encodeFunctionResult({ abi: erc20Abi, functionName, result: state.account.allowance });
    case "decimals":
      return encodeFunctionResult({ abi: erc20Abi, functionName, result: 6 });
    default:
      throw new RpcError(-32601, `mock: usdc.${functionName} not implemented`);
  }
}

function sendTransaction(to: string | undefined, data: Hex) {
  const a = state.account;
  if (sameAddress(to, config.usdc)) {
    const call = decodeFunctionData({ abi: erc20Abi, data });
    if (call.functionName === "approve") a.allowance = call.args[1];
    else if (call.functionName === "mint") a.walletUsdc += call.args[1];
    else throw new RpcError(-32601, `mock: usdc.${call.functionName} not implemented`);
    return;
  }
  if (sameAddress(to, config.exchange)) {
    const call = decodeFunctionData({ abi: exchangeAbi, data });
    if (call.functionName === "deposit") {
      const amount = call.args[0];
      if (a.allowance < amount) throw new RpcError(3, "execution reverted: insufficient allowance");
      if (a.walletUsdc < amount) throw new RpcError(3, "execution reverted: insufficient balance");
      a.allowance -= amount;
      a.walletUsdc -= amount;
      a.balance += amount;
    } else if (call.functionName === "withdraw") {
      const amount = call.args[0];
      if (amount > state.freeCollateral()) throw new RpcError(3, "execution reverted: insufficient margin");
      a.balance -= amount;
      a.walletUsdc += amount;
    } else if (call.functionName === "cancelOrder") {
      a.cancelledNonces.add(call.args[0]);
      state.dropDeadOrders();
    } else if (call.functionName === "cancelAllOrders") {
      if (call.args[0] <= a.minValidNonce) throw new RpcError(3, "execution reverted: NonceNotIncreased()");
      if (call.args[0] > (BigInt(chainTimeSec() + 86_400) * 1000n) << 64n) throw new RpcError(3, "execution reverted: NonceTooHigh()");
      a.minValidNonce = call.args[0];
      state.dropDeadOrders();
    } else throw new RpcError(-32601, `mock: exchange.${call.functionName} not implemented`);
    return;
  }
  throw new RpcError(-32602, "mock: unknown transaction target");
}

const zeroHash = `0x${"0".repeat(64)}` as const;
let txSeq = 0;

async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  const p = (Array.isArray(params) ? params : []) as unknown[];
  switch (method) {
    case "eth_chainId":
      return numberToHex(config.chainId);
    case "net_version":
      return String(config.chainId);
    case "eth_accounts":
    case "eth_requestAccounts":
      return [state.MOCK_ACCOUNT];
    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain":
      return null;
    case "wallet_requestPermissions":
    case "wallet_getPermissions":
      return [{ parentCapability: "eth_accounts" }];
    case "wallet_revokePermissions":
      return null;
    case "eth_blockNumber":
      return numberToHex(blockNumber());
    case "eth_getBlockByNumber":
      return {
        number: numberToHex(blockNumber()),
        hash: zeroHash,
        parentHash: zeroHash,
        timestamp: numberToHex(chainTimeSec()),
        nonce: "0x0000000000000000",
        difficulty: "0x0",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        baseFeePerGas: "0x3b9aca00",
        miner: state.MOCK_ACCOUNT,
        extraData: "0x",
        logsBloom: `0x${"0".repeat(512)}`,
        size: "0x0",
        transactions: [],
        uncles: [],
      };
    case "eth_getBalance":
      return numberToHex(10n ** 19n);
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return numberToHex(10n ** 9n);
    case "eth_estimateGas":
      return numberToHex(100_000);
    case "eth_getTransactionCount":
      return numberToHex(txSeq);
    case "eth_call": {
      const tx = p[0] as { to?: string; data?: Hex; input?: Hex };
      const data = tx.data ?? tx.input ?? "0x";
      if (sameAddress(tx.to, config.exchange)) return callExchange(data);
      if (sameAddress(tx.to, config.usdc)) return callUsdc(data);
      throw new RpcError(-32602, "mock: eth_call to unknown address");
    }
    case "eth_sendTransaction": {
      const tx = p[0] as { to?: string; data?: Hex };
      await sleep(700); // pretend the user is confirming in the wallet
      sendTransaction(tx.to, tx.data ?? "0x");
      return `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    }
    case "eth_getTransactionReceipt": {
      await sleep(900); // pretend the transaction is being mined
      return {
        transactionHash: p[0],
        transactionIndex: "0x0",
        blockHash: zeroHash,
        blockNumber: numberToHex(blockNumber()),
        from: state.MOCK_ACCOUNT,
        to: config.exchange,
        cumulativeGasUsed: "0x186a0",
        gasUsed: "0x186a0",
        effectiveGasPrice: "0x3b9aca00",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status: "0x1",
        type: "0x2",
      };
    }
    case "eth_signTypedData_v4":
      await sleep(300);
      // v = 0 on purpose: exercises the 0/1 -> 27/28 normalization in the app.
      return `0x${"11".repeat(64)}00`;
    default:
      throw new RpcError(-32601, `mock provider: ${method} not supported`);
  }
}

export const mockProvider = {
  request,
  // The mock never changes account or chain, so listeners are never called.
  on: () => {},
  removeListener: () => {},
};
