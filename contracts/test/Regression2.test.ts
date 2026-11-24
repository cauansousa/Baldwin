// Regression tests for the findings of the second external review (P1-P4 are the
// reviewer's scenarios; the assertions state that the bad outcome no longer happens).
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import { BTC, BTC_PRICE, ETH, ETH_PRICE, HOUR, deployFixture, marketConfig, usdc, wad } from "./helpers";

const ONE = wad(1);
const MAX = ethers.MaxUint256;

describe("Review 2 regressions", () => {
  /** alice short 1 BTC (balance 10,075), bob long 1 BTC (balance 10,090) at 50,000. */
  async function base() {
    const f = await loadFixture(deployFixture);
    const { exchange, ctx, alice, bob, carol, dave, liquidator } = f;
    await exchange.connect(carol).deposit(usdc(100_000));
    await exchange.connect(liquidator).deposit(usdc(100_000));
    await exchange.connect(alice).deposit(usdc(10_100));
    await exchange.connect(bob).deposit(usdc(10_100));
    await exchange.connect(dave).deposit(usdc(12_000));
    await ctx.settleOk([await ctx.trade(bob, alice, ONE, BTC_PRICE)]);
    return f;
  }

  describe("P1: a liquidatable account cannot hand over its last equity through reducing fills", () => {
    it("partial reductions that lower value / maintenance are refused; bad debt stays at the baseline", async () => {
      const f = await base();
      const { exchange, oracle, ctx, alice, dave, liquidator } = f;
      await oracle.setPrice(BTC, wad(59_000));
      // value 1,075 against a maintenance requirement of 5,900
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(1_075));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);

      // baseline: +2% without any strip
      const snapshot = await takeSnapshot();
      await oracle.setPrice(BTC, wad(60_180));
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      const baselineBadDebt = await exchange.totalBadDebt();
      expect(baselineBadDebt).to.equal(usdc(105));
      await snapshot.restore();

      // the reviewer's strip: buy back 0.36 BTC from the accomplice at the top of the band
      const top = wad(61_950);
      expect(await ctx.settleError(await ctx.trade(alice, dave, wad("0.36"), top))).to.equal("InsufficientMargin");
      // ... in any size, as maker or taker ...
      for (const size of ["0.001", "0.05", "0.2", "0.3"]) {
        expect(await ctx.settleError(await ctx.trade(alice, dave, wad(size), top)), size).to.equal("InsufficientMargin");
        expect(await ctx.settleError(await ctx.trade(alice, dave, wad(size), top, { makerIsSeller: true })), size).to.equal("InsufficientMargin");
      }
      // ... or milder: 2% above the index still costs more per unit of maintenance
      // released (2% of 10%) than she has equity per unit of maintenance (18%)
      expect(await ctx.settleError(await ctx.trade(alice, dave, wad("0.36"), wad(60_180)))).to.equal("InsufficientMargin");
      // larger sizes at the top of the band cost more than she has at all
      expect(await ctx.settleError(await ctx.trade(alice, dave, wad("0.64"), top))).to.equal("NegativeAccountValue");
      expect(await ctx.settleError(await ctx.trade(alice, dave, ONE, top))).to.equal("NegativeAccountValue");

      expect(await exchange.accountValue(alice.address)).to.equal(usdc(1_075));
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(-ONE);
      expect(await exchange.accountValue(dave.address)).to.equal(usdc(12_000));

      await oracle.setPrice(BTC, wad(60_180));
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect(await exchange.totalBadDebt()).to.equal(baselineBadDebt);
    });

    it("a liquidatable account can still reduce at fair terms, which improves its ratio", async () => {
      const f = await base();
      const { exchange, oracle, ctx, alice, dave } = f;
      await oracle.setPrice(BTC, wad(59_000));
      const ratio = async () => {
        const [, maintenance] = await exchange.marginRequirement(alice.address);
        return ((await exchange.accountValue(alice.address)) * 10n ** 18n) / BigInt(maintenance);
      };
      const before = await ratio();
      await ctx.settleOk([await ctx.trade(alice, dave, wad("0.36"), wad(59_000))]);
      expect(await ratio()).to.be.gt(before);
      // only the fee left her account: 2 bps of 21,240
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("1070.752"));
      // and she can close the rest at the index
      await ctx.settleOk([await ctx.trade(alice, dave, wad("0.64"), wad(59_000))]);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(0);
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("1063.2"));
    });

    it("an account above maintenance is not subject to the ratio rule", async () => {
      const f = await base();
      const { exchange, oracle, ctx, alice, dave } = f;
      await oracle.setPrice(BTC, wad(54_000)); // value 6,075 >= maintenance 5,400, below initial
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      await ctx.settleOk([await ctx.trade(alice, dave, wad("0.36"), wad(56_700))]);
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
    });
  });

  describe("P2: a market without a price no longer shields an account from liquidation", () => {
    /** bob additionally holds a dust ETH long; then the ETH price goes stale while BTC falls. */
    async function shielded() {
      const f = await base();
      const { oracle, ctx, bob, dave } = f;
      await ctx.settleOk([await ctx.trade(bob, dave, wad("0.01"), ETH_PRICE, { marketId: ETH })]);
      await time.increase(HOUR + 1);
      await oracle.setPrice(BTC, wad(44_000)); // BTC fresh, ETH stale
      return f;
    }

    it("the reviewer's scenario: the BTC long is liquidated while ETH is stale", async () => {
      const { exchange, alice, bob, liquidator } = await shielded();
      // the strict view still refuses to value the account ...
      await expect(exchange.isLiquidatable(bob.address)).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(ETH);
      // ... the per-market one answers
      expect(await exchange.isLiquidatableIn(bob.address, BTC)).to.equal(true);
      expect(await exchange.isLiquidatableIn(alice.address, BTC)).to.equal(false);
      expect(await exchange.isLiquidatableIn(liquidator.address, BTC)).to.equal(false); // no position

      await expect(exchange.connect(liquidator).liquidate(bob.address, BTC, MAX))
        .to.emit(exchange, "Liquidation")
        .withArgs(BTC, bob.address, liquidator.address, ONE, wad(44_000), usdc(660), 0);
      expect((await exchange.getPosition(bob.address, BTC)).size).to.equal(0);
      // 10,090 - 0.004 (ETH fee) - 6,000 - 660, less a good hour of capped BTC funding
      // (10 bps of 44,000 per hour) that the liquidation accrued and settled
      const balance = await exchange.balanceOf(bob.address);
      expect(balance).to.be.lt(usdc("3429.996") - usdc(44));
      expect(balance).to.be.gt(usdc("3429.996") - usdc(50));
      expect(await exchange.totalBadDebt()).to.equal(0);
      expect(await exchange.insuranceFund()).to.equal(usdc(330));
      // the dust position is untouched and the account is not written off
      expect((await exchange.getPosition(bob.address, ETH)).size).to.equal(wad("0.01"));
    });

    it("also when the other market's oracle call reverts", async () => {
      const { exchange, oracle, bob, liquidator } = await shielded();
      await oracle.setPriceAt(ETH, 0, await time.latest()); // getPrice(ETH) now reverts
      await expect(oracle.getPrice(ETH)).to.be.revertedWithCustomError(oracle, "PriceNotSet");
      await exchange.connect(liquidator).liquidate(bob.address, BTC, MAX);
      expect((await exchange.getPosition(bob.address, BTC)).size).to.equal(0);
    });

    it("the liquidated market itself still needs a fresh price", async () => {
      const { exchange, oracle, bob, liquidator } = await shielded();
      await expect(exchange.connect(liquidator).liquidate(bob.address, ETH, MAX)).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(ETH);
      await expect(exchange.isLiquidatableIn(bob.address, ETH)).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(ETH);
      await time.increase(HOUR + 1); // now BTC is stale too
      await expect(exchange.connect(liquidator).liquidate(bob.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(BTC);
      await oracle.setPrice(BTC, wad(44_000));
      await exchange.connect(liquidator).liquidate(bob.address, BTC, MAX);
    });

    it("a healthy account is still not liquidatable when a side market is stale", async () => {
      const { exchange, oracle, bob, liquidator } = await shielded();
      await oracle.setPrice(BTC, wad(46_000)); // value 6,090 vs maintenance 4,600 + 2
      expect(await exchange.isLiquidatableIn(bob.address, BTC)).to.equal(false);
      await expect(exchange.connect(liquidator).liquidate(bob.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
    });

    it("the liquidator's own margin check keeps requiring fresh prices", async () => {
      const { exchange, bob, dave } = await shielded();
      // dave is short the dust ETH (stale): he cannot take over a position
      await expect(exchange.connect(dave).liquidate(bob.address, BTC, wad("0.1"))).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(ETH);
    });

    it("documented trade-off: unrealized profit in the market without a price does not count", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, carol, dave, liquidator } = f;
      await exchange.connect(carol).deposit(usdc(15_000));
      await exchange.connect(dave).deposit(usdc(200_000));
      await exchange.connect(liquidator).deposit(usdc(200_000));
      await ctx.settleOk([
        await ctx.trade(carol, dave, ONE, BTC_PRICE),
        await ctx.trade(carol, dave, wad(10), ETH_PRICE, { marketId: ETH }),
      ]);
      await oracle.setPrice(ETH, wad(3_000)); // +10,000 unrealized for carol
      await oracle.setPrice(BTC, wad(41_000)); // -9,000
      // at true prices she is healthy: 14,986 + 10,000 - 9,000 vs 4,100 + 3,000
      expect(await exchange.isLiquidatable(carol.address)).to.equal(false);
      expect(await exchange.isLiquidatableIn(carol.address, BTC)).to.equal(false);
      await expect(exchange.connect(liquidator).liquidate(carol.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");

      // the ETH price goes stale: ETH is valued at entry, 14,986 - 9,000 vs 4,100 + 2,000
      await time.increase(HOUR + 1);
      await oracle.setPrice(BTC, wad(41_000));
      expect(await exchange.isLiquidatableIn(carol.address, BTC)).to.equal(true);
      await exchange.connect(liquidator).liquidate(carol.address, BTC, MAX);
      expect((await exchange.getPosition(carol.address, BTC)).size).to.equal(0);
      // she keeps the ETH position and its profit
      await oracle.setPrice(ETH, wad(3_000));
      // 14,986 - 9,000 - 615 (penalty) + 10,000, less a good hour of BTC funding (41 per hour)
      const value = await exchange.accountValue(carol.address);
      expect(value).to.be.gt(usdc(15_371) - usdc(47));
      expect(value).to.be.lt(usdc(15_371) - usdc(41));
    });
  });

  describe("P3: parameter constraint on the short side", () => {
    it("rejects band 500 + fee 99 against maintenance 600 (the fee is charged on up to 105% of the notional)", async () => {
      const { exchange } = await base();
      const cfg = (maintenanceMarginBps: number) => marketConfig("BTC-USD", { maintenanceMarginBps, makerFeeBps: 99, takerFeeBps: 99 });
      await expect(exchange.updateMarket(BTC, cfg(600))).to.be.revertedWithCustomError(exchange, "InvalidMarketConfig");
      // 500 + 99 * 1.05 = 603.95
      await expect(exchange.updateMarket(BTC, cfg(603))).to.be.revertedWithCustomError(exchange, "InvalidMarketConfig");
      await exchange.updateMarket(BTC, cfg(604));
    });

    it("with the tightest accepted parameters a short's reducing fill at the band edge does not lower health", async () => {
      const f = await base();
      const { exchange, oracle, ctx, alice, dave } = f;
      await exchange.updateMarket(BTC, marketConfig("BTC-USD", { maintenanceMarginBps: 604, makerFeeBps: 99, takerFeeBps: 99 }));
      await oracle.setPrice(BTC, wad(56_000)); // under initial, above maintenance
      const health = async () => {
        const [, maintenance] = await exchange.marginRequirement(alice.address);
        return (await exchange.accountValue(alice.address)) - BigInt(maintenance);
      };
      const before = await health();
      expect(await ctx.settleError(await ctx.trade(alice, dave, wad("0.5"), wad(58_800)))).to.equal("");
      expect(await health()).to.be.gte(before);
    });
  });

  describe("P4: bulk cancel cannot brick an account", () => {
    it("cancelAllOrders(max) is refused and the account keeps trading", async () => {
      const f = await base();
      const { exchange, ctx, alice, dave } = f;
      await expect(exchange.connect(alice).cancelAllOrders(MAX)).to.be.revertedWithCustomError(exchange, "NonceTooHigh");
      await expect(exchange.connect(alice).cancelAllOrders(MAX - 1n)).to.be.revertedWithCustomError(exchange, "NonceTooHigh");
      await expect(exchange.connect(alice).cancelAllOrders(1n << 200n)).to.be.revertedWithCustomError(exchange, "NonceTooHigh");
      expect(await exchange.minValidNonce(alice.address)).to.equal(0);
      const buy = ctx.order(alice, true, ONE, BTC_PRICE, { reduceOnly: true });
      expect(await ctx.settleError(await ctx.match(alice, buy, dave, ctx.order(dave, false, ONE, BTC_PRICE), ONE))).to.equal("");
      await exchange.connect(alice).withdraw(usdc(5_000));
    });
  });

  describe("funding is accrued in every market the accounts are exposed to", () => {
    async function twoMarkets() {
      const f = await loadFixture(deployFixture);
      const { exchange, ctx, alice, bob, carol, liquidator } = f;
      for (const s of [alice, bob, carol, liquidator]) await exchange.connect(s).deposit(usdc(100_000));
      // both opened 1% above the index: funding at the cap in both markets
      await ctx.settleOk([
        await ctx.trade(alice, bob, ONE, wad(50_500)),
        await ctx.trade(alice, bob, wad(10), wad(2_020), { marketId: ETH }),
      ]);
      const t0 = Number(await exchange.lastFundingTime(ETH));
      await time.increase(2 * HOUR);
      await f.oracle.setPrice(BTC, BTC_PRICE);
      await f.oracle.setPrice(ETH, ETH_PRICE);
      return { ...f, t0 };
    }

    it("a BTC fill accrues ETH funding for an account that holds ETH", async () => {
      const { exchange, ctx, alice, carol } = await twoMarkets();
      expect(await exchange.cumulativeFunding(ETH)).to.equal(0);
      const tx = await ctx.settle([await ctx.trade(carol, alice, wad("0.5"), BTC_PRICE)]);
      const receipt = (await tx.wait())!;
      expect(ctx.failures(receipt)).to.deep.equal([]);
      const accrued = receipt.logs
        .map((l) => exchange.interface.parseLog(l))
        .filter((l) => l?.name === "FundingUpdated")
        .map((l) => Number(l!.args.marketId));
      expect(accrued.sort()).to.deep.equal([BTC, ETH]);
      expect(await exchange.cumulativeFunding(ETH)).to.be.gt(0);
      expect(await exchange.cumulativeFunding(BTC)).to.be.gt(0);
    });

    it("a fill between accounts without ETH exposure leaves ETH alone", async () => {
      const { exchange, ctx, carol, liquidator } = await twoMarkets();
      await ctx.settleOk([await ctx.trade(carol, liquidator, wad("0.5"), BTC_PRICE)]);
      expect(await exchange.cumulativeFunding(ETH)).to.equal(0);
      expect(await exchange.cumulativeFunding(BTC)).to.be.gt(0);
    });

    it("the margin check of a fill sees funding that was due in the other market", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob } = f;
      await exchange.connect(alice).deposit(usdc(5_000));
      await exchange.connect(bob).deposit(usdc(100_000));
      // 10 ETH long, 1% above the index: needs 4,000 initial margin, value ~4,796
      await ctx.settleOk([await ctx.trade(alice, bob, wad(10), wad(2_020), { marketId: ETH })]);
      await time.increase(8 * HOUR);
      await oracle.setPrice(BTC, BTC_PRICE);
      await oracle.setPrice(ETH, ETH_PRICE);
      // 8h at 10 bps on 20,000 = 160 of funding are due but not accrued: the view still
      // shows 795.96 free, enough for 0.07 BTC (700 margin + fee) ...
      expect(await exchange.freeCollateral(alice.address)).to.equal(usdc("795.96"));
      // ... but the fill accrues ETH funding first, and 635.96 is not enough
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad("0.07"), BTC_PRICE))).to.equal("InsufficientMargin");
      expect(await exchange.cumulativeFunding(ETH)).to.equal(0); // the failed match left no trace
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad("0.06"), BTC_PRICE))).to.equal("");
      expect(await exchange.cumulativeFunding(ETH)).to.equal(wad(16));
    });

    it("a liquidation accrues the other markets of both accounts", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(15_000));
      await exchange.connect(bob).deposit(usdc(100_000));
      await exchange.connect(liquidator).deposit(usdc(100_000));
      await ctx.settleOk([
        await ctx.trade(alice, bob, ONE, BTC_PRICE),
        await ctx.trade(alice, bob, wad(10), wad(2_020), { marketId: ETH }),
      ]);
      await time.increase(8 * HOUR);
      await oracle.setPrice(ETH, ETH_PRICE);
      // balance 14,985.96; ETH -200; BTC at 42,000: -8,000 -> 6,785.96 vs maintenance 4,200 + 2,000.
      // Healthy before the 160 of ETH funding that is due ...
      await oracle.setPrice(BTC, wad(41_400)); // -8,600 -> 6,185.96 vs 6,140: still healthy without funding
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      // ... but liquidate() accrues it first: 6,025.96 < 6,140
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX)).to.emit(exchange, "Liquidation");
      expect(await exchange.cumulativeFunding(ETH)).to.equal(wad(16));
    });
  });
});
