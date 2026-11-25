// Regression tests for the findings of the third external review (F1, F1b, F2, F3 are the
// reviewer's scenarios; the assertions state that the bad outcome no longer happens).
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { BTC, BTC_PRICE, ETH, ETH_PRICE, HOUR, MAX_PRICE_AGE, deployFixture, marketConfig, startNewFundingPeriodAtNextFill, usdc, wad } from "./helpers";

const ONE = wad(1);
const MAX = ethers.MaxUint256;
const CAP = 10n ** 15n; // 10 bps per hour, WAD

describe("Review 3 regressions", () => {
  describe("F1: index drift is not a premium", () => {
    it("fills at exactly the index all hour while the index drifts 0.3%: no funding", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol, dave } = f;
      for (const s of [alice, bob, carol, dave]) await exchange.connect(s).deposit(usdc(100_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]);
      // start a clean period
      await time.increase(HOUR);
      await oracle.setPrice(BTC, BTC_PRICE);
      await oracle.setPrice(ETH, ETH_PRICE);
      await exchange.updateFunding(BTC);
      const t0 = Number(await exchange.lastFundingTime(BTC));
      const cum0 = await exchange.cumulativeFunding(BTC);

      // every 5 minutes: the index moves up 0.025% and carol/dave trade the minimum size AT the index
      let index = BTC_PRICE;
      for (let i = 1; i <= 11; i++) {
        index = (BTC_PRICE * BigInt(100_000 + 25 * i)) / 100_000n;
        await time.setNextBlockTimestamp(t0 + i * 300 - 1);
        await oracle.setPrice(BTC, index);
        await time.setNextBlockTimestamp(t0 + i * 300);
        const buyerIsCarol = i % 2 === 1;
        await ctx.settleOk([await ctx.trade(buyerIsCarol ? carol : dave, buyerIsCarol ? dave : carol, wad("0.001"), index)]);
      }
      index = (BTC_PRICE * 100_300n) / 100_000n; // +0.3% over the hour
      await time.setNextBlockTimestamp(t0 + HOUR - 1);
      await oracle.setPrice(BTC, index);
      expect(await exchange.currentFundingRate(BTC)).to.equal(0);
      expect(await exchange.markTwap(BTC)).to.equal(index);
      await time.setNextBlockTimestamp(t0 + HOUR);
      await expect(exchange.updateFunding(BTC)).to.emit(exchange, "FundingUpdated").withArgs(BTC, 0, cum0, t0 + HOUR);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(cum0);
    });

    it("F1b: a position opened at the index 2s before the accrual collects nothing", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol, dave } = f;
      for (const s of [alice, bob, carol, dave]) await exchange.connect(s).deposit(usdc(100_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]);
      await time.increase(HOUR);
      await oracle.setPrice(BTC, BTC_PRICE);
      await exchange.updateFunding(BTC);
      const t0 = Number(await exchange.lastFundingTime(BTC));
      // one honest fill at the index early in the hour
      await time.setNextBlockTimestamp(t0 + 60);
      await ctx.settleOk([await ctx.trade(alice, bob, wad("0.001"), BTC_PRICE)]);
      // index +0.5% by the end of the hour; the sniper buys 1 BTC at the index 2s before
      const index = wad(50_250);
      await time.setNextBlockTimestamp(t0 + HOUR - 3);
      await oracle.setPrice(BTC, index);
      await time.setNextBlockTimestamp(t0 + HOUR - 2);
      await ctx.settleOk([await ctx.trade(carol, dave, ONE, index, { makerIsSeller: true })]);
      const carolBefore = await exchange.accountValue(carol.address);
      const daveBefore = await exchange.accountValue(dave.address);
      await time.setNextBlockTimestamp(t0 + HOUR);
      await exchange.connect(carol).updateFunding(BTC);
      expect((await exchange.accountValue(carol.address)) - carolBefore).to.equal(0);
      expect((await exchange.accountValue(dave.address)) - daveBefore).to.equal(0);
    });

    it("a real premium is still charged while the index drifts", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, carol, dave } = f;
      for (const s of [carol, dave]) await exchange.connect(s).deposit(usdc(100_000));
      await startNewFundingPeriodAtNextFill(f);
      // the opening fill starts the period, 4 bps above the index of the moment
      await ctx.settleOk([await ctx.trade(carol, dave, wad("0.01"), wad(50_020))]);
      const t0 = Number(await exchange.lastFundingTime(BTC));
      for (let i = 1; i <= 5; i++) {
        const index = (BTC_PRICE * BigInt(1_000 + i)) / 1_000n; // +0.1% every 10 minutes
        await time.setNextBlockTimestamp(t0 + i * 600 - 1);
        await oracle.setPrice(BTC, index);
        await time.setNextBlockTimestamp(t0 + i * 600);
        await ctx.settleOk([await ctx.trade(carol, dave, wad("0.01"), (index * 10_004n) / 10_000n)]);
      }
      const last = (BTC_PRICE * 1_005n) / 1_000n;
      await time.setNextBlockTimestamp(t0 + HOUR - 1);
      await oracle.setPrice(BTC, last);
      await time.setNextBlockTimestamp(t0 + HOUR);
      // 4 bps all hour, whatever the index did; paid on the index of the accrual
      await expect(exchange.updateFunding(BTC))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 4, (last * 4n) / 10_000n, t0 + HOUR);
    });
  });

  describe("F2: liquidation while another market has no price", () => {
    /** alice: long 1 BTC and long 10 ETH; ETH -30%, BTC -16%: true value 86, BTC penalty would be 630. */
    async function scenario(opts: { ethStale: boolean; ethSeenAt1400?: boolean }) {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol, dave, liquidator, stranger } = f;
      await exchange.connect(bob).deposit(usdc(1_000));
      await exchange.connect(carol).deposit(usdc(1_000));
      await exchange.connect(alice).deposit(usdc(14_100));
      await exchange.connect(dave).deposit(usdc(500_000));
      await exchange.connect(liquidator).deposit(usdc(500_000));
      await exchange.connect(stranger).depositInsurance(usdc(10_000));
      await ctx.settleOk([await ctx.trade(alice, dave, ONE, BTC_PRICE), await ctx.trade(alice, dave, wad(10), ETH_PRICE, { marketId: ETH })]);
      await oracle.setPrice(ETH, wad(1_400));
      await oracle.setPrice(BTC, wad(42_000));
      if (opts.ethSeenAt1400) {
        // somebody trades ETH at the new price, so the exchange has seen it
        await ctx.settleOk([await ctx.trade(bob, carol, wad("0.01"), wad(1_400), { marketId: ETH })]);
      }
      const trueValue = await exchange.accountValue(alice.address);
      if (opts.ethStale) {
        await time.increase(HOUR + 1); // the ETH feed stops updating; BTC keeps updating
        await oracle.setPrice(BTC, wad(42_000));
      }
      const fundBefore = await exchange.insuranceFund();
      const liqBefore = await exchange.balanceOf(liquidator.address);
      const tx = await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      const ev = (await tx.wait())!.logs.map((l) => exchange.interface.parseLog(l)).find((l) => l?.name === "Liquidation")!;
      const penalty: bigint = ev.args.penalty;
      const liquidatorShare = (await exchange.balanceOf(liquidator.address)) - liqBefore;
      // the ETH feed is back at the same price; the rest is liquidated
      await oracle.setPrice(ETH, wad(1_400));
      await oracle.setPrice(BTC, wad(42_000));
      await exchange.connect(liquidator).liquidate(alice.address, ETH, MAX);
      return { trueValue, penalty, liquidatorShare, fundChange: (await exchange.insuranceFund()) - fundBefore, badDebt: await exchange.totalBadDebt() };
    }

    it("fresh prices: the penalty is capped at the true value and split as usual", async () => {
      const r = await scenario({ ethStale: false });
      expect(r.trueValue).to.equal(usdc(86));
      expect(r.penalty).to.equal(usdc(86));
      expect(r.liquidatorShare).to.equal(usdc(43));
      expect(r.fundChange).to.equal(usdc(43));
      expect(r.badDebt).to.equal(0);
    });

    it("the reviewer's scenario: the liquidator gets nothing and the fund does not lose", async () => {
      // ETH is stale and the exchange last saw it at 2,000 (alice's own fill), so the
      // account looks worth 6,086 and the full penalty of 630 is charged ...
      const r = await scenario({ ethStale: true });
      expect(r.trueValue).to.equal(usdc(86));
      expect(r.penalty).to.equal(usdc(630));
      // ... but none of it goes to the liquidator,
      expect(r.liquidatorShare).to.equal(0);
      // so after covering the deficit the penalty caused (544), the fund is up by exactly
      // what the account was really worth. Before: liquidator +315, fund -229.
      expect(r.fundChange).to.equal(usdc(86));
      expect(r.badDebt).to.equal(0);
    });

    it("if the exchange has seen the newer price, the stale market is valued at it", async () => {
      const r = await scenario({ ethStale: true, ethSeenAt1400: true });
      expect(r.trueValue).to.equal(usdc(86));
      expect(r.penalty).to.equal(usdc(86)); // capped at the value at the last good price
      expect(r.liquidatorShare).to.equal(0); // still no share: a price was missing
      expect(r.fundChange).to.equal(usdc(86));
      expect(r.badDebt).to.equal(0);
    });

    it("lastGoodPrice follows fills, accruals and liquidations, not views or failed calls", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, liquidator } = f;
      expect(await exchange.lastGoodPrice(BTC)).to.equal(0);
      await exchange.connect(alice).deposit(usdc(10_300));
      await exchange.connect(bob).deposit(usdc(50_000));
      await exchange.connect(liquidator).deposit(usdc(50_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(50_100))]);
      expect(await exchange.lastGoodPrice(BTC)).to.equal(BTC_PRICE); // the index, not the fill price
      expect(await exchange.lastGoodPrice(ETH)).to.equal(0);

      await oracle.setPrice(BTC, wad(49_000));
      await exchange.accountValue(alice.address); // a view stores nothing
      await exchange.updateFunding(BTC); // too early: no accrual, nothing stored
      expect(await exchange.lastGoodPrice(BTC)).to.equal(BTC_PRICE);
      await time.increase(HOUR);
      await oracle.setPrice(BTC, wad(49_000));
      await exchange.updateFunding(BTC);
      expect(await exchange.lastGoodPrice(BTC)).to.equal(wad(49_000));

      await oracle.setPrice(BTC, wad(44_000));
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect(await exchange.lastGoodPrice(BTC)).to.equal(wad(44_000));

      // a stale price is never stored
      await time.increase(HOUR + MAX_PRICE_AGE);
      await exchange.updateFunding(BTC);
      expect(await exchange.lastGoodPrice(BTC)).to.equal(wad(44_000));
    });

    it("a market the exchange never saw a price for is valued at entry", async () => {
      // not reachable through fills (a fill stores the index); covered here for a market
      // whose price disappears before anyone touches it again: lastGoodPrice stays what
      // the fill stored, which is the entry price in index terms.
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(10_600));
      await exchange.connect(bob).deposit(usdc(100_000));
      await exchange.connect(liquidator).deposit(usdc(100_000));
      await ctx.settleOk([
        await ctx.trade(alice, bob, ONE, BTC_PRICE),
        await ctx.trade(alice, bob, wad(1), wad(2_050), { marketId: ETH }), // 2.5% above the index
      ]);
      await oracle.setPriceAt(ETH, 0, await time.latest()); // the ETH oracle now reverts
      await oracle.setPrice(BTC, wad(44_000));
      // ETH is valued at 2,000 (last good index), i.e. with the 50 of loss against her entry
      // 10,600 - 10 - 0.41 - 6,000 - 50 = 4,539.59 < 4,400 + 200
      expect(await exchange.isLiquidatableIn(alice.address, BTC)).to.equal(true);
      await oracle.setPrice(BTC, wad(44_100)); // 4,639.59 >= 4,410 + 200
      expect(await exchange.isLiquidatableIn(alice.address, BTC)).to.equal(false);
    });
  });

  describe("F3: no funding while paused or inactive", () => {
    async function pausedFixture() {
      const f = await loadFixture(deployFixture);
      const { exchange, ctx, alice, bob, carol, dave, stranger } = f;
      for (const s of [alice, bob, carol, dave]) await exchange.connect(s).deposit(usdc(100_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]); // victims: alice long, bob short
      await ctx.settleOk([await ctx.trade(dave, carol, wad("0.1"), BTC_PRICE)]); // attacker pair: dave long, carol short
      await exchange.setGuardian(stranger.address);
      return f;
    }

    it("the reviewer's scenario: reducing fills at the band edge while paused move no funding", async () => {
      const f = await pausedFixture();
      const { exchange, oracle, ctx, alice, bob, carol, dave, stranger } = f;
      await exchange.connect(stranger).setPaused(true);
      const aliceStart = await exchange.accountValue(alice.address);
      const cum0 = await exchange.cumulativeFunding(BTC);
      for (let h = 0; h < 5; h++) {
        await time.increase(HOUR);
        await oracle.setPrice(BTC, BTC_PRICE);
        // dave sells 0.001 to carol at the top of the band: both reduce, allowed while paused
        expect(await ctx.settleError(await ctx.trade(carol, dave, wad("0.001"), wad(52_500)))).to.equal("");
        expect(await exchange.currentFundingRate(BTC)).to.equal(0);
        expect(await exchange.markTwap(BTC)).to.equal(BTC_PRICE); // the fill is not an observation
        expect(await exchange.markPrice(BTC)).to.equal(wad(52_500)); // but it is the last fill
      }
      await time.increase(HOUR);
      await oracle.setPrice(BTC, BTC_PRICE);
      await expect(exchange.updateFunding(BTC)).to.emit(exchange, "FundingUpdated");
      expect(await exchange.cumulativeFunding(BTC)).to.equal(cum0);
      expect(await exchange.accountValue(alice.address)).to.equal(aliceStart);
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad("0.01"), BTC_PRICE))).to.equal("OnlyReducingAllowed");
    });

    it("funding earned before the pause is charged at the pause; the paused time and what was recorded before it are not carried over", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob } = f;
      for (const s of [alice, bob]) await exchange.connect(s).deposit(usdc(100_000));
      await startNewFundingPeriodAtNextFill(f);
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(50_500))]); // +1%: at the cap
      const t0 = Number(await exchange.lastFundingTime(BTC));

      // paused after 30 minutes: both markets' periods are closed, BTC for half an hour at the cap
      await time.setNextBlockTimestamp(t0 + 1_800);
      const pauseTx = await exchange.setPaused(true);
      await expect(pauseTx).to.emit(exchange, "FundingUpdated").withArgs(BTC, 10, wad(25), t0 + 1_800);
      await expect(pauseTx).to.emit(exchange, "FundingUpdated").withArgs(ETH, 0, 0, t0 + 1_800);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad(25));
      // pausing again changes nothing
      await expect(exchange.setPaused(true)).to.not.emit(exchange, "FundingUpdated");

      // three hours paused: accruals happen, at zero
      await time.setNextBlockTimestamp(t0 + 1_800 + 3 * HOUR - 1);
      await oracle.setPrice(BTC, BTC_PRICE);
      await time.setNextBlockTimestamp(t0 + 1_800 + 3 * HOUR);
      await expect(exchange.updateFunding(BTC)).to.emit(exchange, "FundingUpdated").withArgs(BTC, 0, wad(25), t0 + 1_800 + 3 * HOUR);

      // unpaused 10 minutes later: the running period is closed at zero and a fresh one starts
      await time.setNextBlockTimestamp(t0 + 1_800 + 3 * HOUR + 600);
      await expect(exchange.setPaused(false)).to.emit(exchange, "FundingUpdated").withArgs(BTC, 0, wad(25), t0 + 1_800 + 3 * HOUR + 600);
      const t1 = t0 + 1_800 + 3 * HOUR + 600;
      expect(await exchange.lastFundingTime(BTC)).to.equal(t1);
      // an hour later, with no new fill: nothing, the old premium is gone
      await time.setNextBlockTimestamp(t1 + HOUR - 1);
      await oracle.setPrice(BTC, BTC_PRICE);
      await time.setNextBlockTimestamp(t1 + HOUR);
      await exchange.updateFunding(BTC);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad(25));
      // funding works again with new fills
      const m = await ctx.trade(alice, bob, wad("0.01"), wad(50_500));
      await time.setNextBlockTimestamp(t1 + HOUR + 1);
      await ctx.settleOk([m]);
      await time.setNextBlockTimestamp(t1 + 2 * HOUR - 1);
      await oracle.setPrice(BTC, BTC_PRICE);
      await time.setNextBlockTimestamp(t1 + 2 * HOUR);
      await exchange.updateFunding(BTC);
      expect(await exchange.cumulativeFunding(BTC)).to.be.closeTo(wad(75), wad("0.05"));
    });

    it("an inactive market accrues nothing either, and its fills are not observations", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob } = f;
      for (const s of [alice, bob]) await exchange.connect(s).deposit(usdc(100_000));
      await startNewFundingPeriodAtNextFill(f);
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(50_500))]);
      const t0 = Number(await exchange.lastFundingTime(BTC));

      // deactivated after 15 minutes: the period so far is charged (cap * 900s)
      await time.setNextBlockTimestamp(t0 + 900);
      await expect(exchange.updateMarket(BTC, marketConfig("BTC-USD", { active: false })))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 10, wad("12.5"), t0 + 900);
      // an update that does not change `active` closes nothing
      await expect(exchange.updateMarket(BTC, marketConfig("BTC-USD", { active: false, takerFeeBps: 6 }))).to.not.emit(exchange, "FundingUpdated");

      // reducing fills at the band edge while inactive
      await time.setNextBlockTimestamp(t0 + 900 + HOUR - 1);
      await oracle.setPrice(BTC, BTC_PRICE);
      const m = await ctx.trade(alice, bob, wad("0.1"), wad(52_500), { makerIsSeller: true });
      void m;
      const reduce = await ctx.trade(bob, alice, wad("0.1"), wad(52_500));
      await time.setNextBlockTimestamp(t0 + 900 + HOUR);
      await ctx.settleOk([reduce]);
      expect(await exchange.currentFundingRate(BTC)).to.equal(0);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad("12.5"));
      // the other market is unaffected by BTC being inactive
      expect(await exchange.cumulativeFunding(ETH)).to.equal(0);

      // reactivated: period restarts at zero
      await time.setNextBlockTimestamp(t0 + 900 + HOUR + 600);
      await expect(exchange.updateMarket(BTC, marketConfig("BTC-USD")))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 0, wad("12.5"), t0 + 900 + HOUR + 600);
      expect(await exchange.lastFundingTime(BTC)).to.equal(t0 + 900 + HOUR + 600);
    });
  });

  describe("F5: a stale last trade does not keep a premium alive", () => {
    it("a stale-index accrual discards a period that had fills", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob } = f;
      for (const s of [alice, bob]) await exchange.connect(s).deposit(usdc(100_000));
      await startNewFundingPeriodAtNextFill(f);
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(50_500))]);
      const t0 = Number(await exchange.lastFundingTime(BTC));
      // the oracle goes quiet; someone accrues with a stale index: rate 0, period over
      await time.setNextBlockTimestamp(t0 + MAX_PRICE_AGE + 100);
      await expect(exchange.updateFunding(BTC)).to.emit(exchange, "FundingUpdated").withArgs(BTC, 0, 0, t0 + MAX_PRICE_AGE + 100);
      // the feed returns: the discarded period's premium does not come back
      await time.setNextBlockTimestamp(t0 + 2 * MAX_PRICE_AGE + 199);
      await oracle.setPrice(BTC, BTC_PRICE);
      expect(await exchange.currentFundingRate(BTC)).to.equal(0);
      await time.setNextBlockTimestamp(t0 + 2 * MAX_PRICE_AGE + 200);
      await exchange.updateFunding(BTC);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(0);
    });

    it("eight hours without an accrual after one fill at the cap cost one hour, not eight", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob } = f;
      for (const s of [alice, bob]) await exchange.connect(s).deposit(usdc(100_000));
      await startNewFundingPeriodAtNextFill(f);
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(52_500))]);
      const t0 = Number(await exchange.lastFundingTime(BTC));
      const before = await exchange.accountValue(alice.address);
      await time.setNextBlockTimestamp(t0 + 8 * HOUR - 1);
      await oracle.setPrice(BTC, BTC_PRICE);
      expect(await exchange.currentFundingRate(BTC)).to.equal((CAP * 3_600n) / (8n * 3_600n - 1n));
      await time.setNextBlockTimestamp(t0 + 8 * HOUR);
      await exchange.updateFunding(BTC);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad(50)); // was 400
      // alice's long: entry 52,500 vs index 50,000 is unchanged; she paid 50 of funding
      expect(before - (await exchange.accountValue(alice.address))).to.equal(usdc(50));
    });
  });

  describe("F6: penalties repay recorded bad debt before they reach the fund", () => {
    it("the fund's share of a penalty goes against bad debt first", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol, liquidator, token, feeRecipient } = f;
      await exchange.connect(alice).deposit(usdc(10_100));
      await exchange.connect(carol).deposit(usdc(12_100));
      await exchange.connect(bob).deposit(usdc(80_000));
      await exchange.connect(liquidator).deposit(usdc(200_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE), await ctx.trade(carol, bob, ONE, BTC_PRICE)]);
      await oracle.setPrice(BTC, wad(38_000));
      // alice: 10,090 - 12,000 -> 1,910 of bad debt, fund empty
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect(await exchange.totalBadDebt()).to.equal(usdc(1_910));
      expect(await exchange.insuranceFund()).to.equal(0);
      // carol: 12,090 - 12,000 = 90 < maintenance: penalty capped at 90, 45 for the fund
      await exchange.connect(liquidator).liquidate(carol.address, BTC, MAX);
      expect(await exchange.totalBadDebt()).to.equal(usdc(1_865)); // 1,910 - 45
      expect(await exchange.insuranceFund()).to.equal(0); // not 45 next to a shortfall

      // the books still describe the real shortfall exactly
      let claims = await exchange.insuranceFund();
      for (const s of [alice, bob, carol, liquidator, feeRecipient]) claims += await exchange.accountValue(s.address);
      expect(claims - (await token.balanceOf(await exchange.getAddress()))).to.equal(usdc(1_865));
    });
  });
});
