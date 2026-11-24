import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  BTC,
  BTC_PRICE,
  ETH,
  HOUR,
  MAX_PRICE_AGE,
  ORDER_TYPES,
  deployFixture,
  feeOf,
  malleate,
  marketConfig,
  notionalDown,
  notionalUp,
  usdc,
  wad,
} from "./helpers";

const ONE = wad(1);
const MAX = ethers.MaxUint256;

describe("Exchange", () => {
  /** alice (maker) long 1 BTC, bob (taker) short 1 BTC at 50,000. */
  async function openFixture() {
    const f = await loadFixture(deployFixture);
    await f.exchange.connect(f.alice).deposit(usdc(20_000));
    await f.exchange.connect(f.bob).deposit(usdc(20_000));
    await f.ctx.settleOk([await f.ctx.trade(f.alice, f.bob, ONE, BTC_PRICE)]);
    return f;
  }

  /** Like openFixture but alice is thinly margined (10,090 after fees) and a funded liquidator exists. */
  async function leveragedFixture() {
    const f = await loadFixture(deployFixture);
    await f.exchange.connect(f.alice).deposit(usdc(10_100));
    await f.exchange.connect(f.bob).deposit(usdc(40_000));
    await f.exchange.connect(f.liquidator).deposit(usdc(100_000));
    await f.ctx.settleOk([await f.ctx.trade(f.alice, f.bob, ONE, BTC_PRICE)]);
    return f;
  }

  describe("deployment and admin", () => {
    it("exposes configuration", async () => {
      const { exchange, token, oracle, owner, feeRecipient, operator } = await loadFixture(deployFixture);
      expect(await exchange.collateralToken()).to.equal(await token.getAddress());
      expect(await exchange.oracle()).to.equal(await oracle.getAddress());
      expect(await exchange.owner()).to.equal(owner.address);
      expect(await exchange.feeRecipient()).to.equal(feeRecipient.address);
      expect(await exchange.marketCount()).to.equal(2);
      expect(await exchange.isOperator(operator.address)).to.equal(true);
      expect(await exchange.isOperator(owner.address)).to.equal(false);
      const m = await exchange.getMarket(ETH);
      expect(m.symbol).to.equal("ETH-USD");
      expect(m.initialMarginBps).to.equal(2000);
      expect(await exchange.indexPrice(BTC)).to.equal(BTC_PRICE);
      expect(await exchange.markPrice(BTC)).to.equal(0);
      await expect(exchange.getMarket(2)).to.be.revertedWithCustomError(exchange, "UnknownMarket");
      await expect(exchange.indexPrice(2)).to.be.revertedWithCustomError(exchange, "UnknownMarket");
    });

    it("rejects bad constructor arguments", async () => {
      const { token, oracle, owner, exchange } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("Exchange");
      const t = await token.getAddress();
      const o = await oracle.getAddress();
      await expect(F.deploy(ethers.ZeroAddress, o, owner.address, owner.address, 60, 10, 500)).to.be.revertedWithCustomError(exchange, "ZeroAddress");
      await expect(F.deploy(t, ethers.ZeroAddress, owner.address, owner.address, 60, 10, 500)).to.be.revertedWithCustomError(exchange, "ZeroAddress");
      await expect(F.deploy(t, o, owner.address, ethers.ZeroAddress, 60, 10, 500)).to.be.revertedWithCustomError(exchange, "ZeroAddress");
      await expect(F.deploy(t, o, owner.address, owner.address, 0, 10, 500)).to.be.revertedWithCustomError(exchange, "InvalidConfig");
      // funding rate cap is itself capped at 100 bps per hour
      await expect(F.deploy(t, o, owner.address, owner.address, 60, 101, 500)).to.be.revertedWithCustomError(exchange, "InvalidConfig");
      // the price band must be set and below 100%
      await expect(F.deploy(t, o, owner.address, owner.address, 60, 10, 0)).to.be.revertedWithCustomError(exchange, "InvalidConfig");
      await expect(F.deploy(t, o, owner.address, owner.address, 60, 10, 10_000)).to.be.revertedWithCustomError(exchange, "InvalidConfig");
      const ok = await F.deploy(t, o, owner.address, owner.address, 60, 100, 500);
      expect(await ok.maxFundingRateBps()).to.equal(100);
      expect(await ok.maxPriceDeviationBps()).to.equal(500);
    });

    it("only the owner can administer", async () => {
      const { exchange, stranger } = await loadFixture(deployFixture);
      const e = exchange.connect(stranger);
      const err = "OwnableUnauthorizedAccount";
      await expect(e.addMarket(marketConfig("SOL-USD"))).to.be.revertedWithCustomError(exchange, err);
      await expect(e.updateMarket(BTC, marketConfig("BTC-USD"))).to.be.revertedWithCustomError(exchange, err);
      await expect(e.setOperator(stranger.address, true)).to.be.revertedWithCustomError(exchange, err);
      await expect(e.setFeeRecipient(stranger.address)).to.be.revertedWithCustomError(exchange, err);
      await expect(e.setPaused(true)).to.be.revertedWithCustomError(exchange, err);
    });

    it("owner adds and updates markets, operators and fee recipient", async () => {
      const { exchange, stranger } = await loadFixture(deployFixture);
      await expect(exchange.addMarket(marketConfig("SOL-USD"))).to.emit(exchange, "MarketAdded").withArgs(2, "SOL-USD");
      expect(await exchange.marketCount()).to.equal(3);

      await expect(exchange.updateMarket(BTC, marketConfig("BTC-USD", { takerFeeBps: 7, active: false })))
        .to.emit(exchange, "MarketUpdated")
        .withArgs(BTC);
      const m = await exchange.getMarket(BTC);
      expect(m.takerFeeBps).to.equal(7);
      expect(m.active).to.equal(false);
      await expect(exchange.updateMarket(9, marketConfig("X"))).to.be.revertedWithCustomError(exchange, "UnknownMarket");

      await expect(exchange.setOperator(stranger.address, true)).to.emit(exchange, "OperatorUpdated").withArgs(stranger.address, true);
      expect(await exchange.isOperator(stranger.address)).to.equal(true);
      await exchange.setOperator(stranger.address, false);
      expect(await exchange.isOperator(stranger.address)).to.equal(false);

      await expect(exchange.setFeeRecipient(stranger.address)).to.emit(exchange, "FeeRecipientUpdated").withArgs(stranger.address);
      await expect(exchange.setFeeRecipient(ethers.ZeroAddress)).to.be.revertedWithCustomError(exchange, "ZeroAddress");
      await expect(exchange.setOperator(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(exchange, "ZeroAddress");
    });

    it("ownership is transferred in two steps", async () => {
      const { exchange, owner, stranger, carol: multisig } = await loadFixture(deployFixture);
      await expect(exchange.connect(stranger).transferOwnership(stranger.address)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await expect(exchange.transferOwnership(multisig.address)).to.emit(exchange, "OwnershipTransferStarted").withArgs(owner.address, multisig.address);
      // nothing changes until the new owner accepts
      expect(await exchange.owner()).to.equal(owner.address);
      expect(await exchange.pendingOwner()).to.equal(multisig.address);
      await expect(exchange.connect(multisig).setPaused(true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await exchange.setPaused(true);
      await exchange.setPaused(false);
      await expect(exchange.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");

      // a mistyped address can be corrected by starting again
      await exchange.transferOwnership(stranger.address);
      await expect(exchange.connect(multisig).acceptOwnership()).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await exchange.transferOwnership(multisig.address);

      await expect(exchange.connect(multisig).acceptOwnership()).to.emit(exchange, "OwnershipTransferred").withArgs(owner.address, multisig.address);
      expect(await exchange.owner()).to.equal(multisig.address);
      expect(await exchange.pendingOwner()).to.equal(ethers.ZeroAddress);
      await expect(exchange.setPaused(true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await exchange.connect(multisig).setPaused(true);
    });

    it("validates market parameters", async () => {
      const { exchange } = await loadFixture(deployFixture);
      const bad = [
        { maintenanceMarginBps: 0 },
        { maintenanceMarginBps: 2001 },
        { initialMarginBps: 10_001 },
        { makerFeeBps: 101 },
        { takerFeeBps: 101 },
        { liquidationPenaltyBps: 1001 },
        { symbol: "" },
        // band (500) + highest fee must stay below the maintenance margin
        { maintenanceMarginBps: 505, liquidationPenaltyBps: 150 },
        { maintenanceMarginBps: 520, liquidationPenaltyBps: 150, makerFeeBps: 20 },
        { maintenanceMarginBps: 500, liquidationPenaltyBps: 150, makerFeeBps: 0, takerFeeBps: 0 },
      ];
      for (const o of bad) {
        await expect(exchange.addMarket(marketConfig("X-USD", o))).to.be.revertedWithCustomError(exchange, "InvalidMarketConfig");
        await expect(exchange.updateMarket(BTC, marketConfig("X-USD", o))).to.be.revertedWithCustomError(exchange, "InvalidMarketConfig");
      }
    });
  });

  describe("deposit / withdraw", () => {
    it("moves USDC and credits the balance", async () => {
      const { exchange, token, alice } = await loadFixture(deployFixture);
      const before = await token.balanceOf(alice.address);
      await expect(exchange.connect(alice).deposit(usdc(1000))).to.emit(exchange, "Deposit").withArgs(alice.address, usdc(1000));
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(1000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(1000));
      expect(await exchange.freeCollateral(alice.address)).to.equal(usdc(1000));
      expect(await token.balanceOf(await exchange.getAddress())).to.equal(usdc(1000));

      await expect(exchange.connect(alice).withdraw(usdc(400))).to.emit(exchange, "Withdraw").withArgs(alice.address, usdc(400));
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(600));
      expect(await token.balanceOf(alice.address)).to.equal(before - usdc(600));
    });

    it("rejects zero amounts and overdrafts", async () => {
      const { exchange, alice, bob } = await loadFixture(deployFixture);
      await expect(exchange.connect(alice).deposit(0)).to.be.revertedWithCustomError(exchange, "ZeroAmount");
      await expect(exchange.connect(alice).withdraw(0)).to.be.revertedWithCustomError(exchange, "ZeroAmount");
      await exchange.connect(alice).deposit(usdc(100));
      await exchange.connect(bob).deposit(usdc(100));
      await expect(exchange.connect(alice).withdraw(usdc(100) + 1n)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
      await exchange.connect(alice).withdraw(usdc(100));
      await expect(exchange.connect(alice).withdraw(1)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
    });

    it("withdrawals must leave initial margin satisfied", async () => {
      const { exchange, alice } = await openFixture();
      // balance 19,990 (maker fee 10), initial margin 10,000
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(19_990));
      expect(await exchange.freeCollateral(alice.address)).to.equal(usdc(9_990));
      await expect(exchange.connect(alice).withdraw(usdc(9_990) + 1n)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
      await exchange.connect(alice).withdraw(usdc(9_990));
      expect(await exchange.freeCollateral(alice.address)).to.equal(0);
      // Any adverse move now blocks further withdrawals.
      await expect(exchange.connect(alice).withdraw(1)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
    });

    it("unrealized profit is withdrawable; the cash balance may go negative", async () => {
      const { exchange, oracle, alice } = await openFixture();
      await oracle.setPrice(BTC, wad(65_000));
      // value = 19,990 + 15,000; initial = 13,000
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(34_990));
      expect(await exchange.freeCollateral(alice.address)).to.equal(usdc(21_990));
      await exchange.connect(alice).withdraw(usdc(21_990));
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(-2_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(13_000));
      await expect(exchange.connect(alice).withdraw(1)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
    });
  });

  describe("order validation", () => {
    it("settles a signed match and emits Fill", async () => {
      const { exchange, ctx, alice, bob, feeRecipient } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(20_000));
      await exchange.connect(bob).deposit(usdc(20_000));
      const m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      const makerHash = await exchange.hashOrder(m.maker);
      const takerHash = await exchange.hashOrder(m.taker);
      await expect(ctx.settle([m]))
        .to.emit(exchange, "Fill")
        .withArgs(BTC, alice.address, bob.address, makerHash, takerHash, false, ONE, BTC_PRICE, usdc(10), usdc(25));

      expect(await exchange.filledSize(makerHash)).to.equal(ONE);
      expect(await exchange.filledSize(takerHash)).to.equal(ONE);
      expect(await exchange.markPrice(BTC)).to.equal(BTC_PRICE);
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(19_990));
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc(19_975));
      expect(await exchange.balanceOf(feeRecipient.address)).to.equal(usdc(35));

      const pa = await exchange.getPosition(alice.address, BTC);
      const pb = await exchange.getPosition(bob.address, BTC);
      expect(pa.size).to.equal(ONE);
      expect(pa.entryNotional).to.equal(usdc(50_000));
      expect(pb.size).to.equal(-ONE);
      expect(pb.entryNotional).to.equal(usdc(50_000));
      expect(await exchange.openInterest(BTC)).to.deep.equal([ONE, ONE]);
      expect(await exchange.marginRequirement(alice.address)).to.deep.equal([usdc(10_000), usdc(5_000)]);
    });

    it("hashOrder is the EIP-712 digest wallets sign", async () => {
      const { exchange, ctx, alice } = await loadFixture(deployFixture);
      const order = ctx.order(alice, true, ONE, BTC_PRICE, { expiry: 1234567890, reduceOnly: true, nonce: 77 });
      const domain = {
        name: "Baldwin",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await exchange.getAddress(),
      };
      expect(await exchange.hashOrder(order)).to.equal(ethers.TypedDataEncoder.hash(domain, ORDER_TYPES, order));
    });

    it("the fee recipient can withdraw collected fees", async () => {
      const { exchange, token, feeRecipient } = await openFixture();
      await exchange.connect(feeRecipient).withdraw(usdc(35));
      expect(await token.balanceOf(feeRecipient.address)).to.equal(usdc(35));
    });

    it("rejects a signature by someone else, for another domain, or tampered orders", async () => {
      const { exchange, ctx, alice, bob, carol } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(20_000));
      await exchange.connect(bob).deposit(usdc(20_000));

      // signed by carol in alice's name
      let m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.makerSig = await ctx.sign(carol, m.maker);
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      // taker side forged
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.takerSig = await ctx.sign(carol, m.taker);
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      // order changed after signing
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.maker = { ...m.maker, size: wad(2) };
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      // signed for another chain id
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.makerSig = await alice.signTypedData(
        { name: "Baldwin", version: "1", chainId: 1, verifyingContract: await exchange.getAddress() },
        ORDER_TYPES,
        m.maker,
      );
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      // signed for another exchange
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.makerSig = await alice.signTypedData(
        { name: "Baldwin", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: carol.address },
        ORDER_TYPES,
        m.maker,
      );
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      // garbage
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.makerSig = "0x1234";
      expect(await ctx.settleError(m)).to.equal("ECDSAInvalidSignatureLength");

      // zero trader
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.maker = { ...m.maker, trader: ethers.ZeroAddress };
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(0);
    });

    it("rejects malleable (high-s) signatures", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(20_000));
      await exchange.connect(bob).deposit(usdc(20_000));
      const m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      const good = m.makerSig as string;
      m.makerSig = malleate(good);
      expect(m.makerSig).to.not.equal(good);
      expect(await ctx.settleError(m)).to.equal("ECDSAInvalidSignatureS");
      m.makerSig = good;
      expect(await ctx.settleError(m)).to.equal("");
    });

    it("cannot replay a filled match", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      await ctx.settleOk([m]);
      expect(await ctx.settleError(m)).to.equal("Overfill");
      // also within the same batch
      const m2 = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      const receipt = (await (await ctx.settle([m2, m2])).wait())!;
      expect(ctx.failures(receipt)).to.deep.equal([{ index: 1, error: "Overfill" }]);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(wad(2));
    });

    it("tracks partial fills by order hash and refuses overfills", async () => {
      const { exchange, ctx, alice, bob, carol } = await loadFixture(deployFixture);
      for (const s of [alice, bob, carol]) await exchange.connect(s).deposit(usdc(50_000));
      const maker = ctx.order(alice, true, ONE, BTC_PRICE);
      const makerHash = await exchange.hashOrder(maker);

      const t1 = ctx.order(bob, false, wad("0.3"), BTC_PRICE);
      await ctx.settleOk([await ctx.match(alice, maker, bob, t1, wad("0.3"))]);
      expect(await exchange.filledSize(makerHash)).to.equal(wad("0.3"));

      const t2 = ctx.order(carol, false, wad("0.5"), wad(49_000)); // taker limit below the maker price is fine
      await ctx.settleOk([await ctx.match(alice, maker, carol, t2, wad("0.5"))]);
      expect(await exchange.filledSize(makerHash)).to.equal(wad("0.8"));

      // 0.2 left on the maker
      const t3 = ctx.order(bob, false, ONE, BTC_PRICE);
      expect(await ctx.settleError(await ctx.match(alice, maker, bob, t3, wad("0.2") + 1n))).to.equal("Overfill");
      await ctx.settleOk([await ctx.match(alice, maker, bob, t3, wad("0.2"))]);
      expect(await exchange.filledSize(makerHash)).to.equal(ONE);
      expect(await exchange.filledSize(await exchange.hashOrder(t3))).to.equal(wad("0.2"));
      expect(await ctx.settleError(await ctx.match(alice, maker, bob, t3, 1n))).to.equal("Overfill");

      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(ONE);
      expect((await exchange.getPosition(bob.address, BTC)).size).to.equal(-wad("0.5"));
      expect((await exchange.getPosition(carol.address, BTC)).size).to.equal(-wad("0.5"));
    });

    it("on-chain cancel blocks the order (including its unfilled remainder)", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const maker = ctx.order(alice, true, ONE, BTC_PRICE, { nonce: 4242 });
      await ctx.settleOk([await ctx.match(alice, maker, bob, ctx.order(bob, false, wad("0.4"), BTC_PRICE), wad("0.4"))]);

      expect(await exchange.isCancelled(alice.address, 4242)).to.equal(false);
      await expect(exchange.connect(alice).cancelOrder(4242)).to.emit(exchange, "OrderCancelled").withArgs(alice.address, 4242);
      expect(await exchange.isCancelled(alice.address, 4242)).to.equal(true);
      // someone else's nonce space is untouched
      expect(await exchange.isCancelled(bob.address, 4242)).to.equal(false);

      const m = await ctx.match(alice, maker, bob, ctx.order(bob, false, wad("0.4"), BTC_PRICE), wad("0.4"));
      expect(await ctx.settleError(m)).to.equal("OrderIsCancelled");
      // cancelled taker
      const taker = ctx.order(bob, false, ONE, BTC_PRICE, { nonce: 9 });
      await exchange.connect(bob).cancelOrder(9);
      expect(await ctx.settleError(await ctx.match(alice, ctx.order(alice, true, ONE, BTC_PRICE), bob, taker, ONE))).to.equal("OrderIsCancelled");
    });

    it("bulk cancel invalidates every order below minValidNonce and can only go up", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const size = wad("0.1");
      const sell = () => ctx.order(bob, false, size, BTC_PRICE);
      const old1 = ctx.order(alice, true, size, BTC_PRICE, { nonce: 1_000 });
      const old2 = ctx.order(alice, true, size, BTC_PRICE, { nonce: 1_499 });
      const edge = ctx.order(alice, true, size, BTC_PRICE, { nonce: 1_500 });
      const newer = ctx.order(alice, true, size, BTC_PRICE, { nonce: 2_000 });
      // partially filled before the cancel
      await ctx.settleOk([await ctx.match(alice, old1, bob, sell(), wad("0.05"))]);

      expect(await exchange.minValidNonce(alice.address)).to.equal(0);
      expect(await exchange.isCancelled(alice.address, 1_000)).to.equal(false);
      await expect(exchange.connect(alice).cancelAllOrders(0)).to.be.revertedWithCustomError(exchange, "NonceNotIncreased");
      await expect(exchange.connect(alice).cancelAllOrders(1_500)).to.emit(exchange, "OrdersCancelledBelow").withArgs(alice.address, 1_500);
      expect(await exchange.minValidNonce(alice.address)).to.equal(1_500);

      // cannot be lowered or repeated, only raised
      await expect(exchange.connect(alice).cancelAllOrders(1_499)).to.be.revertedWithCustomError(exchange, "NonceNotIncreased");
      await expect(exchange.connect(alice).cancelAllOrders(1_500)).to.be.revertedWithCustomError(exchange, "NonceNotIncreased");
      await expect(exchange.connect(alice).cancelAllOrders(1)).to.be.revertedWithCustomError(exchange, "NonceNotIncreased");

      expect(await exchange.isCancelled(alice.address, 0)).to.equal(true);
      expect(await exchange.isCancelled(alice.address, 1_000)).to.equal(true);
      expect(await exchange.isCancelled(alice.address, 1_499)).to.equal(true);
      expect(await exchange.isCancelled(alice.address, 1_500)).to.equal(false);
      // other traders are unaffected
      expect(await exchange.isCancelled(bob.address, 1)).to.equal(false);
      expect(await exchange.minValidNonce(bob.address)).to.equal(0);

      // orders signed before the bulk cancel are dead, as maker or as taker, filled or not
      expect(await ctx.settleError(await ctx.match(alice, old1, bob, sell(), wad("0.05")))).to.equal("OrderIsCancelled");
      expect(await ctx.settleError(await ctx.match(alice, old2, bob, sell(), size))).to.equal("OrderIsCancelled");
      expect(await ctx.settleError(await ctx.match(bob, sell(), alice, old2, size))).to.equal("OrderIsCancelled");
      // nonces at or above the threshold work
      expect(await ctx.settleError(await ctx.match(alice, edge, bob, sell(), size))).to.equal("");
      expect(await ctx.settleError(await ctx.match(alice, newer, bob, sell(), wad("0.05")))).to.equal("");

      // individual cancels still work above the threshold and both show in isCancelled
      await exchange.connect(alice).cancelOrder(2_000);
      expect(await exchange.isCancelled(alice.address, 2_000)).to.equal(true);
      expect(await ctx.settleError(await ctx.match(alice, newer, bob, sell(), wad("0.05")))).to.equal("OrderIsCancelled");

      // raising again kills more; the maximum value kills everything below it
      await exchange.connect(alice).cancelAllOrders(ethers.MaxUint256);
      const late = ctx.order(alice, true, size, BTC_PRICE, { nonce: ethers.MaxUint256 - 1n });
      expect(await ctx.settleError(await ctx.match(alice, late, bob, sell(), size))).to.equal("OrderIsCancelled");
      await expect(exchange.connect(alice).cancelAllOrders(ethers.MaxUint256)).to.be.revertedWithCustomError(exchange, "NonceNotIncreased");
    });

    it("orders must expire, at most maxOrderLifetime ahead", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const LIFETIME = 30 * 24 * 3600;
      expect(await exchange.maxOrderLifetime()).to.equal(LIFETIME);
      expect(await exchange.MAX_ORDER_LIFETIME()).to.equal(LIFETIME);
      const size = wad("0.1");
      const sell = (o = {}) => ctx.order(bob, false, size, BTC_PRICE, o);
      const buy = (o = {}) => ctx.order(alice, true, size, BTC_PRICE, o);

      // no expiry
      expect(await ctx.settleError(await ctx.match(alice, buy({ expiry: 0 }), bob, sell(), size))).to.equal("InvalidExpiry");
      expect(await ctx.settleError(await ctx.match(alice, buy(), bob, sell({ expiry: 0 }), size))).to.equal("InvalidExpiry");

      // too far ahead: exactly now + lifetime is fine, one second more is not
      const t = (await time.latest()) + 10;
      const atLimit = await ctx.match(alice, buy({ expiry: t + LIFETIME }), bob, sell(), size);
      const beyond = await ctx.match(alice, buy({ expiry: t + LIFETIME + 1 }), bob, sell(), size);
      const beyondTaker = await ctx.match(alice, buy(), bob, sell({ expiry: t + LIFETIME + 1 }), size);
      await time.setNextBlockTimestamp(t);
      const receipt = (await (await ctx.settle([beyond, beyondTaker, atLimit])).wait())!;
      expect(ctx.failures(receipt)).to.deep.equal([
        { index: 0, error: "InvalidExpiry" },
        { index: 1, error: "InvalidExpiry" },
      ]);
      // An order dated too far ahead is not dead: it becomes fillable once its expiry is within range.
      await time.setNextBlockTimestamp(t + 1);
      expect(await ctx.settleError(beyond)).to.equal("");

      // already expired
      const past = await ctx.match(alice, buy({ expiry: t - 100 }), bob, sell(), size);
      expect(await ctx.settleError(past)).to.equal("OrderExpired");
    });

    it("enforces expiry (inclusive)", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const expiry = (await time.latest()) + 100;
      const maker = ctx.order(alice, true, ONE, BTC_PRICE, { expiry });

      await time.setNextBlockTimestamp(expiry);
      await ctx.settleOk([await ctx.match(alice, maker, bob, ctx.order(bob, false, wad("0.5"), BTC_PRICE), wad("0.5"))]);

      const m = await ctx.match(alice, maker, bob, ctx.order(bob, false, wad("0.5"), BTC_PRICE), wad("0.5"));
      await time.setNextBlockTimestamp(expiry + 1);
      expect(await ctx.settleError(m)).to.equal("OrderExpired");

      // expired taker
      const taker = ctx.order(bob, false, wad("0.5"), BTC_PRICE, { expiry });
      expect(await ctx.settleError(await ctx.match(alice, ctx.order(alice, true, ONE, BTC_PRICE), bob, taker, wad("0.5")))).to.equal("OrderExpired");
    });

    it("rejects structurally invalid matches", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const buy = (o = {}) => ctx.order(alice, true, ONE, BTC_PRICE, o);
      const sell = (o = {}) => ctx.order(bob, false, ONE, BTC_PRICE, o);

      // self trade
      const selfSell = ctx.order(alice, false, ONE, BTC_PRICE);
      expect(await ctx.settleError(await ctx.match(alice, buy(), alice, selfSell, ONE))).to.equal("SelfTrade");
      // same side
      expect(await ctx.settleError(await ctx.match(alice, buy(), bob, ctx.order(bob, true, ONE, BTC_PRICE), ONE))).to.equal("SameSide");
      // different markets
      expect(await ctx.settleError(await ctx.match(alice, buy(), bob, sell({ marketId: ETH }), ONE))).to.equal("MarketMismatch");
      // unknown market
      expect(await ctx.settleError(await ctx.match(alice, buy({ marketId: 7 }), bob, sell({ marketId: 7 }), ONE))).to.equal("UnknownMarket");
      // zero fill
      expect(await ctx.settleError(await ctx.match(alice, buy(), bob, sell(), 0n))).to.equal("ZeroAmount");
      // zero price
      expect(await ctx.settleError(await ctx.match(alice, buy({ limitPrice: 0 }), bob, sell({ limitPrice: 0 }), ONE))).to.equal("InvalidPrice");
      // below the minimum order size (0.001 BTC), maker or taker
      const tiny = wad("0.001") - 1n;
      expect(await ctx.settleError(await ctx.match(alice, buy({ size: tiny }), bob, sell(), tiny))).to.equal("OrderTooSmall");
      expect(await ctx.settleError(await ctx.match(alice, buy(), bob, sell({ size: tiny }), tiny))).to.equal("OrderTooSmall");
      // price outside the band around the index (5%)
      const far = wad(52_501);
      expect(await ctx.settleError(await ctx.match(alice, buy({ limitPrice: far }), bob, sell({ limitPrice: far }), ONE))).to.equal("PriceOutOfBand");
    });

    it("fills at the maker's price, which must satisfy the taker's limit", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));

      // maker bid 50,000, taker ask 50,001: no cross
      let m = await ctx.match(alice, ctx.order(alice, true, ONE, wad(50_000)), bob, ctx.order(bob, false, ONE, wad(50_001)), ONE);
      expect(await ctx.settleError(m)).to.equal("PriceNotCrossed");
      // maker ask 50,000, taker bid 49,999: no cross
      m = await ctx.match(bob, ctx.order(bob, false, ONE, wad(50_000)), alice, ctx.order(alice, true, ONE, wad(49_999)), ONE);
      expect(await ctx.settleError(m)).to.equal("PriceNotCrossed");

      // maker ask 50,000, taker bid 50,400: fills at 50,000 (price improvement for the taker)
      m = await ctx.match(bob, ctx.order(bob, false, ONE, wad(50_000)), alice, ctx.order(alice, true, ONE, wad(50_400)), ONE);
      await expect(ctx.settle([m])).to.emit(exchange, "Fill");
      expect((await exchange.getPosition(alice.address, BTC)).entryNotional).to.equal(usdc(50_000));
      expect(await exchange.markPrice(BTC)).to.equal(wad(50_000));
      // maker bob pays 2 bps, taker alice 5 bps
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc(49_990));
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(49_975));
    });

    it("a failing match does not revert the batch", async () => {
      const { exchange, ctx, alice, bob, carol, dave } = await loadFixture(deployFixture);
      for (const s of [alice, bob, carol]) await exchange.connect(s).deposit(usdc(50_000));
      const good1 = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      const badSig = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      badSig.takerSig = await ctx.sign(carol, badSig.taker);
      const noMargin = await ctx.trade(dave, carol, ONE, BTC_PRICE); // dave has no collateral
      const good2 = await ctx.trade(carol, bob, wad("0.5"), BTC_PRICE);

      const tx = await ctx.settle([good1, badSig, noMargin, good2]);
      const receipt = (await tx.wait())!;
      expect(ctx.failures(receipt)).to.deep.equal([
        { index: 1, error: "InvalidSignature" },
        { index: 2, error: "InsufficientMargin" },
      ]);
      await expect(tx)
        .to.emit(exchange, "MatchFailed")
        .withArgs(
          1,
          await exchange.hashOrder(badSig.maker),
          await exchange.hashOrder(badSig.taker),
          exchange.interface.encodeErrorResult("InvalidSignature"),
        );
      await expect(tx)
        .to.emit(exchange, "MatchFailed")
        .withArgs(
          2,
          await exchange.hashOrder(noMargin.maker),
          await exchange.hashOrder(noMargin.taker),
          exchange.interface.encodeErrorResult("InsufficientMargin", [dave.address]),
        );

      // failed matches left no trace
      expect(await exchange.filledSize(await exchange.hashOrder(badSig.maker))).to.equal(0);
      expect(await exchange.filledSize(await exchange.hashOrder(noMargin.taker))).to.equal(0);
      expect((await exchange.getPosition(dave.address, BTC)).size).to.equal(0);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(ONE);
      expect((await exchange.getPosition(bob.address, BTC)).size).to.equal(-wad("1.5"));
      expect((await exchange.getPosition(carol.address, BTC)).size).to.equal(wad("0.5"));
    });

    it("only operators settle; executeMatch is not callable from outside", async () => {
      const { exchange, ctx, alice, bob, stranger, owner } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      await expect(exchange.connect(stranger).settleMatches([m])).to.be.revertedWithCustomError(exchange, "NotOperator");
      await expect(exchange.connect(owner).settleMatches([m])).to.be.revertedWithCustomError(exchange, "NotOperator");
      await expect(exchange.connect(ctx.operator).executeMatch(m)).to.be.revertedWithCustomError(exchange, "OnlySelf");
      await exchange.setOperator(ctx.operator.address, false);
      await expect(ctx.settle([m])).to.be.revertedWithCustomError(exchange, "NotOperator");
    });
  });

  describe("reduceOnly", () => {
    it("only allows fills that shrink the position without flipping", async () => {
      const { exchange, ctx, alice, carol } = await openFixture();
      await exchange.connect(carol).deposit(usdc(50_000));
      const ro = (size: bigint, isBuy: boolean) => ctx.order(alice, isBuy, size, BTC_PRICE, { reduceOnly: true });

      // wrong direction (would increase the long)
      let m = await ctx.match(alice, ro(ONE, true), carol, ctx.order(carol, false, ONE, BTC_PRICE), ONE);
      expect(await ctx.settleError(m)).to.equal("ReduceOnlyViolated");
      // would flip: sell 1.5 against a long of 1
      m = await ctx.match(alice, ro(wad("1.5"), false), carol, ctx.order(carol, true, wad("1.5"), BTC_PRICE), wad("1.5"));
      expect(await ctx.settleError(m)).to.equal("ReduceOnlyViolated");
      // partial fill of the same order within the position is fine
      m.fillSize = wad("0.6");
      expect(await ctx.settleError(m)).to.equal("");
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(wad("0.4"));
      // the rest of that order (0.9) exceeds the remaining 0.4
      m.fillSize = wad("0.4") + 1n;
      expect(await ctx.settleError(m)).to.equal("ReduceOnlyViolated");
      // closing exactly to zero is allowed
      m.fillSize = wad("0.4");
      expect(await ctx.settleError(m)).to.equal("");
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(0);
      // no position left
      m = await ctx.match(alice, ro(ONE, false), carol, ctx.order(carol, true, ONE, BTC_PRICE), wad("0.1"));
      expect(await ctx.settleError(m)).to.equal("ReduceOnlyViolated");
    });

    it("applies to the taker side as well", async () => {
      const { ctx, alice, bob, carol, exchange } = await openFixture();
      await exchange.connect(carol).deposit(usdc(50_000));
      // bob is short 1; a reduce-only sell is invalid, a reduce-only buy is fine
      const sell = ctx.order(bob, false, ONE, BTC_PRICE, { reduceOnly: true });
      expect(await ctx.settleError(await ctx.match(carol, ctx.order(carol, true, ONE, BTC_PRICE), bob, sell, ONE))).to.equal("ReduceOnlyViolated");
      const buy = ctx.order(bob, true, ONE, BTC_PRICE, { reduceOnly: true });
      expect(await ctx.settleError(await ctx.match(alice, ctx.order(alice, false, ONE, BTC_PRICE), bob, buy, ONE))).to.equal("");
      expect(await exchange.openInterest(BTC)).to.deep.equal([0n, 0n]);
    });
  });

  describe("margin", () => {
    it("rejects fills that would leave either side under initial margin", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(10_009)); // needs 10,000 + 10 fee
      await exchange.connect(bob).deposit(usdc(20_000));
      expect(await ctx.settleError(await ctx.trade(alice, bob, ONE, BTC_PRICE))).to.equal("InsufficientMargin");
      expect(await ctx.settleError(await ctx.trade(bob, alice, ONE, BTC_PRICE))).to.equal("InsufficientMargin");
      await exchange.connect(alice).deposit(usdc(1));
      expect(await ctx.settleError(await ctx.trade(alice, bob, ONE, BTC_PRICE))).to.equal("");
      expect(await exchange.freeCollateral(alice.address)).to.equal(0);
    });

    it("counts the entry price against the index: buying above the index needs more margin", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(10_500));
      await exchange.connect(bob).deposit(usdc(20_000));
      // buying at 51,000 with the index at 50,000 is an instant 1,000 unrealized loss
      expect(await ctx.settleError(await ctx.trade(alice, bob, ONE, wad(51_000)))).to.equal("InsufficientMargin");
      expect(await ctx.settleError(await ctx.trade(alice, bob, ONE, wad(50_000)))).to.equal("");
    });

    it("is cross-margin across markets", async () => {
      const { exchange, ctx, alice, bob } = await openFixture();
      await exchange.connect(bob).deposit(usdc(50_000));
      // alice: value 19,990, BTC initial margin 10,000. 50 ETH needs 20,000 more.
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad(50), wad(2_000), { marketId: ETH }))).to.equal("InsufficientMargin");
      // 6 ETH needs 2,400.
      await ctx.settleOk([await ctx.trade(bob, alice, wad(6), wad(2_000), { marketId: ETH, makerIsSeller: true })]);
      expect(await exchange.marginRequirement(alice.address)).to.deep.equal([usdc(12_400), usdc(6_200)]);
      // maker fee on 12,000 notional = 2.4
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("19987.6"));

      // BTC +10% (+5,000), ETH +50% against the short (-6,000)
      await ctx.oracle.setPrice(BTC, wad(55_000));
      await ctx.oracle.setPrice(ETH, wad(3_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("18987.6"));
      expect(await exchange.marginRequirement(alice.address)).to.deep.equal([usdc(14_600), usdc(7_300)]);
      expect(await exchange.freeCollateral(alice.address)).to.equal(usdc("4387.6"));
    });

    it("risk-reducing fills are allowed below initial margin, increases are not", async () => {
      const { exchange, oracle, ctx, alice, bob, carol } = await leveragedFixture();
      await exchange.connect(carol).deposit(usdc(50_000));
      await oracle.setPrice(BTC, wad(46_000));
      // value 6,090 < initial 9,200, but above maintenance 4,600
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(6_090));
      expect(await exchange.freeCollateral(alice.address)).to.equal(0);
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);

      expect(await ctx.settleError(await ctx.trade(alice, carol, wad("0.1"), wad(46_000)))).to.equal("InsufficientMargin");
      // flipping is not a reduction: short 2 would need 18,400
      expect(await ctx.settleError(await ctx.trade(carol, alice, wad(3), wad(46_000)))).to.equal("InsufficientMargin");
      // reduce by 0.1: realized -400, taker fee 2.3
      await ctx.settleOk([await ctx.trade(carol, alice, wad("0.1"), wad(46_000))]);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(wad("0.9"));
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("9687.7"));
      // still under initial margin afterwards (6,087.7 < 8,280), yet the fill was allowed
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("6087.7"));
      expect((await exchange.marginRequirement(alice.address))[0]).to.equal(usdc(8_280));
      void bob;
    });

    it("an account with negative value cannot trade its way out; it must be liquidated", async () => {
      const { exchange, oracle, ctx, alice, carol } = await leveragedFixture();
      await exchange.connect(carol).deposit(usdc(50_000));
      await oracle.setPrice(BTC, wad(38_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(-1_910));
      expect(await ctx.settleError(await ctx.trade(carol, alice, ONE, wad(38_000)))).to.equal("NegativeAccountValue");
      expect(await ctx.settleError(await ctx.trade(carol, alice, wad("0.5"), wad(39_000)))).to.equal("NegativeAccountValue");
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(10_090));
    });

    it("enforces the open interest cap, but never blocks reductions", async () => {
      const { exchange, ctx, alice, bob, carol } = await loadFixture(deployFixture);
      for (const s of [alice, bob, carol]) await exchange.connect(s).deposit(usdc(5_000_000));
      await ctx.settleOk([await ctx.trade(alice, bob, wad(100), BTC_PRICE)]);
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad("0.001"), BTC_PRICE))).to.equal("OpenInterestCapExceeded");
      // a transfer of exposure (carol replaces alice) does not add open interest
      await ctx.settleOk([await ctx.trade(carol, alice, wad(40), BTC_PRICE)]);
      expect(await exchange.openInterest(BTC)).to.deep.equal([wad(100), wad(100)]);

      await exchange.updateMarket(BTC, marketConfig("BTC-USD", { maxOpenInterest: wad(10) }));
      expect(await ctx.settleError(await ctx.trade(carol, alice, wad(1), BTC_PRICE))).to.equal("");
      await ctx.settleOk([await ctx.trade(bob, alice, wad(50), BTC_PRICE)]);
      expect(await exchange.openInterest(BTC)).to.deep.equal([wad(50), wad(50)]);
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad(1), BTC_PRICE))).to.equal("OpenInterestCapExceeded");
    });
  });

  describe("PnL", () => {
    it("long profit / short loss are realized on close", async () => {
      const { exchange, oracle, ctx, alice, bob, token } = await openFixture();
      await oracle.setPrice(BTC, wad(55_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(24_990));
      expect(await exchange.accountValue(bob.address)).to.equal(usdc(14_975));
      // unrealized: balances unchanged
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(19_990));

      // close both against each other at 55,000 (bob maker)
      await ctx.settleOk([await ctx.trade(bob, alice, ONE, wad(55_000))]);
      // alice: +5,000, taker fee 27.5; bob: -5,000, maker fee 11
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("24962.5"));
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc(14_964));
      for (const s of [alice, bob]) {
        const p = await exchange.getPosition(s.address, BTC);
        expect(p.size).to.equal(0);
        expect(p.entryNotional).to.equal(0);
        expect(await exchange.accountValue(s.address)).to.equal(await exchange.balanceOf(s.address));
      }
      expect(await exchange.openInterest(BTC)).to.deep.equal([0n, 0n]);
      // everything is withdrawable and the books balance exactly
      await exchange.connect(alice).withdraw(usdc("24962.5"));
      await exchange.connect(bob).withdraw(usdc(14_964));
      expect(await token.balanceOf(await exchange.getAddress())).to.equal(usdc("73.5")); // the fees
    });

    it("long loss / short profit", async () => {
      const { exchange, oracle, ctx, alice, bob } = await openFixture();
      await oracle.setPrice(BTC, wad(47_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(16_990));
      expect(await exchange.accountValue(bob.address)).to.equal(usdc(22_975));
      await ctx.settleOk([await ctx.trade(bob, alice, ONE, wad(47_000), { makerIsSeller: true })]);
      // alice sells as maker: -3,000 - 9.4 ; bob buys as taker: +3,000 - 23.5
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("16980.6"));
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc("22951.5"));
    });

    it("partial close realizes the proportional share of the entry", async () => {
      const { exchange, oracle, ctx, alice, bob } = await openFixture();
      await oracle.setPrice(BTC, wad(54_000));
      await ctx.settleOk([await ctx.trade(bob, alice, wad("0.25"), wad(54_000))]);
      const pa = await exchange.getPosition(alice.address, BTC);
      expect(pa.size).to.equal(wad("0.75"));
      expect(pa.entryNotional).to.equal(usdc(37_500));
      // +1,000 realized, taker fee 6.75
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("20983.25"));
      // remaining unrealized: 0.75 * 4,000
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("23983.25"));
      const pb = await exchange.getPosition(bob.address, BTC);
      expect(pb.size).to.equal(-wad("0.75"));
      expect(pb.entryNotional).to.equal(usdc(37_500));
    });

    it("increasing a position accumulates entry notional", async () => {
      const { exchange, oracle, ctx, alice, bob } = await openFixture();
      await exchange.connect(alice).deposit(usdc(20_000));
      await exchange.connect(bob).deposit(usdc(20_000));
      await oracle.setPrice(BTC, wad(52_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(52_000))]);
      const pa = await exchange.getPosition(alice.address, BTC);
      expect(pa.size).to.equal(wad(2));
      expect(pa.entryNotional).to.equal(usdc(102_000));
      // unrealized = 2 * 52,000 - 102,000 = 2,000 ; fees 10 + 10.4
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("41979.6"));
    });

    it("flips long -> short and short -> long in one fill", async () => {
      const { exchange, oracle, ctx, alice, bob } = await openFixture();
      await exchange.connect(bob).deposit(usdc(10_000));
      await oracle.setPrice(BTC, wad(52_000));
      // alice (long 1) sells 3 as taker, bob (short 1) buys 3 as maker
      await ctx.settleOk([await ctx.trade(bob, alice, wad(3), wad(52_000))]);

      const pa = await exchange.getPosition(alice.address, BTC);
      expect(pa.size).to.equal(-wad(2));
      expect(pa.entryNotional).to.equal(usdc(104_000));
      // realized +2,000 on the closed long, taker fee 78 on the whole 156,000
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(21_912));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(21_912));

      const pb = await exchange.getPosition(bob.address, BTC);
      expect(pb.size).to.equal(wad(2));
      expect(pb.entryNotional).to.equal(usdc(104_000));
      // 29,975 - 2,000 - 31.2
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc("27943.8"));
      expect(await exchange.openInterest(BTC)).to.deep.equal([wad(2), wad(2)]);

      // the new positions carry PnL from the flip price
      await oracle.setPrice(BTC, wad(51_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(23_912));
      expect(await exchange.accountValue(bob.address)).to.equal(usdc("25943.8"));
    });

    it("a flip needs initial margin for the new position", async () => {
      const { ctx, alice, bob, exchange } = await openFixture();
      await exchange.connect(bob).deposit(usdc(100_000));
      // alice: ~19,990. Short 2.5 after the flip would need 25,000.
      expect(await ctx.settleError(await ctx.trade(bob, alice, wad("3.5"), BTC_PRICE))).to.equal("InsufficientMargin");
    });

    it("rounds notional up for the buyer and down for the seller, fees up", async () => {
      const { exchange, oracle, ctx, alice, bob, feeRecipient } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(20_000));
      await exchange.connect(bob).deposit(usdc(20_000));
      const size = 333333333333333333n;
      const price = 50_000_123456789012345678n;
      await ctx.settleOk([await ctx.trade(alice, bob, size, price)]);
      const up = notionalUp(size, price);
      const down = notionalDown(size, price);
      expect(up).to.equal(down + 1n);
      expect((await exchange.getPosition(alice.address, BTC)).entryNotional).to.equal(up);
      expect((await exchange.getPosition(bob.address, BTC)).entryNotional).to.equal(down);
      const makerFee = feeOf(size, price, 2n);
      const takerFee = feeOf(size, price, 5n);
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(20_000) - makerFee);
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc(20_000) - takerFee);
      expect(await exchange.balanceOf(feeRecipient.address)).to.equal(makerFee + takerFee);

      // At the very same price both sides show a (tiny) loss, never a gain.
      await oracle.setPrice(BTC, price);
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(20_000) - makerFee - 1n);
      expect(await exchange.accountValue(bob.address)).to.equal(usdc(20_000) - takerFee - 1n);
    });
  });

  describe("funding", () => {
    /** alice long 1 / bob short 1 opened at `fillPrice` while the index is 50,000. */
    async function fundingFixture(fillPrice: bigint) {
      const f = await loadFixture(deployFixture);
      await f.exchange.connect(f.alice).deposit(usdc(20_000));
      await f.exchange.connect(f.bob).deposit(usdc(20_000));
      await f.ctx.settleOk([await f.ctx.trade(f.alice, f.bob, ONE, fillPrice)]);
      const t0 = Number(await f.exchange.lastFundingTime(BTC));
      /** Refreshes the index price and accrues funding exactly `seconds` after the last accrual. */
      const accrueAt = async (seconds: number, index: bigint = BTC_PRICE) => {
        await time.setNextBlockTimestamp(t0 + seconds - 1);
        await f.oracle.setPrice(BTC, index);
        await time.setNextBlockTimestamp(t0 + seconds);
        return f.exchange.updateFunding(BTC);
      };
      return { ...f, t0, accrueAt };
    }

    it("is a no-op before the interval has passed", async () => {
      const { exchange, accrueAt, t0 } = await fundingFixture(wad(50_500));
      await expect(accrueAt(HOUR - 1)).to.not.emit(exchange, "FundingUpdated");
      expect(await exchange.cumulativeFunding(BTC)).to.equal(0);
      expect(await exchange.lastFundingTime(BTC)).to.equal(t0);
      await expect(exchange.updateFunding(5)).to.be.revertedWithCustomError(exchange, "UnknownMarket");
    });

    it("mark above index: longs pay shorts, rate capped", async () => {
      const { exchange, ctx, alice, bob, carol, accrueAt, t0 } = await fundingFixture(wad(50_500));
      // premium 1% -> capped at 10 bps -> 50 USD per BTC per hour
      await expect(accrueAt(HOUR))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 10, wad(50), t0 + HOUR);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad(50));
      expect(await exchange.lastFundingTime(BTC)).to.equal(t0 + HOUR);

      // pending funding is part of the account value: entry 50,500 vs index 50,000
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("19439.9")); // 20,000 - 10.1 - 500 - 50
      expect(await exchange.accountValue(bob.address)).to.equal(usdc("20524.75")); // 20,000 - 25.25 + 500 + 50
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("19989.9")); // not settled yet

      // touching the position settles funding into the balance
      await exchange.connect(carol).deposit(usdc(20_000));
      await ctx.settleOk([await ctx.trade(carol, alice, wad("0.5"), BTC_PRICE, { makerIsSeller: true })]);
      // -50 funding, -250 realized, -5 maker fee
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("19684.9"));
      expect((await exchange.getPosition(alice.address, BTC)).lastCumulativeFunding).to.equal(wad(50));
      // carol opened after the accrual and owes nothing
      expect((await exchange.getPosition(carol.address, BTC)).lastCumulativeFunding).to.equal(wad(50));
      expect(await exchange.accountValue(carol.address)).to.equal(usdc("19987.5"));
      // bob untouched
      expect((await exchange.getPosition(bob.address, BTC)).lastCumulativeFunding).to.equal(0);
      expect(await exchange.accountValue(bob.address)).to.equal(usdc("20524.75"));
    });

    it("mark below index: shorts pay longs", async () => {
      const { exchange, alice, bob, accrueAt, t0 } = await fundingFixture(wad(49_900));
      // premium -0.2% -> capped at -10 bps
      await expect(accrueAt(HOUR))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, -10, -wad(50), t0 + HOUR);
      expect(await exchange.accountValue(alice.address)).to.equal(usdc("20140.02")); // 20,000 - 9.98 + 100 + 50
      expect(await exchange.accountValue(bob.address)).to.equal(usdc("19825.05")); // 20,000 - 24.95 - 100 - 50
    });

    it("uses the uncapped premium when it is inside the cap", async () => {
      const { exchange, accrueAt, t0 } = await fundingFixture(wad(50_025));
      // premium 5 bps
      await expect(accrueAt(HOUR))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 5, wad(25), t0 + HOUR);
    });

    it("no premium, no funding", async () => {
      const { exchange, accrueAt, t0 } = await fundingFixture(wad(50_000));
      await expect(accrueAt(HOUR)).to.emit(exchange, "FundingUpdated").withArgs(BTC, 0, 0, t0 + HOUR);
    });

    it("charges pro rata for the elapsed time, up to 8 hours", async () => {
      const a = await fundingFixture(wad(50_500));
      await a.accrueAt(HOUR + HOUR / 2);
      expect(await a.exchange.cumulativeFunding(BTC)).to.equal(wad(75));
      // second accrual one hour later adds another 50
      await a.accrueAt(2 * HOUR + HOUR / 2);
      expect(await a.exchange.cumulativeFunding(BTC)).to.equal(wad(125));

      const b = await fundingFixture(wad(50_500));
      await b.accrueAt(20 * HOUR);
      expect(await b.exchange.cumulativeFunding(BTC)).to.equal(wad(400));
    });

    it("uses the index price at accrual time", async () => {
      const { exchange, accrueAt } = await fundingFixture(wad(50_500));
      // index moved to 50,480: premium ~3.96 bps
      await accrueAt(HOUR, wad(50_480));
      const rateWad = ((wad(50_500) - wad(50_480)) * 10n ** 18n) / wad(50_480);
      expect(await exchange.cumulativeFunding(BTC)).to.equal((wad(50_480) * rateWad) / 10n ** 18n);
    });

    it("a stale or broken oracle accrues nothing but still advances the clock", async () => {
      const { exchange, oracle, t0 } = await fundingFixture(wad(50_500));
      await time.setNextBlockTimestamp(t0 + MAX_PRICE_AGE + 100);
      await expect(exchange.updateFunding(BTC))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 0, 0, t0 + MAX_PRICE_AGE + 100);
      expect(await exchange.lastFundingTime(BTC)).to.equal(t0 + MAX_PRICE_AGE + 100);

      await oracle.setBroken(true);
      await time.increase(HOUR);
      await expect(exchange.updateFunding(BTC)).to.emit(exchange, "FundingUpdated");
      expect(await exchange.cumulativeFunding(BTC)).to.equal(0);
    });

    it("a market that never traded accrues nothing", async () => {
      const { exchange, oracle } = await loadFixture(deployFixture);
      await time.increase(HOUR);
      await oracle.setPrice(ETH, wad(2_000));
      await expect(exchange.updateFunding(ETH)).to.emit(exchange, "FundingUpdated");
      expect(await exchange.cumulativeFunding(ETH)).to.equal(0);
    });

    it("fills accrue funding first, at the mark before the fill", async () => {
      const { exchange, oracle, ctx, alice, bob, t0 } = await fundingFixture(wad(50_500));
      await time.setNextBlockTimestamp(t0 + HOUR - 1);
      await oracle.setPrice(BTC, BTC_PRICE);
      const m = await ctx.trade(bob, alice, ONE, wad(49_000)); // closes both, would set a negative premium
      await time.setNextBlockTimestamp(t0 + HOUR);
      await expect(ctx.settle([m])).to.emit(exchange, "FundingUpdated").withArgs(BTC, 10, wad(50), t0 + HOUR);
      // alice: 20,000 - 10.1 (fee) - 50 (funding) - 1,500 (pnl) - 24.5 (taker fee)
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("18415.4"));
      // bob: 20,000 - 25.25 + 50 + 1,500 - 9.8
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc("21514.95"));
    });

    it("rounds funding against each trader", async () => {
      const f = await loadFixture(deployFixture);
      await f.exchange.connect(f.alice).deposit(usdc(20_000));
      await f.exchange.connect(f.bob).deposit(usdc(20_000));
      const size = 333333333333333333n;
      await f.ctx.settleOk([await f.ctx.trade(f.alice, f.bob, size, wad(50_500))]);
      const t0 = Number(await f.exchange.lastFundingTime(BTC));
      const va = await f.exchange.accountValue(f.alice.address);
      const vb = await f.exchange.accountValue(f.bob.address);
      await time.setNextBlockTimestamp(t0 + HOUR - 1);
      await f.oracle.setPrice(BTC, BTC_PRICE);
      await time.setNextBlockTimestamp(t0 + HOUR);
      await f.exchange.updateFunding(BTC);
      // exact funding = 0.333333333333333333 * 50 = 16.66666666666666665 USDC
      expect(va - (await f.exchange.accountValue(f.alice.address))).to.equal(16_666_667n); // pays the ceiling
      expect((await f.exchange.accountValue(f.bob.address)) - vb).to.equal(16_666_666n); // receives the floor
    });
  });

  describe("liquidation", () => {
    it("a healthy account cannot be liquidated", async () => {
      const { exchange, oracle, alice, liquidator } = await leveragedFixture();
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
      // value 5,090 vs maintenance 4,500: under initial margin but not liquidatable
      await oracle.setPrice(BTC, wad(45_000));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
    });

    it("the boundary is strict: value == maintenance is safe, one unit less is not", async () => {
      const { exchange, oracle, alice } = await leveragedFixture();
      // value = 10,090 - (50,000 - p), maintenance = p / 10  =>  equal at p = 44,344.444...
      // p = 44,344.5: value = 4,434.5 ; maintenance = 4,434.45
      await oracle.setPrice(BTC, wad("44344.5"));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      await oracle.setPrice(BTC, wad("44344.4"));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);
    });

    it("basic argument checks", async () => {
      const { exchange, oracle, alice, bob, liquidator } = await leveragedFixture();
      await oracle.setPrice(BTC, wad(44_000));
      await expect(exchange.connect(alice).liquidate(alice.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "SelfLiquidation");
      await expect(exchange.connect(liquidator).liquidate(alice.address, 9, MAX)).to.be.revertedWithCustomError(exchange, "UnknownMarket");
      await expect(exchange.connect(liquidator).liquidate(alice.address, ETH, MAX)).to.be.revertedWithCustomError(exchange, "NoPosition");
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, 0)).to.be.revertedWithCustomError(exchange, "ZeroAmount");
      await expect(exchange.connect(liquidator).liquidate(bob.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
    });

    it("full liquidation of a long: liquidator takes the position, penalty is split", async () => {
      const { exchange, oracle, alice, bob, liquidator } = await leveragedFixture();
      await oracle.setPrice(BTC, wad(44_000));
      // value 4,090 < maintenance 4,400
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX))
        .to.emit(exchange, "Liquidation")
        .withArgs(BTC, alice.address, liquidator.address, ONE, wad(44_000), usdc(660), 0);

      const pa = await exchange.getPosition(alice.address, BTC);
      expect(pa.size).to.equal(0);
      expect(pa.entryNotional).to.equal(0);
      // 10,090 - 6,000 loss - 660 penalty (1.5% of 44,000)
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(3_430));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);

      const pl = await exchange.getPosition(liquidator.address, BTC);
      expect(pl.size).to.equal(ONE);
      expect(pl.entryNotional).to.equal(usdc(44_000));
      expect(await exchange.balanceOf(liquidator.address)).to.equal(usdc(100_330));
      expect(await exchange.accountValue(liquidator.address)).to.equal(usdc(100_330));
      expect(await exchange.insuranceFund()).to.equal(usdc(330));
      expect(await exchange.totalBadDebt()).to.equal(0);
      // open interest unchanged: the long moved to the liquidator
      expect(await exchange.openInterest(BTC)).to.deep.equal([ONE, ONE]);
      expect((await exchange.getPosition(bob.address, BTC)).size).to.equal(-ONE);
      // the mark price is not affected by liquidations
      expect(await exchange.markPrice(BTC)).to.equal(BTC_PRICE);
      // alice can leave with what is left
      await exchange.connect(alice).withdraw(usdc(3_430));
    });

    it("partial liquidation", async () => {
      const { exchange, oracle, alice, liquidator } = await leveragedFixture();
      await oracle.setPrice(BTC, wad(44_000));
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, wad("0.4")))
        .to.emit(exchange, "Liquidation")
        .withArgs(BTC, alice.address, liquidator.address, wad("0.4"), wad(44_000), usdc(264), 0);

      const pa = await exchange.getPosition(alice.address, BTC);
      expect(pa.size).to.equal(wad("0.6"));
      expect(pa.entryNotional).to.equal(usdc(30_000));
      // 10,090 - 2,400 realized - 264 penalty
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(7_426));
      // value = 7,426 - 3,600 = 3,826 >= maintenance 2,640: healthy again
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(3_826));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
      expect(await exchange.insuranceFund()).to.equal(usdc(132));
      expect(await exchange.balanceOf(liquidator.address)).to.equal(usdc(100_132));
      expect((await exchange.getPosition(liquidator.address, BTC)).size).to.equal(wad("0.4"));
    });

    it("liquidation of a short", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(40_000));
      await exchange.connect(bob).deposit(usdc(10_100));
      await exchange.connect(liquidator).deposit(usdc(100_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]); // bob short, balance 10,075
      await oracle.setPrice(BTC, wad(56_000));
      // value 4,075 < maintenance 5,600
      await expect(exchange.connect(liquidator).liquidate(bob.address, BTC, MAX))
        .to.emit(exchange, "Liquidation")
        .withArgs(BTC, bob.address, liquidator.address, -ONE, wad(56_000), usdc(840), 0);
      expect(await exchange.balanceOf(bob.address)).to.equal(usdc(3_235));
      const pl = await exchange.getPosition(liquidator.address, BTC);
      expect(pl.size).to.equal(-ONE);
      expect(pl.entryNotional).to.equal(usdc(56_000));
      expect(await exchange.insuranceFund()).to.equal(usdc(420));
    });

    it("settles pending funding of the liquidated position", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(10_700));
      await exchange.connect(bob).deposit(usdc(40_000));
      await exchange.connect(liquidator).deposit(usdc(100_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, wad(50_500))]); // balance 10,689.9
      const t0 = Number(await exchange.lastFundingTime(BTC));
      await time.setNextBlockTimestamp(t0 + HOUR - 1);
      await oracle.setPrice(BTC, wad(44_000));
      await time.setNextBlockTimestamp(t0 + HOUR);
      // liquidate() accrues: rate capped at 10 bps of the 44,000 index = 44 USD
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect(await exchange.cumulativeFunding(BTC)).to.equal(wad(44));
      // 10,689.9 - 44 funding - 6,500 loss - 660 penalty
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc("3485.9"));
      // the liquidator's new position starts at the current funding index
      expect((await exchange.getPosition(liquidator.address, BTC)).lastCumulativeFunding).to.equal(wad(44));
      expect(await exchange.accountValue(liquidator.address)).to.equal(usdc(100_330));
    });

    it("the liquidator needs margin for what it takes over, unless it reduces its own position", async () => {
      const { exchange, oracle, alice, bob, carol, liquidator } = await leveragedFixture();
      await oracle.setPrice(BTC, wad(43_000));
      await exchange.connect(carol).deposit(usdc(1_000));
      await expect(exchange.connect(carol).liquidate(alice.address, BTC, MAX))
        .to.be.revertedWithCustomError(exchange, "InsufficientMargin")
        .withArgs(carol.address);
      // carol can afford a small slice: 0.1 BTC needs 860 (and she earns half the 64.5 penalty)
      await exchange.connect(carol).liquidate(alice.address, BTC, wad("0.1"));
      expect((await exchange.getPosition(carol.address, BTC)).size).to.equal(wad("0.1"));
      expect(await exchange.balanceOf(carol.address)).to.equal(usdc("1032.25"));

      // alice is still under maintenance. bob is short 1: taking over the long closes his short instead.
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);
      await exchange.connect(bob).liquidate(alice.address, BTC, MAX);
      expect((await exchange.getPosition(bob.address, BTC)).size).to.equal(-wad("0.1"));
      expect(await exchange.openInterest(BTC)).to.deep.equal([wad("0.1"), wad("0.1")]);
      void liquidator;
    });

    it("the penalty is capped at the account's remaining value", async () => {
      const { exchange, oracle, alice, liquidator } = await leveragedFixture();
      // value = 10,090 - 9,800 = 290 ; uncapped penalty = 603
      await oracle.setPrice(BTC, wad(40_200));
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX))
        .to.emit(exchange, "Liquidation")
        .withArgs(BTC, alice.address, liquidator.address, ONE, wad(40_200), usdc(290), 0);
      expect(await exchange.balanceOf(alice.address)).to.equal(0);
      expect(await exchange.insuranceFund()).to.equal(usdc(145));
      expect(await exchange.totalBadDebt()).to.equal(0);
    });

    it("bad debt with an empty insurance fund", async () => {
      const { exchange, oracle, token, alice, bob, liquidator } = await leveragedFixture();
      await oracle.setPrice(BTC, wad(38_000));
      // value = 10,090 - 12,000 = -1,910
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(-1_910));
      const tx = exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      await expect(tx).to.emit(exchange, "Liquidation").withArgs(BTC, alice.address, liquidator.address, ONE, wad(38_000), 0, usdc(1_910));
      await expect(tx).to.emit(exchange, "DeficitAbsorbed").withArgs(alice.address, 0, usdc(1_910));
      expect(await exchange.balanceOf(alice.address)).to.equal(0);
      expect(await exchange.accountValue(alice.address)).to.equal(0);
      expect(await exchange.totalBadDebt()).to.equal(usdc(1_910));
      expect(await exchange.insuranceFund()).to.equal(0);
      // no reward for the liquidator
      expect(await exchange.balanceOf(liquidator.address)).to.equal(usdc(100_000));

      // The shortfall is real: claims exceed the USDC held by exactly the bad debt.
      const held = await token.balanceOf(await exchange.getAddress());
      let claims = 0n;
      for (const s of [alice, bob, liquidator]) claims += await exchange.accountValue(s.address);
      claims += await exchange.balanceOf(await exchange.feeRecipient());
      expect(claims - held).to.equal(usdc(1_910));
    });

    it("bad debt is covered by the insurance fund first", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(10_100));
      await exchange.connect(carol).deposit(usdc(10_100));
      await exchange.connect(bob).deposit(usdc(80_000));
      await exchange.connect(liquidator).deposit(usdc(200_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE), await ctx.trade(carol, bob, ONE, BTC_PRICE)]);

      await oracle.setPrice(BTC, wad(44_000));
      await exchange.connect(liquidator).liquidate(carol.address, BTC, MAX);
      expect(await exchange.insuranceFund()).to.equal(usdc(330));

      await oracle.setPrice(BTC, wad(38_000));
      const tx = exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      await expect(tx).to.emit(exchange, "Liquidation").withArgs(BTC, alice.address, liquidator.address, ONE, wad(38_000), 0, usdc(1_580));
      await expect(tx).to.emit(exchange, "DeficitAbsorbed").withArgs(alice.address, usdc(330), usdc(1_580));
      expect(await exchange.insuranceFund()).to.equal(0);
      expect(await exchange.totalBadDebt()).to.equal(usdc(1_580));
      expect(await exchange.balanceOf(alice.address)).to.equal(0);
    });

    it("insurance fund fully covers a small deficit", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(10_100));
      await exchange.connect(carol).deposit(usdc(10_100));
      await exchange.connect(bob).deposit(usdc(80_000));
      await exchange.connect(liquidator).deposit(usdc(200_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE), await ctx.trade(carol, bob, ONE, BTC_PRICE)]);
      await oracle.setPrice(BTC, wad(44_000));
      await exchange.connect(liquidator).liquidate(carol.address, BTC, MAX);
      await oracle.setPrice(BTC, wad(39_810)); // alice: 10,090 - 10,190 = -100
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX))
        .to.emit(exchange, "DeficitAbsorbed")
        .withArgs(alice.address, usdc(100), 0);
      expect(await exchange.insuranceFund()).to.equal(usdc(230));
      expect(await exchange.totalBadDebt()).to.equal(0);
    });

    it("an underwater account with two positions is only written off after the last one", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, liquidator } = f;
      await exchange.connect(alice).deposit(usdc(12_600));
      await exchange.connect(bob).deposit(usdc(80_000));
      await exchange.connect(liquidator).deposit(usdc(200_000));
      await ctx.settleOk([
        await ctx.trade(alice, bob, ONE, BTC_PRICE),
        await ctx.trade(alice, bob, wad(5), wad(2_000), { marketId: ETH }),
      ]);
      // balance 12,600 - 10 - 2 = 12,588
      await oracle.setPrice(BTC, wad(36_000)); // -14,000
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(-1_412));

      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX))
        .to.emit(exchange, "Liquidation")
        .withArgs(BTC, alice.address, liquidator.address, ONE, wad(36_000), 0, 0);
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(-1_412));
      expect(await exchange.totalBadDebt()).to.equal(0);
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);

      await expect(exchange.connect(liquidator).liquidate(alice.address, ETH, MAX))
        .to.emit(exchange, "Liquidation")
        .withArgs(ETH, alice.address, liquidator.address, wad(5), wad(2_000), 0, usdc(1_412));
      expect(await exchange.balanceOf(alice.address)).to.equal(0);
      expect(await exchange.totalBadDebt()).to.equal(usdc(1_412));
    });
  });

  describe("pause", () => {
    it("only the owner pauses; Paused is emitted", async () => {
      const { exchange } = await loadFixture(deployFixture);
      await expect(exchange.setPaused(true)).to.emit(exchange, "Paused").withArgs(true);
      expect(await exchange.paused()).to.equal(true);
      await expect(exchange.setPaused(false)).to.emit(exchange, "Paused").withArgs(false);
      expect(await exchange.paused()).to.equal(false);
    });

    it("blocks position-increasing fills; everything else stays open", async () => {
      const { exchange, oracle, ctx, alice, bob, carol, liquidator } = await leveragedFixture();
      await exchange.connect(carol).deposit(usdc(50_000));
      await exchange.setPaused(true);

      // deposits stay open: liquidations do too, so traders must be able to add margin
      await expect(exchange.connect(alice).deposit(usdc(1))).to.emit(exchange, "Deposit");

      // increasing, opening (carol), flipping: all blocked
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad("0.1"), BTC_PRICE))).to.equal("OnlyReducingAllowed");
      expect(await ctx.settleError(await ctx.trade(carol, alice, wad("0.1"), BTC_PRICE))).to.equal("OnlyReducingAllowed");
      expect(await ctx.settleError(await ctx.trade(bob, alice, wad(2), BTC_PRICE))).to.equal("OnlyReducingAllowed");
      // both sides reduce: allowed
      await ctx.settleOk([await ctx.trade(bob, alice, wad("0.25"), BTC_PRICE)]);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(wad("0.75"));

      // cancel, withdraw, funding
      await exchange.connect(alice).cancelOrder(1);
      await exchange.connect(bob).withdraw(usdc(1_000));
      await exchange.updateFunding(BTC);

      // an account near maintenance can save itself by depositing while paused
      await oracle.setPrice(BTC, wad(40_500));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(true);
      await exchange.connect(alice).deposit(usdc(1_000));
      expect(await exchange.isLiquidatable(alice.address)).to.equal(false);

      // liquidation
      await oracle.setPrice(BTC, wad(39_000));
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(0);

      await exchange.setPaused(false);
      await exchange.connect(alice).deposit(usdc(1));
    });

    it("an inactive market is reduce-only too", async () => {
      const { exchange, ctx, alice, bob, liquidator, oracle } = await leveragedFixture();
      await exchange.updateMarket(BTC, marketConfig("BTC-USD", { active: false }));
      expect(await ctx.settleError(await ctx.trade(alice, bob, wad("0.1"), BTC_PRICE))).to.equal("OnlyReducingAllowed");
      await ctx.settleOk([await ctx.trade(bob, alice, wad("0.5"), BTC_PRICE)]);
      // other markets are unaffected
      await ctx.settleOk([await ctx.trade(bob, liquidator, wad(1), wad(2_000), { marketId: ETH })]);
      // liquidations still work
      await oracle.setPrice(BTC, wad(28_000));
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(0);
    });
  });

  describe("stale oracle", () => {
    async function staleFixture() {
      const f = await leveragedFixture();
      await f.exchange.connect(f.carol).deposit(usdc(50_000));
      // a price that would make alice liquidatable, then let it go stale
      await f.oracle.setPrice(BTC, wad(44_000));
      await time.increase(MAX_PRICE_AGE + 1);
      return f;
    }

    it("a price is fresh up to and including maxPriceAge, and never from the future", async () => {
      const { exchange, oracle } = await loadFixture(deployFixture);
      await oracle.setPrice(BTC, BTC_PRICE);
      const t = await time.latest();
      await time.increaseTo(t + MAX_PRICE_AGE);
      expect(await exchange.indexPrice(BTC)).to.equal(BTC_PRICE);
      await time.increaseTo(t + MAX_PRICE_AGE + 1);
      await expect(exchange.indexPrice(BTC)).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(BTC);

      const now = await time.latest();
      await oracle.setPriceAt(BTC, BTC_PRICE, now + 1_000);
      await expect(exchange.indexPrice(BTC)).to.be.revertedWithCustomError(exchange, "StalePrice").withArgs(BTC);
      await oracle.setPriceAt(BTC, BTC_PRICE, now);
      expect(await exchange.indexPrice(BTC)).to.equal(BTC_PRICE);
    });

    it("views that depend on a stale price revert, others work", async () => {
      const { exchange, alice, carol } = await staleFixture();
      await expect(exchange.accountValue(alice.address)).to.be.revertedWithCustomError(exchange, "StalePrice");
      await expect(exchange.marginRequirement(alice.address)).to.be.revertedWithCustomError(exchange, "StalePrice");
      await expect(exchange.freeCollateral(alice.address)).to.be.revertedWithCustomError(exchange, "StalePrice");
      await expect(exchange.isLiquidatable(alice.address)).to.be.revertedWithCustomError(exchange, "StalePrice");
      expect(await exchange.accountValue(carol.address)).to.equal(usdc(50_000));
      expect(await exchange.balanceOf(alice.address)).to.equal(usdc(10_090));
    });

    it("blocks liquidations and every fill, including reductions and full closes", async () => {
      const { exchange, ctx, alice, bob, carol, liquidator } = await staleFixture();
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX)).to.be.revertedWithCustomError(exchange, "StalePrice");
      expect(await ctx.settleError(await ctx.trade(carol, bob, wad("0.1"), wad(44_000)))).to.equal("StalePrice");
      expect(await ctx.settleError(await ctx.trade(bob, alice, wad(2), wad(44_000)))).to.equal("StalePrice");
      expect(await ctx.settleError(await ctx.trade(bob, alice, wad("0.5"), wad(44_000)))).to.equal("StalePrice");
      expect(await ctx.settleError(await ctx.trade(bob, alice, ONE, wad(44_000)))).to.equal("StalePrice");
      expect((await exchange.getPosition(alice.address, BTC)).size).to.equal(ONE);
    });

    it("a stale price in another market blocks fills of accounts exposed to it", async () => {
      const f = await loadFixture(deployFixture);
      const { exchange, oracle, ctx, alice, bob, carol } = f;
      for (const s of [alice, bob, carol]) await exchange.connect(s).deposit(usdc(50_000));
      await ctx.settleOk([
        await ctx.trade(alice, bob, ONE, BTC_PRICE),
        await ctx.trade(alice, bob, wad(1), wad(2_000), { marketId: ETH }),
      ]);
      await time.increase(MAX_PRICE_AGE + 1);
      await oracle.setPrice(BTC, BTC_PRICE); // BTC fresh, ETH stale
      expect(await ctx.settleError(await ctx.trade(bob, alice, wad("0.5"), BTC_PRICE))).to.equal("StalePrice");
      await oracle.setPrice(ETH, wad(2_000));
      expect(await ctx.settleError(await ctx.trade(bob, alice, wad("0.5"), BTC_PRICE))).to.equal("");
    });

    it("cancel and, for flat accounts, withdraw still work", async () => {
      const { exchange, alice, carol } = await staleFixture();
      await expect(exchange.connect(alice).withdraw(1)).to.be.revertedWithCustomError(exchange, "StalePrice");
      await exchange.connect(alice).cancelOrder(1);
      await exchange.connect(carol).withdraw(usdc(50_000));
      await exchange.connect(carol).deposit(usdc(1));
    });

    it("a reverting oracle blocks fills, but not flat accounts", async () => {
      const { exchange, oracle, ctx, alice, bob, carol } = await staleFixture();
      await oracle.setBroken(true);
      expect(await ctx.settleError(await ctx.trade(bob, alice, ONE, wad(44_000)))).to.equal("OracleBroken");
      await exchange.connect(carol).withdraw(usdc(50_000));
    });

    it("a market without a price cannot be traded", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.addMarket(marketConfig("SOL-USD"));
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      expect(await ctx.settleError(await ctx.trade(alice, bob, ONE, wad(100), { marketId: 2 }))).to.equal("PriceNotSet");
    });
  });

  describe("reentrancy", () => {
    it("guards the state-changing entry points", async () => {
      const f = await loadFixture(deployFixture);
      const Token = await ethers.getContractFactory("ReentrantToken");
      const evil = await Token.deploy();
      const exchange2 = await (
        await ethers.getContractFactory("Exchange")
      ).deploy(await evil.getAddress(), await f.oracle.getAddress(), f.owner.address, f.feeRecipient.address, MAX_PRICE_AGE, 10, 500);
      await evil.mint(f.alice.address, usdc(1_000));
      await evil.connect(f.alice).approve(await exchange2.getAddress(), MAX);
      await exchange2.connect(f.alice).deposit(usdc(500));

      // During the token transfer of a deposit the token calls back into the exchange.
      for (const data of [
        exchange2.interface.encodeFunctionData("withdraw", [1]),
        exchange2.interface.encodeFunctionData("deposit", [1]),
        exchange2.interface.encodeFunctionData("settleMatches", [[]]),
        exchange2.interface.encodeFunctionData("liquidate", [f.bob.address, 0, 1]),
      ]) {
        await evil.arm(await exchange2.getAddress(), data);
        await expect(exchange2.connect(f.alice).deposit(usdc(1))).to.be.revertedWithCustomError(exchange2, "ReentrancyGuardReentrantCall");
      }
      await evil.disarm();
      await exchange2.connect(f.alice).deposit(usdc(1));
    });
  });
});
