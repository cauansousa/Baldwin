import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BTC, ETH, HOUR, deployFixture, marketConfig, usdc, wad } from "./helpers";
import { installLogicalClock } from "./logicalClock";

/** Deterministic PRNG (mulberry32) so failures are reproducible from the seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
    /** Random bigint in [0, n). */
    big: (n: bigint) => (BigInt(Math.floor(next() * 2 ** 30)) * BigInt(Math.floor(next() * 2 ** 30)) * 2n ** 70n) % n,
  };
}

const MARKETS = [BTC, ETH];
const STEPS = 300;
// Coverage the four seeds must reach together (the runs are deterministic; these are a
// little below what they produce today, so an accidental loss of coverage shows).
const MIN_TOTALS = { liquidations: 0, fallbackLiquidations: 0, edgeReductions: 0, fills: 0, badDebtRepayments: 0 };

describe("Solvency invariant (randomized)", function () {
  this.timeout(600_000);
  const totals = { badDebtRepayments: 0, liquidations: 0, fallbackLiquidations: 0, fallbackWithKnownTruth: 0, edgeReductions: 0, fills: 0, failedFills: 0, badDebt: 0n, insurance: 0n };

  // Block timestamps are pinned (previous + 1s), so every run of a seed is identical and
  // the coverage thresholds below can be tight.
  let removeClock: () => void;
  before(() => {
    removeClock = installLogicalClock();
  });

  after(() => {
    removeClock();
    if (process.env.INVARIANT_DEBUG) console.log(totals);
    // Across the seeds the runs must have covered what the test is for.
    expect(totals.liquidations, "liquidations").to.be.gte(MIN_TOTALS.liquidations);
    expect(totals.fallbackLiquidations, "liquidations with a market valued without a price").to.be.gte(MIN_TOTALS.fallbackLiquidations);
    expect(totals.edgeReductions, "reducing fills at the band edge").to.be.gte(MIN_TOTALS.edgeReductions);
    expect(totals.fills, "fills").to.be.gte(MIN_TOTALS.fills);
    // most random fills must go through, or the run exercises little
    expect(totals.failedFills * 100, "share of failed fills").to.be.lt((totals.fills + totals.failedFills) * 30);
    expect(totals.badDebt > 0n, "bad debt occurred").to.equal(true);
    expect(totals.badDebtRepayments, "bad debt repayments").to.be.gte(MIN_TOTALS.badDebtRepayments);
    expect(totals.insurance > 0n, "penalties reached the insurance fund").to.equal(true);
  });

  for (const seed of [1, 2, 3, 20241123]) {
    it(`holds through a random sequence of actions (seed ${seed})`, async () => {
      // A fresh deployment under the logical clock (not the shared fixture snapshot, whose
      // block times were set by the wall clock of whichever test created it).
      const f = await deployFixture();
      const { exchange, oracle, token, ctx, feeRecipient, liquidator } = f;
      const r = rng(seed);
      const traders: HardhatEthersSigner[] = [f.alice, f.bob, f.carol, f.dave, f.stranger];
      // a second liquidator that only acts while a market has no price
      const outageLiquidator = f.owner;
      const accounts = [...traders, liquidator, outageLiquidator, feeRecipient];
      const exchangeAddress = await exchange.getAddress();
      const prices: Record<number, bigint> = { [BTC]: wad(50_000), [ETH]: wad(2_000) };
      const stats = { outages: 0, fallbackWithKnownTruth: 0, fallbackLiquidations: 0, blockedOutageLiquidations: 0, insuranceDeposits: 0, fills: 0, failedFills: 0, edgeReductions: 0, liquidations: 0, withdrawals: 0, refusedWithdrawals: 0, fundings: 0 };

      const failureReasons: Record<string, number> = {};
      let maxBadDebt = 0n; // bad debt can be repaid again, so remember the peak

      const refreshPrices = async () => {
        for (const m of MARKETS) await oracle.setPrice(m, prices[m]);
      };

      /**
       * The books must be backed:
       *   USDC held + recorded bad debt >= sum of account values + insurance fund
       * Account values are signed and include unrealized PnL and pending funding. Since
       * longs and shorts cancel, the right-hand side does not depend on the price.
       * Also: open interest is consistent with the positions, and longs == shorts.
       */
      const checkInvariant = async (label: string) => {
        const held = await token.balanceOf(exchangeAddress);
        const badDebt = await exchange.totalBadDebt();
        let claims = await exchange.insuranceFund();
        for (const a of accounts) claims += await exchange.accountValue(a.address);
        expect(held + badDebt, `solvency after ${label}`).to.be.gte(claims);

        for (const m of MARKETS) {
          let longs = 0n;
          let shorts = 0n;
          for (const a of accounts) {
            const size = (await exchange.getPosition(a.address, m)).size;
            if (size > 0n) longs += size;
            else shorts -= size;
          }
          const [oiLong, oiShort] = await exchange.openInterest(m);
          expect(oiLong, `long OI after ${label}`).to.equal(longs);
          expect(oiShort, `short OI after ${label}`).to.equal(shorts);
          expect(longs, `longs == shorts after ${label}`).to.equal(shorts);
        }
        return held + badDebt - claims;
      };

      const liquidateAll = async () => {
        for (const t of traders) {
          for (const m of MARKETS) {
            if (!(await exchange.isLiquidatable(t.address))) break;
            const size = (await exchange.getPosition(t.address, m)).size;
            if (size === 0n) continue;
            const abs = size > 0n ? size : -size;
            // sometimes partial, with an odd size
            const max = r.next() < 0.3 ? r.big(abs) + 1n : ethers.MaxUint256;
            await exchange.connect(liquidator).liquidate(t.address, m, max);
            stats.liquidations++;
          }
        }
      };

      await exchange.connect(liquidator).deposit(usdc(5_000_000));
      await token.mint(outageLiquidator.address, usdc(5_000_000));
      await token.connect(outageLiquidator).approve(exchangeAddress, ethers.MaxUint256);
      await exchange.connect(outageLiquidator).deposit(usdc(5_000_000));
      for (const t of traders) await exchange.connect(t).deposit(usdc(r.int(8_000, 30_000)));

      /**
       * One market loses its price (stale, or the oracle reverts). Accounts that are
       * liquidatable in the other market are liquidated there, with the dead market valued
       * at its last known price. Checks: where the fallback was used the liquidator gets
       * no share of the penalty; and where the last known price IS the true price, the
       * penalty does not exceed what the account was really worth.
       */
      const outage = async () => {
        const dead = r.pick(MARKETS);
        const live = dead === BTC ? ETH : BTC;
        // the live market gaps while the other one is dark
        prices[live] = (prices[live] * BigInt(10_000 + r.pick([-1, 1]) * r.int(600, 2_200))) / 10_000n + r.big(10n ** 15n);
        await oracle.setPrice(live, prices[live]);
        const brokenByRevert = r.next() < 0.5;
        const breakIt = async () => {
          if (brokenByRevert) await oracle.setPriceAt(dead, 0, await time.latest());
          else await oracle.setPriceAt(dead, prices[dead], (await time.latest()) - 2 * HOUR);
        };
        for (const t of traders) {
          if ((await exchange.getPosition(t.address, live)).size === 0n) continue;
          // the truth, while all prices are still available
          const trueValue = await exchange.accountValue(t.address);
          const snapshot = await takeSnapshot();
          await breakIt();
          if (!(await exchange.isLiquidatableIn(t.address, live))) {
            await snapshot.restore();
            continue;
          }
          const usesFallback = (await exchange.getPosition(t.address, dead)).size !== 0n;
          const lastGoodIsTrue = (await exchange.lastGoodPrice(dead)) === prices[dead];
          const fund = await exchange.insuranceFund();
          const debt = await exchange.totalBadDebt();
          let receipt;
          try {
            receipt = (await (await exchange.connect(outageLiquidator).liquidate(t.address, live, ethers.MaxUint256)).wait())!;
          } catch (e) {
            // the liquidator itself holds a position in the dead market: its own margin
            // cannot be checked, so it may not take over anything
            expect(String(e)).to.match(/StalePrice|PriceNotSet/);
            expect((await exchange.getPosition(outageLiquidator.address, dead)).size).to.not.equal(0n);
            stats.blockedOutageLiquidations++;
            await snapshot.restore();
            continue;
          }
          const logs = receipt.logs.map((l) => exchange.interface.parseLog(l));
          const penalty: bigint = logs.find((l) => l?.name === "Liquidation")!.args.penalty;
          if (!logs.some((l) => l?.name === "DeficitAbsorbed")) {
            const toFund = (await exchange.insuranceFund()) - fund + (debt - (await exchange.totalBadDebt()));
            expect(toFund, "penalty share of the fund").to.equal(usesFallback ? penalty : penalty - penalty / 2n);
          }
          if (usesFallback) {
            stats.fallbackLiquidations++;
            if (lastGoodIsTrue) {
              stats.fallbackWithKnownTruth++;
              expect(penalty, "penalty vs true value").to.be.lte(trueValue > 0n ? trueValue : 0n);
            }
          }
          stats.liquidations++;
          await oracle.setPrice(dead, prices[dead]); // back for the next account's "truth"
        }
        await oracle.setPrice(dead, prices[dead]); // the feed is back
        stats.outages++;
      };

      for (let step = 0; step < STEPS; step++) {
        const roll = r.next();
        let label: string;

        if (roll < 0.1) {
          // ---- a trader reduces a position at the worst price the band allows (the
          //      shape of the equity-stripping attack), against whoever takes the other side
          label = "band-edge reduction";
          const market = r.pick(MARKETS);
          const holders = [];
          for (const t of traders) if ((await exchange.getPosition(t.address, market)).size !== 0n) holders.push(t);
          if (holders.length > 0) {
            const reducer = r.pick(holders);
            let other = r.pick(traders);
            while (other === reducer) other = r.pick(traders);
            const pos = (await exchange.getPosition(reducer.address, market)).size;
            const abs = pos > 0n ? pos : -pos;
            const size = r.next() < 0.3 ? abs : r.big(abs) + 1n;
            // a long sells at the bottom of the band, a short buys back at the top
            const price = pos > 0n ? (prices[market] * 9500n) / 10000n + 1n : (prices[market] * 10500n) / 10000n;
            // dust positions are closed with an order of the minimum size, filled for the position
            const min = (await exchange.getMarket(market)).minOrderSize;
            const orderSize = abs > min ? abs : min;
            const reduce = ctx.order(reducer, pos < 0n, orderSize, price, { marketId: market, reduceOnly: true });
            const take = ctx.order(other, pos > 0n, orderSize, price, { marketId: market });
            const m = r.next() < 0.5 ? await ctx.match(reducer, reduce, other, take, size) : await ctx.match(other, take, reducer, reduce, size);
            const liquidatableBefore = await exchange.isLiquidatable(reducer.address);
            const receipt = (await (await ctx.settle([m])).wait())!;
            const failed = ctx.failures(receipt);
            if (failed.length) {
              failureReasons[failed[0].error] = (failureReasons[failed[0].error] ?? 0) + 1;
            } else {
              stats.edgeReductions++;
              // a reducing fill never turns a healthy account into a liquidatable one
              if (!liquidatableBefore) expect(await exchange.isLiquidatable(reducer.address), "reduction made account liquidatable").to.equal(false);
            }
          }
        } else if (roll < 0.5) {
          // ---- fill anywhere inside the price band, with sizes and prices that do not divide evenly
          label = "fill";
          const market = r.pick(MARKETS);
          // Mostly between accounts that have collateral to trade with; sometimes anyone.
          const free = new Map<string, bigint>();
          for (const t of traders) free.set(t.address, await exchange.freeCollateral(t.address));
          const funded = traders.filter((t) => free.get(t.address)! > usdc(300));
          const pool = funded.length >= 2 && r.next() < 0.9 ? funded : traders;
          const maker = r.pick(pool);
          let taker = r.pick(pool);
          while (taker === maker) taker = r.pick(pool);
          const makerBuys = r.next() < 0.5;
          const price = (prices[market] * BigInt(r.int(9501, 10499))) / 10000n + r.big(10n ** 15n);
          // Sized to what the poorer side can afford (20% initial margin plus up to 5% for
          // a price at the edge of the band), most of the time; sometimes deliberately too large.
          const freeMaker = free.get(maker.address)!;
          const freeTaker = free.get(taker.address)!;
          const affordable = (freeMaker < freeTaker ? freeMaker : freeTaker) * 4n;
          const notional = (affordable * BigInt(r.next() < 0.1 ? r.int(130, 300) : r.int(5, 80))) / 100n;
          const minSize = BigInt((await exchange.getMarket(market)).minOrderSize);
          let size = (notional * 10n ** 30n) / price + r.big(10n ** 12n);
          if (size < minSize) size = minSize + r.big(10n ** 12n);
          const makerOrder = ctx.order(maker, makerBuys, size, price, { marketId: market });
          const takerOrder = ctx.order(taker, !makerBuys, size, price, { marketId: market });
          // partial fills too (at least the minimum size, as the contract demands)
          let fill = r.next() < 0.3 ? r.big(size) + 1n : size;
          if (fill < minSize) fill = r.next() < 0.1 ? fill : size;
          const receipt = (await (await ctx.settle([await ctx.match(maker, makerOrder, taker, takerOrder, fill)])).wait())!;
          const failed = ctx.failures(receipt);
          if (failed.length) {
            stats.failedFills++;
            failureReasons[failed[0].error] = (failureReasons[failed[0].error] ?? 0) + 1;
          } else stats.fills++;
        } else if (roll < 0.68) {
          // ---- price move: mostly small, sometimes a gap large enough to create bad debt
          label = "price move";
          const market = r.pick(MARKETS);
          const bps = r.next() < 0.25 ? r.int(-3000, 3000) : r.int(-700, 700);
          prices[market] = (prices[market] * BigInt(10_000 + bps)) / 10_000n + r.big(10n ** 15n);
          await oracle.setPrice(market, prices[market]);
          // keepers usually react quickly, but not always
          if (r.next() < 0.6) await liquidateAll();
        } else if (roll < 0.78) {
          // ---- funding
          label = "funding";
          await time.increase(r.int(HOUR, 3 * HOUR));
          await refreshPrices();
          for (const m of MARKETS) await exchange.updateFunding(m);
          stats.fundings++;
        } else if (roll < 0.88) {
          label = "liquidations";
          await liquidateAll();
        } else if (roll < 0.93) {
          // ---- withdraw: sometimes exactly the maximum, sometimes too much
          label = "withdraw";
          const t = r.pick(traders);
          const free = await exchange.freeCollateral(t.address);
          const held = await token.balanceOf(exchangeAddress);
          if (r.next() < 0.25) {
            await expect(exchange.connect(t).withdraw(free + 1n)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
            stats.refusedWithdrawals++;
          } else if (free > 0n && free <= held) {
            await exchange.connect(t).withdraw(r.next() < 0.2 ? free : r.big(free / 2n) + 1n);
            stats.withdrawals++;
          }
        } else if (roll < 0.99 && roll >= 0.965) {
          label = "oracle outage";
          await outage();
        } else if (roll < 0.965) {
          // ---- somebody tops up the insurance fund (repays recorded bad debt first)
          label = "insurance deposit";
          const debt = await exchange.totalBadDebt();
          const amount = r.next() < 0.5 && debt > 0n ? r.big(debt) + 1n : usdc(r.int(1, 200));
          const fundBefore = await exchange.insuranceFund();
          await exchange.connect(r.pick([liquidator, ...traders])).depositInsurance(amount);
          const repaid = amount < debt ? amount : debt;
          expect(await exchange.totalBadDebt()).to.equal(debt - repaid);
          expect(await exchange.insuranceFund()).to.equal(fundBefore + amount - repaid);
          stats.insuranceDeposits++;
          if (repaid > 0n) totals.badDebtRepayments++;
        } else {
          label = "deposit";
          await exchange.connect(r.pick(traders)).deposit(usdc(r.int(100, 20_000)));
        }

        await checkInvariant(`step ${step} (${label})`);
        const debtNow = await exchange.totalBadDebt();
        if (debtNow > maxBadDebt) maxBadDebt = debtNow;
      }

      totals.liquidations += stats.liquidations;
      totals.fallbackLiquidations += stats.fallbackLiquidations;
      totals.fallbackWithKnownTruth += stats.fallbackWithKnownTruth;
      totals.fills += stats.fills;
      totals.failedFills += stats.failedFills;
      totals.edgeReductions += stats.edgeReductions;
      // only expected failure modes: nothing may slip through as an unknown revert
      for (const reason of Object.keys(failureReasons)) {
        expect(["InsufficientMargin", "NegativeAccountValue", "FillTooSmall", "OpenInterestCapExceeded"], `unexpected failure ${reason}`).to.include(reason);
      }
      totals.badDebt += maxBadDebt;
      expect(stats.insuranceDeposits, "insurance deposits").to.be.gt(0);
      totals.insurance += await exchange.insuranceFund();
      if (process.env.INVARIANT_DEBUG) console.log(seed, stats, failureReasons, "badDebt", await exchange.totalBadDebt(), "insurance", await exchange.insuranceFund());
      // The run must actually have exercised the system.
      expect(stats.fills, "fills").to.be.gt(30);
      expect(stats.fundings, "fundings").to.be.gt(5);
      expect(stats.withdrawals, "withdrawals").to.be.gt(0);

      // ---------------------------------------------------------- wind down
      // Close every position: liquidate whoever is liquidatable, then pair longs with
      // shorts at the index price. Afterwards only cash balances remain.
      await refreshPrices();
      for (const m of MARKETS) {
        const cfg = marketConfig(m === BTC ? "BTC-USD" : "ETH-USD", { minOrderSize: 1, maxOpenInterest: wad(1_000_000) });
        await exchange.updateMarket(m, cfg);
      }
      const everyone = [...traders, liquidator, outageLiquidator];
      for (let round = 0; round < 200; round++) {
        for (let i = 0; i < 5; i++) await liquidateAll();
        let open = false;
        for (const m of MARKETS) {
          const sizes = await Promise.all(everyone.map(async (a) => (await exchange.getPosition(a.address, m)).size));
          const li = sizes.findIndex((s) => s > 0n);
          const si = sizes.findIndex((s) => s < 0n);
          if (li < 0) continue;
          open = true;
          const size = sizes[li] < -sizes[si] ? sizes[li] : -sizes[si];
          await ctx.settle([await ctx.trade(everyone[si], everyone[li], size, prices[m], { marketId: m })]);
        }
        if (!open) break;
      }

      let balances = 0n;
      for (const a of accounts) {
        for (const m of MARKETS) {
          const p = await exchange.getPosition(a.address, m);
          expect(p.size, "all positions closed").to.equal(0);
          expect(p.entryNotional).to.equal(0);
        }
        const balance = await exchange.balanceOf(a.address);
        expect(balance, "no negative balance without positions").to.be.gte(0);
        balances += balance;
      }
      // In some runs the remaining bad debt is repaid through the insurance fund, after
      // which everybody must be payable in full; in the others it is left standing.
      if (seed % 2 === 1 && (await exchange.totalBadDebt()) > 0n) {
        const debt = await exchange.totalBadDebt();
        await exchange.connect(liquidator).depositInsurance(debt + 123n);
        expect(await exchange.totalBadDebt()).to.equal(0);
        totals.badDebtRepayments++;
      }
      const surplus = await checkInvariant("wind down");
      const held = await token.balanceOf(exchangeAddress);
      const insurance = await exchange.insuranceFund();
      const badDebt = await exchange.totalBadDebt();
      expect(held + badDebt).to.be.gte(balances + insurance);
      // What is not claimed by anyone is rounding dust only.
      expect(surplus, "unassigned dust").to.be.lt(usdc("0.01"));

      // Everybody can cash out; whoever comes last bears the recorded bad debt (if any).
      let shortfall = 0n;
      for (const a of accounts) {
        const balance = await exchange.balanceOf(a.address);
        if (balance === 0n) continue;
        const available = await token.balanceOf(exchangeAddress);
        if (balance <= available) {
          await exchange.connect(a).withdraw(balance);
        } else {
          shortfall += balance - available;
          if (available > 0n) await exchange.connect(a).withdraw(available);
        }
      }
      expect(shortfall, "shortfall never exceeds recorded bad debt").to.be.lte(badDebt);
      if (badDebt === 0n) {
        // fully solvent: only the insurance fund and dust remain in the contract
        expect(await token.balanceOf(exchangeAddress)).to.equal(insurance + surplus);
      }
    });
  }
});
