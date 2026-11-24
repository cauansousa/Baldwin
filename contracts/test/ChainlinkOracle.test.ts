import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { marketConfig, wad } from "./helpers";

const HEARTBEAT = 3600;
const GRACE = 1800;

describe("ChainlinkOracle", () => {
  async function deploy(withSequencer = false) {
    const [owner, stranger, multisig] = await ethers.getSigners();
    const Agg = await ethers.getContractFactory("MockAggregator");
    const sequencer = await Agg.deploy(0);
    const now = await time.latest();
    await sequencer.setRound(0, now - 10 * GRACE, now); // up for a long time
    const oracle = await (
      await ethers.getContractFactory("ChainlinkOracle")
    ).deploy(owner.address, withSequencer ? await sequencer.getAddress() : ethers.ZeroAddress, GRACE);
    return { owner, stranger, multisig, oracle, Agg, sequencer };
  }

  it("normalizes 8-decimal feeds to WAD and passes updatedAt through", async () => {
    const { oracle, Agg } = await deploy();
    const agg = await Agg.deploy(8);
    const now = await time.latest();
    await agg.set(5_000_012_345_678n, now); // 50,000.12345678
    await expect(oracle.setFeed(0, await agg.getAddress(), HEARTBEAT))
      .to.emit(oracle, "FeedSet")
      .withArgs(0, await agg.getAddress(), 8, HEARTBEAT);
    expect(await oracle.getPrice(0)).to.deep.equal([wad("50000.12345678"), BigInt(now)]);
    expect(await oracle.feedOf(0)).to.deep.equal([await agg.getAddress(), 8n, BigInt(HEARTBEAT)]);
  });

  it("handles 18 and more than 18 decimals", async () => {
    const { oracle, Agg } = await deploy();
    const now = await time.latest();
    const a18 = await Agg.deploy(18);
    await a18.set(wad("1234.5"), now);
    await oracle.setFeed(1, await a18.getAddress(), HEARTBEAT);
    expect((await oracle.getPrice(1))[0]).to.equal(wad("1234.5"));

    const a20 = await Agg.deploy(20);
    await a20.set(wad("1234.5") * 100n + 99n, now);
    await oracle.setFeed(2, await a20.getAddress(), HEARTBEAT);
    expect((await oracle.getPrice(2))[0]).to.equal(wad("1234.5"));
    await a20.set(99, now); // truncates to zero
    await expect(oracle.getPrice(2)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
  });

  it("rejects non-positive answers, incomplete rounds, future timestamps and missing feeds", async () => {
    const { oracle, Agg } = await deploy();
    const agg = await Agg.deploy(8);
    await oracle.setFeed(0, await agg.getAddress(), HEARTBEAT);
    const now = await time.latest();
    await agg.set(0, now);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer").withArgs(0);
    await agg.set(-5, now);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await agg.set(5, 0);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await expect(oracle.getPrice(3)).to.be.revertedWithCustomError(oracle, "FeedNotSet").withArgs(3);
    // a timestamp in the future is not a real observation
    await agg.set(5, now + 3600);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await agg.set(5, await time.latest());
    expect((await oracle.getPrice(0))[0]).to.equal(5n * 10n ** 10n);
  });

  it("enforces the per-market heartbeat", async () => {
    const { oracle, Agg } = await deploy();
    const fast = await Agg.deploy(8);
    const slow = await Agg.deploy(8);
    await oracle.setFeed(0, await fast.getAddress(), 600);
    await oracle.setFeed(1, await slow.getAddress(), 86_400);
    const t = await time.latest();
    await fast.set(100, t);
    await slow.set(100, t);

    await time.increaseTo(t + 600);
    expect((await oracle.getPrice(0))[1]).to.equal(t); // inclusive
    await time.increaseTo(t + 601);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "FeedStale").withArgs(0, t);
    expect((await oracle.getPrice(1))[1]).to.equal(t); // the slow feed has its own limit
    await time.increaseTo(t + 86_401);
    await expect(oracle.getPrice(1)).to.be.revertedWithCustomError(oracle, "FeedStale").withArgs(1, t);

    // the owner can change the limit by setting the feed again
    await oracle.setFeed(0, await fast.getAddress(), 200_000);
    expect((await oracle.getPrice(0))[1]).to.equal(t);
  });

  describe("sequencer uptime feed", () => {
    async function withFeed() {
      const f = await deploy(true);
      const agg = await f.Agg.deploy(8);
      await f.oracle.setFeed(0, await agg.getAddress(), HEARTBEAT);
      await agg.set(5_000_000_000_000n, await time.latest());
      return { ...f, agg };
    }

    it("is optional", async () => {
      const off = await deploy(false);
      expect(await off.oracle.sequencerUptimeFeed()).to.equal(ethers.ZeroAddress);
      const on = await withFeed();
      expect(await on.oracle.sequencerUptimeFeed()).to.equal(await on.sequencer.getAddress());
      expect(await on.oracle.sequencerGracePeriod()).to.equal(GRACE);
      expect((await on.oracle.getPrice(0))[0]).to.equal(wad(50_000));
    });

    it("rejects prices while the sequencer is down", async () => {
      const { oracle, sequencer, agg } = await withFeed();
      const now = await time.latest();
      await sequencer.setRound(1, now, now);
      await agg.set(5_000_000_000_000n, await time.latest()); // even with a fresh answer
      await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerDown");
      // still down a day later
      await time.increase(86_400);
      await agg.set(5_000_000_000_000n, await time.latest());
      await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerDown");
    });

    it("waits for the grace period after the sequencer is back", async () => {
      const { oracle, sequencer, agg } = await withFeed();
      const down = await time.latest();
      await sequencer.setRound(1, down, down);
      const up = down + 500;
      await time.setNextBlockTimestamp(up);
      await sequencer.setRound(0, up, up);
      await agg.set(5_000_000_000_000n, await time.latest());
      await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerGracePeriodNotOver");

      await time.increaseTo(up + GRACE); // the boundary still counts as grace (Chainlink: <=)
      await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerGracePeriodNotOver");
      await time.increaseTo(up + GRACE + 1);
      expect((await oracle.getPrice(0))[0]).to.equal(wad(50_000));
    });

    it("rejects an uninitialized or future-dated uptime round", async () => {
      const { oracle, sequencer } = await withFeed();
      await sequencer.setRound(0, 0, 0);
      await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerDown");
      const now = await time.latest();
      await sequencer.setRound(0, now + 10_000, now);
      await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerDown");
    });
  });

  it("the owner can replace or disable the sequencer feed, e.g. when it breaks", async () => {
    const { oracle, Agg, sequencer, stranger } = await deploy(true);
    const agg = await Agg.deploy(8);
    await oracle.setFeed(0, await agg.getAddress(), HEARTBEAT);
    await agg.set(5_000_000_000_000n, await time.latest());
    // the uptime feed gets stuck reporting "down" (or reverting): every price is gone
    const now = await time.latest();
    await sequencer.setRound(1, now, now);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerDown");

    await expect(oracle.connect(stranger).setSequencerUptimeFeed(ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    await expect(oracle.setSequencerUptimeFeed(stranger.address, GRACE)).to.be.revertedWithCustomError(oracle, "InvalidFeed");

    await expect(oracle.setSequencerUptimeFeed(ethers.ZeroAddress, 0)).to.emit(oracle, "SequencerUptimeFeedSet").withArgs(ethers.ZeroAddress, 0);
    expect(await oracle.sequencerUptimeFeed()).to.equal(ethers.ZeroAddress);
    expect((await oracle.getPrice(0))[0]).to.equal(wad(50_000));

    // a replacement feed with a different grace period
    const replacement = await Agg.deploy(0);
    const t = await time.latest();
    await replacement.setRound(0, t - 100, t);
    await expect(oracle.setSequencerUptimeFeed(await replacement.getAddress(), 50))
      .to.emit(oracle, "SequencerUptimeFeedSet")
      .withArgs(await replacement.getAddress(), 50);
    expect(await oracle.sequencerGracePeriod()).to.equal(50);
    expect((await oracle.getPrice(0))[0]).to.equal(wad(50_000));
    await oracle.setSequencerUptimeFeed(await replacement.getAddress(), 10_000);
    await expect(oracle.getPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerGracePeriodNotOver");
  });

  it("ownership cannot be renounced", async () => {
    const { oracle, owner, stranger } = await deploy();
    await expect(oracle.renounceOwnership()).to.be.revertedWithCustomError(oracle, "RenounceDisabled");
    await expect(oracle.connect(stranger).renounceOwnership()).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    expect(await oracle.owner()).to.equal(owner.address);
  });

  it("only the owner sets feeds; ownership moves in two steps", async () => {
    const { oracle, Agg, stranger, multisig, owner } = await deploy();
    const agg = await Agg.deploy(8);
    const a = await agg.getAddress();
    await expect(oracle.connect(stranger).setFeed(0, a, HEARTBEAT)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    await expect(oracle.setFeed(0, ethers.ZeroAddress, HEARTBEAT)).to.be.revertedWithCustomError(oracle, "InvalidFeed");
    await expect(oracle.setFeed(0, a, 0)).to.be.revertedWithCustomError(oracle, "InvalidFeed");
    const a40 = await Agg.deploy(40);
    await expect(oracle.setFeed(0, await a40.getAddress(), HEARTBEAT)).to.be.revertedWithCustomError(oracle, "InvalidFeed");

    await oracle.transferOwnership(multisig.address);
    expect(await oracle.owner()).to.equal(owner.address);
    expect(await oracle.pendingOwner()).to.equal(multisig.address);
    await expect(oracle.connect(multisig).setFeed(0, a, HEARTBEAT)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    await expect(oracle.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    await oracle.connect(multisig).acceptOwnership();
    expect(await oracle.owner()).to.equal(multisig.address);
    await oracle.connect(multisig).setFeed(0, a, HEARTBEAT);
    await expect(oracle.setFeed(0, a, HEARTBEAT)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
  });

  it("works as the exchange's oracle: staleness, heartbeat and sequencer errors surface", async () => {
    const { oracle, Agg, owner, sequencer } = await deploy(true);
    const usdcToken = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const exchange = await (
      await ethers.getContractFactory("Exchange")
    ).deploy(await usdcToken.getAddress(), await oracle.getAddress(), owner.address, owner.address, 7200, 10, 500);
    await exchange.addMarket(marketConfig("BTC-USD"));
    const agg = await Agg.deploy(8);
    await oracle.setFeed(0, await agg.getAddress(), HEARTBEAT);
    const now = await time.latest();
    await agg.set(5_000_000_000_000n, now);
    expect(await exchange.indexPrice(0)).to.equal(wad(50_000));
    // older than the feed heartbeat (1h) but inside the exchange's maxPriceAge (2h): the adapter rejects
    await agg.set(5_000_000_000_000n, now - 5000);
    await expect(exchange.indexPrice(0)).to.be.revertedWithCustomError(oracle, "FeedStale");
    // a longer heartbeat lets it through to the exchange's own limit
    await oracle.setFeed(0, await agg.getAddress(), 86_400);
    expect(await exchange.indexPrice(0)).to.equal(wad(50_000));
    await agg.set(5_000_000_000_000n, now - 8000);
    await expect(exchange.indexPrice(0)).to.be.revertedWithCustomError(exchange, "StalePrice");

    await agg.set(5_000_000_000_000n, await time.latest());
    const t = await time.latest();
    await sequencer.setRound(1, t, t);
    await expect(exchange.indexPrice(0)).to.be.revertedWithCustomError(oracle, "SequencerDown");
    // funding accrual does not revert while the oracle does
    await time.increase(3600);
    await expect(exchange.updateFunding(0)).to.emit(exchange, "FundingUpdated");
  });
});
