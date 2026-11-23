import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BTC, ETH, HOUR, deployFixture, marketConfig, usdc, wad } from "./helpers";

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

describe("Solvency invariant (randomized)", function () {
  this.timeout(600_000);
  const totals = { liquidations: 0, badDebt: 0n, insurance: 0n };

  after(() => {
    // Across the seeds the runs must have covered liquidations with a penalty and bad debt.
    expect(totals.liquidations, "liquidations").to.be.gt(5);
    expect(totals.badDebt > 0n, "bad debt occurred").to.equal(true);
    expect(totals.insurance > 0n, "penalties reached the insurance fund").to.equal(true);
  });

  for (const seed of [1, 2, 3, 20241123]) {
    it(`holds through a random sequence of actions (seed ${seed})`, async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, token, ctx, feeRecipient, liquidator } = f;
      const r = rng(seed);
      const traders: HardhatEthersSigner[] = [f.alice, f.bob, f.carol, f.dave, f.stranger];
      const accounts = [...traders, liquidator, feeRecipient];
      const exchangeAddress = await exchange.getAddress();
      const prices: Record<number, bigint> = { [BTC]: wad(50_000), [ETH]: wad(2_000) };
      const stats = { fills: 0, failedFills: 0, liquidations: 0, withdrawals: 0, refusedWithdrawals: 0, fundings: 0 };

      const failureReasons: Record<string, number> = {};

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
      for (const t of traders) await exchange.connect(t).deposit(usdc(r.int(8_000, 30_000)));

      for (let step = 0; step < STEPS; step++) {
        const roll = r.next();
        let label: string;

        if (roll < 0.5) {
          // ---- fill at a price near the index, with sizes and prices that do not divide evenly
          label = "fill";
          const market = r.pick(MARKETS);
          const maker = r.pick(traders);
          let taker = r.pick(traders);
          while (taker === maker) taker = r.pick(traders);
          const makerBuys = r.next() < 0.5;
          const unit = market === BTC ? wad(1) : wad(25);
          const size = (unit * BigInt(r.int(1, 500))) / 1000n + r.big(10n ** 12n);
          const price = (prices[market] * BigInt(r.int(9900, 10100))) / 10000n + r.big(10n ** 15n);
          const makerOrder = ctx.order(maker, makerBuys, size, price, { marketId: market });
          const takerOrder = ctx.order(taker, !makerBuys, size, price, { marketId: market });
          // partial fills too
          const fill = r.next() < 0.3 ? r.big(size) + 1n : size;
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
          const bps = r.next() < 0.12 ? r.int(-3000, 3000) : r.int(-700, 700);
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
        } else if (roll < 0.95) {
          // ---- withdraw: sometimes exactly the maximum, sometimes too much
          label = "withdraw";
          const t = r.pick(traders);
          const free = await exchange.freeCollateral(t.address);
          const held = await token.balanceOf(exchangeAddress);
          if (r.next() < 0.25) {
            await expect(exchange.connect(t).withdraw(free + 1n)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
            stats.refusedWithdrawals++;
          } else if (free > 0n && free <= held) {
            await exchange.connect(t).withdraw(r.next() < 0.5 ? free : r.big(free) + 1n);
            stats.withdrawals++;
          }
        } else {
          label = "deposit";
          await exchange.connect(r.pick(traders)).deposit(usdc(r.int(100, 20_000)));
        }

        await checkInvariant(`step ${step} (${label})`);
      }

      totals.liquidations += stats.liquidations;
      totals.badDebt += await exchange.totalBadDebt();
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
        const cfg = marketConfig(m === BTC ? "BTC-USD" : "ETH-USD", { minOrderSize: 0, maxOpenInterest: wad(1_000_000) });
        await exchange.updateMarket(m, cfg);
      }
      const everyone = [...traders, liquidator];
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
