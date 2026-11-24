import { describe, expect, it } from "vitest";
import { ARBITRUM_SEPOLIA_CHAIN_ID, explorerLink, LOCAL_CHAIN_ID, pickDeployment, resolveChain } from "./chains";
import { selectWallets } from "./wallets";

const tx = `0x${"ab".repeat(32)}`;
const addr = `0x${"cd".repeat(20)}`;

describe("resolveChain", () => {
  it("local node", () => {
    const c = resolveChain(LOCAL_CHAIN_ID);
    expect(c.id).toBe(31337);
    expect(c.rpcUrls.default.http[0]).toBe("http://127.0.0.1:8545");
    expect(c.blockExplorers).toBeUndefined();
    expect(resolveChain(31337, { rpcUrl: " http://10.0.0.5:8545 " }).rpcUrls.default.http[0]).toBe("http://10.0.0.5:8545");
  });

  it("Arbitrum Sepolia has a name, native currency, explorer and default RPC for wallet_addEthereumChain", () => {
    const c = resolveChain(ARBITRUM_SEPOLIA_CHAIN_ID);
    expect(c.id).toBe(421614);
    expect(c.name).toBe("Arbitrum Sepolia");
    expect(c.nativeCurrency.symbol).toBe("ETH");
    expect(c.rpcUrls.default.http[0]).toMatch(/^https:\/\//);
    expect(c.blockExplorers?.default.url).toMatch(/^https:\/\//);
    expect(c.testnet).toBe(true);
  });

  it("an RPC override keeps the rest of the Arbitrum Sepolia definition", () => {
    const c = resolveChain(421614, { rpcUrl: "https://rpc.example/x" });
    expect(c.rpcUrls.default.http).toEqual(["https://rpc.example/x"]);
    expect(c.blockExplorers?.default.url).toBe(resolveChain(421614).blockExplorers?.default.url);
    expect(resolveChain(421614, { rpcUrl: "  " }).rpcUrls.default.http).toEqual(resolveChain(421614).rpcUrls.default.http);
  });

  it("unknown chains are generic, with an optional explorer", () => {
    expect(resolveChain(5, {}).blockExplorers).toBeUndefined();
    expect(resolveChain(5, { explorerUrl: "https://scan.example/" }).blockExplorers?.default.url).toBe("https://scan.example");
    expect(resolveChain(5, { explorerUrl: "javascript:alert(1)" }).blockExplorers).toBeUndefined();
  });
});

describe("explorerLink", () => {
  const testnet = resolveChain(421614);
  it("builds tx and address links", () => {
    const base = testnet.blockExplorers!.default.url;
    expect(explorerLink(testnet, "tx", tx)).toBe(`${base}/tx/${tx}`);
    expect(explorerLink(testnet, "address", addr)).toBe(`${base}/address/${addr}`);
  });
  it("returns undefined without an explorer or for malformed values", () => {
    expect(explorerLink(resolveChain(31337), "tx", tx)).toBeUndefined();
    expect(explorerLink(testnet, "tx", addr)).toBeUndefined();
    expect(explorerLink(testnet, "address", "0x123/../../evil")).toBeUndefined();
  });
});

describe("pickDeployment", () => {
  it("selects the deployment file matching the configured chain", () => {
    const files = [{ chainId: 31337, exchange: "0xlocal" }, null, "junk", { chainId: "421614", exchange: "0xtestnet" }];
    expect(pickDeployment<{ exchange: string }>(files, 421614)?.exchange).toBe("0xtestnet");
    expect(pickDeployment<{ exchange: string }>(files, 31337)?.exchange).toBe("0xlocal");
    expect(pickDeployment(files, 1)).toBeUndefined();
    expect(pickDeployment([], 31337)).toBeUndefined();
  });
});

describe("selectWallets", () => {
  const generic = { id: "injected", name: "Injected", type: "injected" };
  const metamask = { id: "io.metamask", name: "MetaMask", type: "injected" };
  const rabby = { id: "io.rabby", name: "Rabby", type: "injected" };
  it("offers the generic connector only when no wallet announced itself (EIP-6963)", () => {
    expect(selectWallets([generic])).toEqual([generic]);
    expect(selectWallets([generic, metamask, rabby])).toEqual([metamask, rabby]);
    expect(selectWallets([generic, metamask, metamask])).toEqual([metamask]);
    expect(selectWallets([])).toEqual([]);
  });
});
