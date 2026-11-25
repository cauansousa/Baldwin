// Deterministic block timestamps for tests that must be reproducible: every mined block
// gets previous + 1 second unless the test asked for a specific time or an increase.
// Without this, automined blocks take the wall clock's time whenever it is ahead, so
// elapsed-time dependent logic (funding) differs from run to run.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { network } from "hardhat";

/** Installs the logical clock on the hardhat provider; returns a function that removes it. */
export function installLogicalClock(): () => void {
  const provider: any = network.provider;
  const originalRequest = provider.request;
  const originalSend = provider.send;
  const request = originalRequest.bind(provider);
  let clock: number | undefined; // timestamp of the latest block, as far as we know
  let pinned = false; // the test set the next timestamp itself
  const latest = async () => Number((await request({ method: "eth_getBlockByNumber", params: ["latest", false] })).timestamp);

  provider.request = async (args: { method: string; params?: any[] }) => {
    const m = args.method;
    if (m === "evm_revert" || m === "hardhat_reset") {
      const out = await request(args);
      clock = undefined; // resync with the restored chain
      pinned = false;
      return out;
    }
    if (m === "evm_setNextBlockTimestamp") {
      pinned = true;
      clock = Number(args.params![0]) - 1;
      return request(args);
    }
    if (m === "evm_increaseTime") {
      if (clock === undefined) clock = await latest();
      clock += Number(args.params![0]) - 1; // the block that follows adds the last second
      return "0x0";
    }
    if (m === "eth_sendTransaction" || m === "eth_sendRawTransaction" || m === "evm_mine" || m === "hardhat_mine") {
      if (clock === undefined) clock = await latest();
      clock += 1;
      if (!pinned) await request({ method: "evm_setNextBlockTimestamp", params: [clock] });
      pinned = false;
      try {
        return await request(m === "evm_mine" || m === "hardhat_mine" ? { method: "evm_mine", params: [] } : args);
      } catch (e) {
        clock = undefined; // a rejected transaction mines nothing; resync
        throw e;
      }
    }
    return request(args);
  };
  // ethers' hardhat provider goes through send(); route it through the same wrapper.
  provider.send = (method: string, params: any[] = []) => provider.request({ method, params });

  return () => {
    provider.request = originalRequest;
    provider.send = originalSend;
  };
}
