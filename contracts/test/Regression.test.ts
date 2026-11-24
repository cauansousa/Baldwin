// Regression tests for the findings of the first external review. Each scenario is the
// reviewer's attack; the assertions state that it no longer works.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import { BTC, BTC_PRICE, Ctx, ETH, HOUR, MAX_PRICE_AGE, deployFixture, marketConfig, usdc, wad } from "./helpers";

const ONE = wad(1);
const MAX = ethers.MaxUint256;

describe("Review regressions", () => {
  /** alice short 1 BTC / bob long 1 BTC at 50,000, both thinly margined; dave is the accomplice. */
  async function stripFixture() {
    const f = await loadFixture(deployFixture);
    const { exchange, ctx, alice, bob, carol, dave, liquidator } = f;
    await exchange.connect(carol).deposit(usdc(100_000)); // honest money
    await exchange.connect(liquidator).deposit(usdc(100_000));
    await exchange.connect(alice).deposit(usdc(10_100));
    await exchange.connect(bob).deposit(usdc(10_100));
    await exchange.connect(dave).deposit(usdc(100));
    await ctx.settleOk([await ctx.trade(bob, alice, ONE, BTC_PRICE)]);
    return f;
  }

  /** The price at which buying back `size` would burn all but ~2 USDC of the account's value. */
  async function stripPrice(f: Awaited<ReturnType<typeof stripFixture>>, size: bigint, index: bigint) {
    const value = await f.exchange.accountValue(f.alice.address);
    const indexNotional = (size * index) / 10n ** 30n;
    return ((value - usdc(2) + indexNotional) * 10n ** 30n * 10000n) / (size * 10002n);
  }

  describe("H1: reducing fills cannot strip equity", () => {
    it("the off-market 'reducing' fill is rejected by the price band", async () => {
      const f = await stripFixture();
      const { exchange, ctx, alice, dave } = f;
      const size = wad("0.001");
      const price = await stripPrice(f, size, BTC_PRICE);
      expect(price).to.be.gt(BTC_PRICE * 100n); // ~200x the index
      const valueBefore = await exchange.accountValue(alice.address);

      const m = await ctx.trade(alice, dave, size, price);
      const receipt = (await (await ctx.settle([m])).wait())!;
      expect(ctx.failures(receipt)).to.deep.equal([{ index: 0, error: "PriceOutOfBand" }]);
      await expect(ctx.settle([m]))
        .to.emit(exchange, "MatchFailed")
        .withArgs(
          0,
          await exchange.hashOrder(m.maker),
          await exchange.hashOrder(m.taker),
          exchange.interface.encodeErrorResult("PriceOutOfBand", [price, BTC_PRICE]),
        );
      expect(await exchange.accountValue(alice.address)).to.equal(valueBefore);
      expect(await exchange.freeCollateral(dave.address)).to.equal(usdc(100));
    });

    it("the band is inclusive at exactly maxPriceDeviationBps and applies on both sides", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(100_000));
      await exchange.connect(bob).deposit(usdc(100_000));
      const size = wad("0.01");
      expect(await ctx.settleError(await ctx.trade(alice, bob, size, wad(52_500) + 1n))).to.equal("PriceOutOfBand");
      expect(await ctx.settleError(await ctx.trade(alice, bob, size, wad(47_500) - 1n))).to.equal("PriceOutOfBand");
      expect(await ctx.settleError(await ctx.trade(alice, bob, size, wad(52_500)))).to.equal("");
      expect(await ctx.settleError(await ctx.trade(alice, bob, size, wad(47_500)))).to.equal("");
      // the band follows the index
      await ctx.oracle.setPrice(BTC, wad(60_000));
      expect(await ctx.settleError(await ctx.trade(alice, bob, size, wad(52_500)))).to.equal("PriceOutOfBand");
      expect(await ctx.settleError(await ctx.trade(alice, bob, size, wad(63_000)))).to.equal("");
    });

    it("the worst in-band strip does not weaken the account: the same +2% move leaves no bad debt", async () => {
      const f = await stripFixture();
      const { exchange, oracle, ctx, alice, dave, liquidator } = f;
      const health = async () => {
        const [, maintenance] = await exchange.marginRequirement(alice.address);
        return (await exchange.accountValue(alice.address)) - BigInt(maintenance);
      };
      await exchange.connect(dave).deposit(usdc(10_000));
      // Alice buys back at the top of the band, in ten slices of 0.05 BTC.
      let before = await health();
      for (let i = 0; i < 10; i++) {
        await ctx.settleOk([await ctx.trade(alice, dave, wad("0.05"), wad(52_500), { makerIsSeller: true })]);
        const after = await health();
        expect(after, "health never decreases on a reducing fill").to.be.gte(before);
        before = after;
      }
      // She did hand ~1,250 to dave, but only together with the position that money backed.
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(-wad("0.5"));

      await oracle.setPrice(BTC, wad(51_000));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
      expect(await exchange.totalBadDebt()).to.equal(0);
    });

    it("variant: a liquidatable account cannot dodge the penalty by stripping first", async () => {
      const f = await stripFixture();
      const { exchange, oracle, ctx, alice, dave, liquidator } = f;
      await oracle.setPrice(BTC, wad(54_700));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);
      const price = await stripPrice(f, wad("0.001"), wad(54_700));
      expect(await ctx.settleError(await ctx.trade(alice, dave, wad("0.001"), price))).to.equal("PriceOutOfBand");

      // Best she can do in-band (buy back 0.001 at +5%); the liquidation still pays the penalty.
      await ctx.settleOk([await ctx.trade(alice, dave, wad("0.001"), wad(57_435))]);
      const insurance = await exchange.insuranceFund();
      const liquidatorBalance = await exchange.balanceOf(liquidator.address);
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      // 1.5% of 0.999 * 54,700 = 819.6795, half each
      expect((await exchange.insuranceFund()) - insurance).to.equal(usdc("409.83975"));
      expect((await exchange.balanceOf(liquidator.address)) - liquidatorBalance).to.equal(usdc("409.83975"));
      expect(await exchange.totalBadDebt()).to.equal(0);
    });

    it("variant: no reducing fill at a stale price", async () => {
      const f = await stripFixture();
      const { ctx, alice, dave } = f;
      await time.increase(MAX_PRICE_AGE + 1);
      // in-band relative to the last known price, but that price is stale
      expect(await ctx.settleError(await ctx.trade(alice, dave, wad("0.001"), wad(52_000)))).to.equal("StalePrice");
      expect(await ctx.settleError(await ctx.trade(alice, dave, ONE, BTC_PRICE))).to.equal("StalePrice");
    });

    it("variant: closing a dust position in one market cannot strip the equity backing another", async () => {
      const f = await stripFixture();
      const { exchange, ctx, alice, dave } = f;
      await exchange.connect(dave).deposit(usdc(1_000));
      // alice opens a small ETH long (0.01 ETH = 20 USDC notional) next to her BTC short
      await ctx.settleOk([await ctx.trade(alice, dave, wad("0.01"), wad(2_000), { marketId: ETH })]);
      const value = await exchange.accountValue(alice.address);
      // selling it for (almost) nothing would be a 'full close' ...
      for (const p of [1n, wad(1), wad(1_000), wad(1_899)]) {
        expect(await ctx.settleError(await ctx.trade(dave, alice, wad("0.01"), p, { marketId: ETH }))).to.equal("PriceOutOfBand");
      }
      // ... and buying BTC dust back at a huge price is covered by the BTC band as before.
      expect(await exchange.accountValue(alice.address)).to.equal(value);
      // at the band edge the close goes through and costs at most 5% of 20 USDC plus fees
      await ctx.settleOk([await ctx.trade(dave, alice, wad("0.01"), wad(1_900), { marketId: ETH })]);
      expect(value - (await exchange.accountValue(alice.address))).to.be.lte(usdc("1.02"));
    });

    it("market parameters must keep a reducing fill health-neutral: band + fee < maintenance", async () => {
      const { exchange } = await loadFixture(deployFixture);
      for (const maintenanceMarginBps of [505, 506, 580]) {
        await expect(exchange.updateMarket(BTC, marketConfig("BTC-USD", { maintenanceMarginBps }))).to.be.revertedWithCustomError(
          exchange,
          "InvalidMarketConfig",
        );
      }
      // 581 > 8h of capped funding (80) + band (500)
      await exchange.updateMarket(BTC, marketConfig("BTC-USD", { maintenanceMarginBps: 581 }));
    });
  });

  describe("M: funding cannot be steered with dust fills", () => {
    it("a 1-wei fill at 2x the index is rejected (band), and so is a 1-wei fill in band (size)", async () => {
      const { exchange, ctx, alice, bob, carol, dave } = await loadFixture(deployFixture);
      for (const x of [alice, bob, carol, dave]) await exchange.connect(x).deposit(usdc(20_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]);

      const attempt = async (price: bigint, fill: bigint) => {
        const buy = ctx.order(carol, true, wad("0.001"), price);
        const sell = ctx.order(dave, false, wad("0.001"), price);
        return ctx.settleError(await ctx.match(carol, buy, dave, sell, fill));
      };
      expect(await attempt(wad(100_000), 1n)).to.equal("PriceOutOfBand");
      expect(await attempt(wad(100_000), wad("0.001"))).to.equal("PriceOutOfBand");
      expect(await attempt(wad(52_500), 1n)).to.equal("FillTooSmall");
      expect(await exchange.markPrice(BTC)).to.equal(BTC_PRICE);

      // No premium: 24 hours of accruals cost the long nothing.
      const before = await exchange.accountValue(alice.address);
      for (let i = 0; i < 24; i++) {
        await time.increase(HOUR);
        await ctx.oracle.setPrice(BTC, BTC_PRICE);
        await exchange.updateFunding(BTC);
      }
      expect(await exchange.accountValue(alice.address)).to.equal(before);
    });

    it("small fills are only for completing an order or closing a position", async () => {
      const { exchange, ctx, alice, bob, carol } = await loadFixture(deployFixture);
      for (const x of [alice, bob, carol]) await exchange.connect(x).deposit(usdc(50_000));
      const min = wad("0.001");
      const size = wad("0.0025");
      const buy = ctx.order(alice, true, size, BTC_PRICE);
      const sell = ctx.order(bob, false, wad(10), BTC_PRICE);
      const m = await ctx.match(alice, buy, bob, sell, 0n);

      m.fillSize = min - 1n;
      expect(await ctx.settleError(m)).to.equal("FillTooSmall");
      m.fillSize = min;
      expect(await ctx.settleError(m)).to.equal("");
      m.fillSize = min;
      expect(await ctx.settleError(m)).to.equal("");
      // 0.0005 left on the buy order: a partial fill of it is too small, the rest of it is not
      m.fillSize = wad("0.0004");
      expect(await ctx.settleError(m)).to.equal("FillTooSmall");
      m.fillSize = wad("0.0005");
      expect(await ctx.settleError(m)).to.equal("");
      expect(await exchange.filledSize(await exchange.hashOrder(buy))).to.equal(size);

      // alice sells 0.002 to carol, which leaves her 0.0005: below the minimum order size
      await ctx.settleOk([await ctx.trade(carol, alice, wad("0.002"), BTC_PRICE)]);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(wad("0.0005"));
      // The dust can be closed with an order of the minimum size, filled for exactly the position ...
      const close = ctx.order(alice, false, min, BTC_PRICE, { reduceOnly: true });
      const other = ctx.order(carol, true, wad(1), BTC_PRICE);
      const c = await ctx.match(carol, other, alice, close, wad("0.0004"));
      // ... but not partially
      expect(await ctx.settleError(c)).to.equal("FillTooSmall");
      c.fillSize = wad("0.0005");
      expect(await ctx.settleError(c)).to.equal("");
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(0);
    });

    it("the funding rate cap cannot be configured above 100 bps per hour", async () => {
      const { exchange, token, oracle, owner } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("Exchange");
      const args = [await token.getAddress(), await oracle.getAddress(), owner.address, owner.address, 3600] as const;
      await expect(F.deploy(...args, 101, 500)).to.be.revertedWithCustomError(exchange, "InvalidConfig");
      await F.deploy(...args, 100, 500);
      expect(await exchange.MAX_FUNDING_RATE_CAP_BPS()).to.equal(100);
    });
  });

  describe("L: withdraw accrues funding first", () => {
    it("free collateral cannot be withdrawn just before due funding is charged", async () => {
      const { exchange, oracle, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(20_000));
      await exchange.connect(bob).deposit(usdc(20_000));
      // long opened 5% above the index: the premium is at the cap (10 bps per hour)
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(52_500))]);
      await time.increase(8 * HOUR);
      await oracle.setPrice(BTC, BTC_PRICE);

      // The view does not know about funding that is due but not accrued yet ...
      const staleFree = await exchange.freeCollateral(alice.address);
      // ... but withdraw accrues it first: 8h * 50 USDC = 400 are owed.
      await expect(exchange.connect(alice).withdraw(staleFree)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
      await expect(exchange.connect(alice).withdraw(staleFree - usdc(400) + 1n)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
      await expect(exchange.connect(alice).withdraw(staleFree - usdc(400))).to.emit(exchange, "FundingUpdated");
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad(400));
      const [initial] = await exchange.marginRequirement(alice.address);
      expect(await exchange.accountValue(alice.address)).to.equal(initial);
      expect(await exchange.freeCollateral(alice.address)).to.equal(0);
    });
  });

  describe("L: batch gas floor", () => {
    it("an under-gassed batch reverts as a whole instead of reporting MatchFailed", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const floor = (await exchange.MATCH_GAS_BASE()) + (await exchange.MATCH_GAS_PER_MARKET()) * 2n;
      expect(floor).to.equal(700_000n);

      const m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      await expect(exchange.connect(ctx.operator).settleMatches([m], { gasLimit: 400_000 })).to.be.revertedWithCustomError(exchange, "InsufficientGas");
      // enough for the first match but not for the floor before the second
      const m2 = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      await expect(exchange.connect(ctx.operator).settleMatches([m, m2], { gasLimit: 800_000 })).to.be.revertedWithCustomError(exchange, "InsufficientGas");
      expect(await exchange.filledSize(await exchange.hashOrder(m.maker))).to.equal(0);
      await expect(exchange.connect(ctx.operator).settleMatches([m, m2], { gasLimit: 1_500_000 })).to.emit(exchange, "Fill");
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(wad(2));
    });
  });

  describe("L: batch gas floor, measured", () => {
    // The most expensive matches we know: both accounts hold a position in every market;
    // either both flip (with a funding accrual and pending funding), or both reduce.
    // Measured with the mock oracle and with the Chainlink adapter (mock aggregators,
    // sequencer uptime feed enabled), which is what production uses.
    const MARKET_PRICE = (i: number) => (i === 0 ? 50_000n : 2_000n);

    async function mockOracleSetup(extraMarkets: number) {
      const f = await deployFixture();
      for (let i = 0; i < extraMarkets; i++) await f.exchange.addMarket(marketConfig(`M${i}-USD`));
      const n = 2 + extraMarkets;
      const refresh = async () => {
        for (let i = 0; i < n; i++) await f.oracle.setPrice(i, wad(MARKET_PRICE(i)));
      };
      return { exchange: f.exchange, ctx: f.ctx, alice: f.alice, bob: f.bob, n, refresh };
    }

    async function chainlinkSetup(extraMarkets: number) {
      const [owner, operator, feeRecipient, alice, bob] = await ethers.getSigners();
      const n = 2 + extraMarkets;
      const Agg = await ethers.getContractFactory("MockAggregator");
      const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const sequencer = await Agg.deploy(0);
      const start = await time.latest();
      await sequencer.setRound(0, start - 100_000, start - 100_000);
      const oracle = await (await ethers.getContractFactory("ChainlinkOracle")).deploy(owner.address, await sequencer.getAddress(), 3600);
      const exchange = await (
        await ethers.getContractFactory("Exchange")
      ).deploy(await token.getAddress(), await oracle.getAddress(), owner.address, feeRecipient.address, 3600, 10, 500);
      const aggs = [];
      for (let i = 0; i < n; i++) {
        const agg = await Agg.deploy(8);
        await oracle.setFeed(i, await agg.getAddress(), 3600);
        await exchange.addMarket(marketConfig(`M${i}-USD`));
        aggs.push(agg);
      }
      const refresh = async () => {
        for (let i = 0; i < n; i++) await aggs[i].set(MARKET_PRICE(i) * 10n ** 8n, await time.latest());
      };
      await exchange.setOperator(operator.address, true);
      for (const s of [alice, bob]) {
        await token.mint(s.address, usdc(10_000_000));
        await token.connect(s).approve(await exchange.getAddress(), MAX);
      }
      const expiry = (await time.latest()) + 20 * 24 * HOUR;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = new Ctx(exchange as any, undefined as any, token as any, operator, expiry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { exchange: exchange as any as Awaited<ReturnType<typeof mockOracleSetup>>["exchange"], ctx, alice, bob, n, refresh };
    }

    const setups = { "mock oracle": mockOracleSetup, "Chainlink adapter + sequencer feed": chainlinkSetup };
    for (const [oracleKind, setup] of Object.entries(setups)) {
      for (const extraMarkets of [0, 6]) {
        it(`no gas limit turns a valid worst-case match into MatchFailed (${oracleKind}, ${2 + extraMarkets} markets)`, async () => {
          const { exchange, ctx, alice, bob, n, refresh } = await setup(extraMarkets);
          await refresh();
          await exchange.connect(alice).deposit(usdc(5_000_000));
          await exchange.connect(bob).deposit(usdc(5_000_000));
          for (let i = 0; i < n; i++) {
            await ctx.settleOk([await ctx.trade(alice, bob, ONE, (wad(MARKET_PRICE(i)) * 104n) / 100n, { marketId: i })]);
          }
          await time.increase(HOUR + 5);
          await refresh();
          for (let i = 1; i < n; i++) await exchange.updateFunding(i);
          const floor = (await exchange.MATCH_GAS_BASE()) + (await exchange.MATCH_GAS_PER_MARKET()) * BigInt(n);

          const cases = {
            "flip both": await ctx.trade(bob, alice, wad(3), wad(50_500)),
            "reduce both": await ctx.trade(bob, alice, wad("0.5"), wad(50_500)),
          };
          for (const [label, m] of Object.entries(cases)) {
            const snapshot = await takeSnapshot();
            const receipt = await ctx.settleOk([m]);
            await snapshot.restore();
            if (process.env.GAS_DEBUG) console.log(`        ${oracleKind}, ${n} markets, ${label}: ${receipt.gasUsed} gas (floor ${floor})`);
            // the floor has real headroom over the measured cost of the whole transaction
            expect(receipt.gasUsed * 13n, `${label}: headroom`).to.be.lt(floor * 10n);

            let reverted = 0;
            let settled = 0;
            for (let gasLimit = 150_000n; gasLimit <= floor + 300_000n; gasLimit += 25_000n) {
              const s = await takeSnapshot();
              try {
                const r = (await (await exchange.connect(ctx.operator).settleMatches([m], { gasLimit })).wait())!;
                expect(ctx.failures(r), `${label} with gas limit ${gasLimit}`).to.deep.equal([]);
                settled++;
              } catch (e) {
                if ((e as Error).name === "AssertionError") throw e;
                reverted++;
              }
              await s.restore();
            }
            expect(reverted, label).to.be.gt(0);
            expect(settled, label).to.be.gt(0);
          }
        });
      }
    }
  });

  describe("L: oracle timestamps from the future", () => {
    it("are treated as unusable everywhere", async () => {
      const { exchange, oracle, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]);
      await oracle.setPriceAt(BTC, wad(50_000), (await time.latest()) + 10 * HOUR);
      await expect(exchange.indexPrice(BTC)).to.be.revertedWithCustomError(exchange, "StalePrice");
      await expect(exchange.connect(alice).withdraw(1)).to.be.revertedWithCustomError(exchange, "StalePrice");
      expect(await ctx.settleError(await ctx.trade(bob, alice, ONE, BTC_PRICE))).to.equal("StalePrice");
      // and it does not become "fresh" later either, until a real update arrives
      await time.increase(5 * HOUR);
      await expect(exchange.indexPrice(BTC)).to.be.revertedWithCustomError(exchange, "StalePrice");
    });
  });
});
