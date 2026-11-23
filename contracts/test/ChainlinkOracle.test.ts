import { expect } from "chai";
import { ethers } from "hardhat";
import { wad } from "./helpers";

describe("ChainlinkOracle", () => {
  async function deploy() {
    const [owner, stranger] = await ethers.getSigners();
    const oracle = await (await ethers.getContractFactory("ChainlinkOracle")).deploy(owner.address);
    const Agg = await ethers.getContractFactory("MockAggregator");
    return { owner, stranger, oracle, Agg };
  }

  it("normalizes 8-decimal feeds to WAD and passes updatedAt through", async () => {
    const { oracle, Agg } = await deploy();
    const agg = await Agg.deploy(8);
    await agg.set(5_000_012_345_678n, 1_700_000_000); // 50,000.12345678
    await expect(oracle.setFeed(0, await agg.getAddress())).to.emit(oracle, "FeedSet").withArgs(0, await agg.getAddress(), 8);
    expect(await oracle.getPrice(0)).to.deep.equal([wad("50000.12345678"), 1_700_000_000n]);
    expect(await oracle.feedOf(0)).to.deep.equal([await agg.getAddress(), 8n]);
  });

  it("handles 18 and more than 18 decimals", async () => {
    const { oracle, Agg } = await deploy();
    const a18 = await Agg.deploy(18);
    await a18.set(wad("1234.5"), 10);
    await oracle.setFeed(1, await a18.getAddress());
    expect((await oracle.getPrice(1))[0]).to.equal(wad("1234.5"));

    const a20 = await Agg.deploy(20);
    await a20.set(wad("1234.5") * 100n + 99n, 10);
    await oracle.setFeed(2, await a20.getAddress());
    expect((await oracle.getPrice(2))[0]).to.equal(wad("1234.5"));
    await a20.set(99, 10); // truncates to zero
    await expect(oracle.getPrice(2)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
  });

  it("rejects non-positive answers, incomplete rounds and missing feeds", async () => {
    const { oracle, Agg } = await deploy();
    const agg = await Agg.deploy(8);
    await oracle.setFeed(0, await agg.getAddress());
    await agg.set(0, 100);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer").withArgs(0);
    await agg.set(-5, 100);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await agg.set(5, 0);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await expect(oracle.getPrice(3)).to.be.revertedWithCustomError(oracle, "FeedNotSet").withArgs(3);
  });

  it("only the owner sets feeds", async () => {
    const { oracle, Agg, stranger } = await deploy();
    const agg = await Agg.deploy(8);
    await expect(oracle.connect(stranger).setFeed(0, await agg.getAddress())).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    await expect(oracle.setFeed(0, ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, "InvalidFeed");
    const a40 = await Agg.deploy(40);
    await expect(oracle.setFeed(0, await a40.getAddress())).to.be.revertedWithCustomError(oracle, "InvalidFeed");
  });

  it("works as the exchange's oracle, including staleness", async () => {
    const { oracle, Agg, owner } = await deploy();
    const usdcToken = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const exchange = await (
      await ethers.getContractFactory("Exchange")
    ).deploy(await usdcToken.getAddress(), await oracle.getAddress(), owner.address, owner.address, 3600, 10);
    await exchange.addMarket({
      active: true,
      initialMarginBps: 2000,
      maintenanceMarginBps: 1000,
      makerFeeBps: 2,
      takerFeeBps: 5,
      liquidationPenaltyBps: 150,
      maxOpenInterest: wad(100),
      minOrderSize: wad("0.001"),
      symbol: "BTC-USD",
    });
    const agg = await Agg.deploy(8);
    await oracle.setFeed(0, await agg.getAddress());
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await agg.set(5_000_000_000_000n, now);
    expect(await exchange.indexPrice(0)).to.equal(wad(50_000));
    await agg.set(5_000_000_000_000n, now - 7200);
    await expect(exchange.indexPrice(0)).to.be.revertedWithCustomError(exchange, "StalePrice");
  });
});
