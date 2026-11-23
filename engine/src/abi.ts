import { parseAbi } from "viem";
import { EXCHANGE_ABI } from "../../shared/src/index.ts";

export const exchangeAbi = parseAbi(EXCHANGE_ABI);
