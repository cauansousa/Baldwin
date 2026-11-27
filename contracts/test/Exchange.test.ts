import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
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
  startNewFundingPeriodAtNextFill,
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

    it("the guardian can pause but not unpause", async () => {
      const { exchange, owner, stranger, carol: guardian } = await loadFixture(deployFixture);
      expect(await exchange.guardian()).to.equal(ethers.ZeroAddress);
      await expect(exchange.connect(stranger).setGuardian(stranger.address)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await expect(exchange.connect(guardian).setPaused(true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount").withArgs(guardian.address);
      await expect(exchange.setGuardian(guardian.address)).to.emit(exchange, "GuardianUpdated").withArgs(guardian.address);
      expect(await exchange.guardian()).to.equal(guardian.address);

      await expect(exchange.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await expect(exchange.connect(guardian).setPaused(true)).to.emit(exchange, "Paused").withArgs(true);
      expect(await exchange.paused()).to.equal(true);
      // pausing again is harmless; unpausing is the owner's call
      await exchange.connect(guardian).setPaused(true);
      await expect(exchange.connect(guardian).setPaused(false)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount").withArgs(guardian.address);
      await expect(exchange.connect(stranger).setPaused(false)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      expect(await exchange.paused()).to.equal(true);
      await exchange.connect(owner).setPaused(false);
      expect(await exchange.paused()).to.equal(false);
      // the guardian has no other power
      await expect(exchange.connect(guardian).setOperator(guardian.address, true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await expect(exchange.connect(guardian).setGuardian(stranger.address)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");

      // removing the guardian
      await expect(exchange.setGuardian(ethers.ZeroAddress)).to.emit(exchange, "GuardianUpdated").withArgs(ethers.ZeroAddress);
      await expect(exchange.connect(guardian).setPaused(true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      // the owner pauses and unpauses as before
      await exchange.setPaused(true);
      await exchange.setPaused(false);
    });

    it("ownership cannot be renounced", async () => {
      const { exchange, owner, stranger } = await loadFixture(deployFixture);
      await expect(exchange.renounceOwnership()).to.be.revertedWithCustomError(exchange, "RenounceDisabled");
      await expect(exchange.connect(stranger).renounceOwnership()).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      expect(await exchange.owner()).to.equal(owner.address);
    });

    it("the owner can replace the oracle", async () => {
      const { exchange, oracle, stranger, ctx, alice, bob } = await loadFixture(deployFixture);
      const other = await (await ethers.getContractFactory("MockOracle")).deploy();
      const otherAddress = await other.getAddress();
      await expect(exchange.connect(stranger).setOracle(otherAddress)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
      await expect(exchange.setOracle(ethers.ZeroAddress)).to.be.revertedWithCustomError(exchange, "ZeroAddress");
      await expect(exchange.setOracle(stranger.address)).to.be.revertedWithCustomError(exchange, "NotAContract");

      // the scenario it exists for: the current oracle reverts for good
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      await ctx.settleOk([await ctx.trade(alice, bob, ONE, BTC_PRICE)]);
      await oracle.setBroken(true);
      await expect(exchange.connect(alice).withdraw(1)).to.be.revertedWithCustomError(oracle, "OracleBroken");

      await other.setPrice(BTC, wad(51_000));
      await other.setPrice(ETH, wad(2_000));
      await expect(exchange.setOracle(otherAddress)).to.emit(exchange, "OracleUpdated").withArgs(otherAddress);
      expect(await exchange.oracle()).to.equal(otherAddress);
      expect(await exchange.indexPrice(BTC)).to.equal(wad(51_000));
      expect(await exchange.accountValue(alice.address)).to.equal(usdc(50_990));
      await exchange.connect(alice).withdraw(usdc(1_000));
    });

    it("the constructor rejects an oracle without code", async () => {
      const { exchange, token, owner } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("Exchange");
      await expect(F.deploy(await token.getAddress(), owner.address, owner.address, owner.address, 60, 10, 500)).to.be.revertedWithCustomError(exchange, "NotAContract");
    });

    it("caps the number of markets", async () => {
      const { exchange } = await loadFixture(deployFixture);
      expect(await exchange.MAX_MARKETS()).to.equal(16);
      for (let i = 2; i < 16; i++) await exchange.addMarket(marketConfig(`M${i}-USD`));
      expect(await exchange.marketCount()).to.equal(16);
      await expect(exchange.addMarket(marketConfig("ONE-TOO-MANY"))).to.be.revertedWithCustomError(exchange, "TooManyMarkets");
      // the gas floor at the cap fits in a block many times over
      expect((await exchange.MATCH_GAS_BASE()) + 16n * (await exchange.MATCH_GAS_PER_MARKET())).to.be.lt(10_000_000n);
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
        // 8h of capped funding (8 * 10 bps) + band (500) must stay below the maintenance margin
        { maintenanceMarginBps: 580, liquidationPenaltyBps: 150 },
        { minOrderSize: 0 },
        { maxOpenInterest: 0 },
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
        name: "Foxy",
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
        { name: "Foxy", version: "1", chainId: 1, verifyingContract: await exchange.getAddress() },
        ORDER_TYPES,
        m.maker,
      );
      expect(await ctx.settleError(m)).to.equal("InvalidSignature");

      // signed for another exchange
      m = await ctx.trade(alice, bob, ONE, BTC_PRICE);
      m.makerSig = await alice.signTypedData(
        { name: "Foxy", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: carol.address },
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

      // raising again kills more
      await exchange.connect(alice).cancelAllOrders(5_000);
      const late = ctx.order(alice, true, size, BTC_PRICE, { nonce: 4_999 });
      expect(await ctx.settleError(await ctx.match(alice, late, bob, sell(), size))).to.equal("OrderIsCancelled");
    });

    it("bulk cancel is bounded by the nonce scheme (ms timestamp << 64), so it cannot disable an account for good", async () => {
      const { exchange, ctx, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(50_000));
      await exchange.connect(bob).deposit(usdc(50_000));
      const size = wad("0.1");
      const nonceAt = (seconds: number, counter = 0n) => ((BigInt(seconds) * 1000n) << 64n) | counter;

      await expect(exchange.connect(alice).cancelAllOrders(ethers.MaxUint256)).to.be.revertedWithCustomError(exchange, "NonceTooHigh");
      const t = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(t);
      await expect(exchange.connect(alice).cancelAllOrders(nonceAt(t + 86_400) + 1n)).to.be.revertedWithCustomError(exchange, "NonceTooHigh");
      expect(await exchange.minValidNonce(alice.address)).to.equal(0);

      // the intended use: cancel everything signed before "now"
      const before = ctx.order(alice, true, size, BTC_PRICE, { nonce: nonceAt(t - 5, 7n) });
      const after = ctx.order(alice, true, size, BTC_PRICE, { nonce: nonceAt(t + 5, 1n) });
      await exchange.connect(alice).cancelAllOrders(nonceAt(t + 1));
      const sell = () => ctx.order(bob, false, size, BTC_PRICE);
      expect(await ctx.settleError(await ctx.match(alice, before, bob, sell(), size))).to.equal("OrderIsCancelled");
      expect(await ctx.settleError(await ctx.match(alice, after, bob, sell(), size))).to.equal("");

      // the highest accepted value is one day ahead; the account can trade again after that
      const t2 = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(t2);
      await exchange.connect(alice).cancelAllOrders(nonceAt(t2 + 86_400));
      const blocked = ctx.order(alice, true, size, BTC_PRICE, { nonce: nonceAt(t2 + 3_600) });
      expect(await ctx.settleError(await ctx.match(alice, blocked, bob, sell(), size))).to.equal("OrderIsCancelled");
      await time.increaseTo(t2 + 86_400 + 1);
      await ctx.oracle.setPrice(BTC, BTC_PRICE);
      const fresh = ctx.order(alice, true, size, BTC_PRICE, { nonce: nonceAt(t2 + 86_400 + 1), expiry: t2 + 10 * 86_400 });
      expect(await ctx.settleError(await ctx.match(alice, fresh, bob, ctx.order(bob, false, size, BTC_PRICE, { expiry: t2 + 10 * 86_400 }), size))).to.equal("");
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
      // the fill opens a funding period, so its premium stands for all of it
      await startNewFundingPeriodAtNextFill(f);
      const fill = await f.ctx.settleOk([await f.ctx.trade(f.alice, f.bob, ONE, fillPrice)]);
      const t0 = Number(await f.exchange.lastFundingTime(BTC));
      const fillTime = (await fill.getBlock()).timestamp;
      /**
       * Expected rate (WAD per hour) of an accrual `seconds` after the start of the period,
       * if the fixture's fill is the only one: its premium over the index of that moment
       * (50,000) counts from the fill on, for at most one hour; the rest of the period
       * counts as zero premium, and the cap shrinks in the same proportion.
       */
      const expectedRate = (seconds: number) => {
        const premium = ((fillPrice - BTC_PRICE) * 10n ** 18n) / BTC_PRICE;
        const live = BigInt(Math.min(t0 + seconds - fillTime, HOUR));
        let rate = (premium * live) / BigInt(seconds); // bigint division truncates towards zero, like Solidity
        const cap = (10n * 10n ** 14n * live) / BigInt(seconds);
        if (rate > cap) rate = cap;
        if (rate < -cap) rate = -cap;
        return rate;
      };
      /** Refreshes the index price and accrues funding exactly `seconds` after the last accrual. */
      const accrueAt = async (seconds: number, index: bigint = BTC_PRICE) => {
        await time.setNextBlockTimestamp(t0 + seconds - 1);
        await f.oracle.setPrice(BTC, index);
        await time.setNextBlockTimestamp(t0 + seconds);
        return f.exchange.updateFunding(BTC);
      };
      return { ...f, t0, fillTime, accrueAt, expectedRate };
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
      const { exchange, accrueAt, t0, expectedRate } = await fundingFixture(wad(50_025));
      // premium 5 bps for the whole hour
      expect(expectedRate(HOUR)).to.equal(5n * 10n ** 14n);
      await expect(accrueAt(HOUR))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 5, wad(25), t0 + HOUR);
    });

    it("no premium, no funding", async () => {
      const { exchange, accrueAt, t0 } = await fundingFixture(wad(50_000));
      await expect(accrueAt(HOUR)).to.emit(exchange, "FundingUpdated").withArgs(BTC, 0, 0, t0 + HOUR);
    });

    it("a fill's premium counts for one interval at most, however late the accrual", async () => {
      const cum = (rate: bigint, seconds: number) => (BTC_PRICE * rate * BigInt(Math.min(seconds, 8 * HOUR))) / (10n ** 18n * BigInt(HOUR));
      // Accrued half an hour late: the 1% premium stood for one hour of the 1.5, so the
      // cap is scaled to 2/3 and the charge is one hour at the cap, not one and a half.
      const a = await fundingFixture(wad(50_500));
      await a.accrueAt(HOUR + HOUR / 2);
      const rateA = a.expectedRate(HOUR + HOUR / 2);
      expect(rateA).to.equal((10n ** 15n * 2n) / 3n);
      expect(await a.exchange.cumulativeFunding(BTC)).to.equal(cum(rateA, HOUR + HOUR / 2));
      expect(await a.exchange.cumulativeFunding(BTC)).to.be.closeTo(wad(50), 10n ** 9n);
      // The premium is not carried into the next period: no fill, no funding.
      const before = await a.exchange.cumulativeFunding(BTC);
      await a.accrueAt(2 * HOUR + HOUR / 2);
      expect(await a.exchange.cumulativeFunding(BTC)).to.equal(before);
      expect(await a.exchange.markPrice(BTC)).to.equal(wad(50_500)); // the last fill is still reported

      // Nobody accrues for 20 hours: still one hour's worth of premium, spread over the
      // gap (rate = cap / 20) and charged for 8 of the 20 hours at most.
      const b = await fundingFixture(wad(50_500));
      await b.accrueAt(20 * HOUR);
      const rateB = b.expectedRate(20 * HOUR);
      expect(rateB).to.equal(10n ** 15n / 20n);
      expect(await b.exchange.cumulativeFunding(BTC)).to.equal(wad(20));

      // Five hours with a second fill after two: each fill counts for its own hour.
      const c = await fundingFixture(wad(50_500));
      await time.setNextBlockTimestamp(c.t0 + 2 * HOUR - 1);
      await c.oracle.setPrice(BTC, BTC_PRICE);
      const m = await c.ctx.trade(c.alice, c.bob, wad("0.001"), wad(50_500));
      await time.setNextBlockTimestamp(c.t0 + 2 * HOUR);
      await c.ctx.settleOk([m]); // accrues the first two hours (one live), then opens a period
      expect(await c.exchange.cumulativeFunding(BTC)).to.be.closeTo(wad(50), 10n ** 9n);
      await time.setNextBlockTimestamp(c.t0 + 5 * HOUR - 1);
      await c.oracle.setPrice(BTC, BTC_PRICE);
      await time.setNextBlockTimestamp(c.t0 + 5 * HOUR);
      await c.exchange.updateFunding(BTC); // three hours, one of them live
      expect(await c.exchange.cumulativeFunding(BTC)).to.be.closeTo(wad(100), 10n ** 9n);
    });

    it("the premium is fixed when the fill happens; the index at accrual only prices the payment", async () => {
      const { exchange, accrueAt, t0 } = await fundingFixture(wad(50_500));
      // The fill was 1% above the index of its moment. That the index has since risen to
      // 50,480 does not shrink the premium: the rate is at the cap, paid on 50,480.
      await expect(accrueAt(HOUR, wad(50_480)))
        .to.emit(exchange, "FundingUpdated")
        .withArgs(BTC, 10, wad("50.48"), t0 + HOUR);
    });

    describe("mark TWAP", () => {
      async function quiet() {
        const f = await loadFixture(deployFixture);
        for (const s of [f.alice, f.bob, f.carol, f.dave]) await f.exchange.connect(s).deposit(usdc(50_000));
        const t0 = Number(await f.exchange.lastFundingTime(BTC));
        const fillAt = async (seconds: number, price: bigint, size = wad("0.001")) => {
          const m = await f.ctx.trade(f.carol, f.dave, size, price);
          await time.setNextBlockTimestamp(t0 + seconds);
          return f.ctx.settleOk([m]);
        };
        const refreshAt = async (seconds: number) => {
          await time.setNextBlockTimestamp(t0 + seconds);
          await f.oracle.setPrice(BTC, BTC_PRICE);
        };
        return { ...f, t0, fillAt, refreshAt };
      }

      it("without fills the TWAP is the index and the rate is zero", async () => {
        const { exchange } = await quiet();
        expect(await exchange.markTwap(BTC)).to.equal(BTC_PRICE);
        expect(await exchange.currentFundingRate(BTC)).to.equal(0);
        expect(await exchange.markPrice(BTC)).to.equal(0);
      });

      it("weights each fill's premium by the time until the next one; time before the first counts as zero", async () => {
        const { exchange, t0, fillAt, refreshAt } = await quiet();
        await fillAt(600, wad(50_040)); // +8 bps
        await fillAt(1_800, wad(50_030)); // +6 bps
        await refreshAt(3_599);
        await time.setNextBlockTimestamp(t0 + 3_600);
        const tx = await exchange.updateFunding(BTC);
        // 600s nothing, 1,200s at 8 bps, 1,800s at 6 bps
        const rate = (8n * 10n ** 14n * 1_200n + 6n * 10n ** 14n * 1_800n) / 3_600n;
        expect(rate).to.equal(566_666_666_666_666n); // 5.67 bps
        await expect(tx)
          .to.emit(exchange, "FundingUpdated")
          .withArgs(BTC, 5, (BTC_PRICE * rate) / 10n ** 18n, t0 + 3_600);
        // the new period starts clean
        expect(await exchange.markTwap(BTC)).to.equal(BTC_PRICE);
        expect(await exchange.currentFundingRate(BTC)).to.equal(0);
      });

      it("caps every observation before averaging; markTwap stays uncapped", async () => {
        const { exchange, t0, fillAt } = await quiet();
        await fillAt(600, wad(50_100)); // +20 bps, twice the cap
        await fillAt(1_800, wad(50_030)); // +6 bps
        await time.increaseTo(t0 + 3_000);
        // uncapped average: (20 * 1200 + 6 * 1200) / 3000 = 10.4 bps -> 50,052
        expect(await exchange.markTwap(BTC)).to.equal(wad(50_052));
        // rate: (10 * 1200 + 6 * 1200) / 3000 = 6.4 bps, although the average premium is above the cap
        expect(await exchange.currentFundingRate(BTC)).to.equal(64n * 10n ** 13n);
      });

      it("the views follow the period as it goes", async () => {
        const { exchange, t0, fillAt } = await quiet();
        await fillAt(600, wad(50_100)); // 20 bps over the index
        // right after the fill it has no weight yet
        expect(await exchange.markTwap(BTC)).to.equal(BTC_PRICE);
        expect(await exchange.currentFundingRate(BTC)).to.equal(0);
        await time.increaseTo(t0 + 1_200);
        // 600s without a fill, 600s at +20 bps: average 10 bps
        expect(await exchange.markTwap(BTC)).to.equal(wad(50_050));
        // the cap (10 bps) applies to the live half of the period only
        expect(await exchange.currentFundingRate(BTC)).to.equal(5n * 10n ** 14n);
        await time.increaseTo(t0 + 3_000);
        expect(await exchange.markTwap(BTC)).to.equal(wad(50_080));
        expect(await exchange.currentFundingRate(BTC)).to.equal(8n * 10n ** 14n); // cap * 2400 / 3000
        expect(await exchange.markPrice(BTC)).to.equal(wad(50_100));
      });

      it("the views never revert for an existing market", async () => {
        const { exchange, oracle, t0, fillAt } = await quiet();
        await fillAt(600, wad(50_100));
        await time.increaseTo(t0 + MAX_PRICE_AGE + 700); // stale index
        expect(await exchange.markTwap(BTC)).to.equal(0);
        expect(await exchange.currentFundingRate(BTC)).to.equal(0);
        await oracle.setBroken(true);
        expect(await exchange.markTwap(BTC)).to.equal(0);
        expect(await exchange.currentFundingRate(BTC)).to.equal(0);
        await expect(exchange.markTwap(9)).to.be.revertedWithCustomError(exchange, "UnknownMarket");
        await expect(exchange.currentFundingRate(9)).to.be.revertedWithCustomError(exchange, "UnknownMarket");
      });

      it("negative premium", async () => {
        const { exchange, t0, fillAt, refreshAt } = await quiet();
        await fillAt(1_800, wad(49_990));
        await refreshAt(3_599);
        await time.increaseTo(t0 + 3_600);
        // half the period at -2 bps
        expect(await exchange.markTwap(BTC)).to.equal(wad(49_995));
        expect(await exchange.currentFundingRate(BTC)).to.equal(-(10n ** 14n));
      });

      it("a minimum-size fill at the band edge one second before the accrual barely moves the rate", async () => {
        const { exchange, t0, fillAt, refreshAt } = await quiet();
        await refreshAt(3_598);
        await fillAt(3_599, wad(52_500)); // +5%, the most the band allows
        expect(await exchange.markPrice(BTC)).to.equal(wad(52_500));
        await time.setNextBlockTimestamp(t0 + 3_600);
        await exchange.updateFunding(BTC);
        // The premium stood for 1 of 3,600 seconds, so at most 1/3600 of the cap applies:
        // 0.0028 bps per hour, 1.4 cents per BTC. With the last fill as the mark this fill
        // alone produced the full 10 bps (50 USD per BTC).
        const rate = 10n ** 15n / 3_600n;
        expect(await exchange.cumulativeFunding(BTC)).to.equal((BTC_PRICE * rate) / 10n ** 18n);
        expect(await exchange.cumulativeFunding(BTC)).to.be.lt(wad("0.014"));
      });

      it("... and barely moves an existing honest premium", async () => {
        const { exchange, t0, fillAt, refreshAt } = await quiet();
        await fillAt(60, wad(50_010)); // 2 bps for (almost) the whole period
        await refreshAt(3_598);
        const before = await exchange.currentFundingRate(BTC);
        await fillAt(3_599, wad(47_500)); // -5% dust fill
        await time.setNextBlockTimestamp(t0 + 3_600);
        await expect(exchange.updateFunding(BTC)).to.emit(exchange, "FundingUpdated");
        const after = (await exchange.cumulativeFunding(BTC)) * 10n ** 18n / BTC_PRICE;
        expect(before).to.be.gt(19n * 10n ** 13n); // ~2 bps
        // moved by 5.0002% / 3,600 = 0.139 bps
        expect(before - after).to.be.lt(15n * 10n ** 12n);
        expect(after).to.be.gt(18n * 10n ** 13n);
      });

      it("fills in the same block as a later fill carry no weight", async () => {
        const { exchange, ctx, carol, dave, t0, refreshAt } = await quiet();
        const first = await ctx.trade(carol, dave, wad("0.001"), wad(52_500));
        const second = await ctx.trade(carol, dave, wad("0.001"), wad(50_000));
        await time.setNextBlockTimestamp(t0 + 600);
        await ctx.settleOk([first, second]);
        await refreshAt(3_599);
        await time.increaseTo(t0 + 3_600);
        expect(await exchange.markTwap(BTC)).to.equal(BTC_PRICE);
      });

      it("documented limit: a fill early in a quiet period carries it, until someone trades at a fair price", async () => {
        const { exchange, t0, fillAt } = await quiet();
        await fillAt(60, wad(52_500));
        const snapshot = await takeSnapshot();
        await time.increaseTo(t0 + 3_500);
        // at the cap for the 3,440 of 3,500 seconds it has been standing
        expect(await exchange.currentFundingRate(BTC)).to.equal((10n ** 15n * 3_440n) / 3_500n);
        await snapshot.restore();
        // one fair fill a minute later leaves the edge price 60 seconds of weight, and every
        // observation is capped before averaging: 60/3500 of the cap, not 5% * 60/3500
        await fillAt(120, BTC_PRICE);
        await time.increaseTo(t0 + 3_500);
        expect(await exchange.currentFundingRate(BTC)).to.equal((10n ** 15n * 60n) / 3_500n);
      });
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
      await startNewFundingPeriodAtNextFill(f);
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
      await startNewFundingPeriodAtNextFill(f);
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

  describe("insurance fund deposits", () => {
    it("anyone can add to the fund; there is no way to take it out", async () => {
      const { exchange, token, stranger } = await loadFixture(deployFixture);
      const before = await token.balanceOf(stranger.address);
      await expect(exchange.connect(stranger).depositInsurance(0)).to.be.revertedWithCustomError(exchange, "ZeroAmount");
      await expect(exchange.connect(stranger).depositInsurance(usdc(500)))
        .to.emit(exchange, "InsuranceDeposit")
        .withArgs(stranger.address, usdc(500), 0);
      expect(await exchange.insuranceFund()).to.equal(usdc(500));
      expect(await exchange.totalBadDebt()).to.equal(0);
      expect(await token.balanceOf(await exchange.getAddress())).to.equal(usdc(500));
      expect(await token.balanceOf(stranger.address)).to.equal(before - usdc(500));
      // it is not the depositor's balance
      expect(await exchange.balanceOf(stranger.address)).to.equal(0);
      await expect(exchange.connect(stranger).withdraw(1)).to.be.revertedWithCustomError(exchange, "InsufficientFreeCollateral");
      // no function on the contract moves the fund out
      const names = exchange.interface.fragments.filter((f) => f.type === "function").map((f) => (f as { name: string }).name);
      expect(names.filter((n) => /insurance/i.test(n)).sort()).to.deep.equal(["depositInsurance", "insuranceFund"]);
    });

    it("works while paused", async () => {
      const { exchange, stranger } = await loadFixture(deployFixture);
      await exchange.setPaused(true);
      await exchange.connect(stranger).depositInsurance(usdc(1));
      expect(await exchange.insuranceFund()).to.equal(usdc(1));
    });

    it("a funded insurance fund absorbs a later deficit", async () => {
      const { exchange, oracle, alice, liquidator, stranger } = await leveragedFixture();
      await exchange.connect(stranger).depositInsurance(usdc(5_000));
      await oracle.setPrice(BTC, wad(38_000)); // alice: -1,910
      await expect(exchange.connect(liquidator).liquidate(alice.address, BTC, MAX))
        .to.emit(exchange, "DeficitAbsorbed")
        .withArgs(alice.address, usdc(1_910), 0);
      expect(await exchange.insuranceFund()).to.equal(usdc(3_090));
      expect(await exchange.totalBadDebt()).to.equal(0);
    });

    it("repays recorded bad debt first and closes the real shortfall", async () => {
      const { exchange, oracle, token, alice, bob, liquidator, stranger, feeRecipient, ctx } = await leveragedFixture();
      await oracle.setPrice(BTC, wad(38_000));
      await exchange.connect(liquidator).liquidate(alice.address, BTC, MAX);
      expect(await exchange.totalBadDebt()).to.equal(usdc(1_910));
      const exchangeAddress = await exchange.getAddress();
      const shortfall = async () => {
        let claims = await exchange.insuranceFund();
        for (const s of [alice, bob, liquidator, feeRecipient]) claims += await exchange.accountValue(s.address);
        return claims - (await token.balanceOf(exchangeAddress));
      };
      expect(await shortfall()).to.equal(usdc(1_910));

      // partial repayment: all of it goes against the bad debt
      await expect(exchange.connect(stranger).depositInsurance(usdc(1_000)))
        .to.emit(exchange, "InsuranceDeposit")
        .withArgs(stranger.address, usdc(1_000), usdc(1_000));
      expect(await exchange.totalBadDebt()).to.equal(usdc(910));
      expect(await exchange.insuranceFund()).to.equal(0);
      expect(await shortfall()).to.equal(usdc(910));

      // the next deposit repays the rest and the remainder goes to the fund
      await expect(exchange.connect(stranger).depositInsurance(usdc(1_500)))
        .to.emit(exchange, "InsuranceDeposit")
        .withArgs(stranger.address, usdc(1_500), usdc(910));
      expect(await exchange.totalBadDebt()).to.equal(0);
      expect(await exchange.insuranceFund()).to.equal(usdc(590));
      expect(await shortfall()).to.equal(0);

      // now everybody can be paid in full: close out and withdraw everything
      await ctx.settleOk([await ctx.trade(bob, liquidator, ONE, wad(38_000))]);
      for (const s of [bob, liquidator, feeRecipient]) {
        await exchange.connect(s).withdraw(await exchange.balanceOf(s.address));
      }
      expect(await token.balanceOf(exchangeAddress)).to.equal(usdc(590)); // exactly the fund
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
        exchange2.interface.encodeFunctionData("depositInsurance", [1]),
      ]) {
        await evil.arm(await exchange2.getAddress(), data);
        await expect(exchange2.connect(f.alice).deposit(usdc(1))).to.be.revertedWithCustomError(exchange2, "ReentrancyGuardReentrantCall");
        // and the other way round: re-entering from the transfer of an insurance deposit
        await expect(exchange2.connect(f.alice).depositInsurance(usdc(1))).to.be.revertedWithCustomError(exchange2, "ReentrancyGuardReentrantCall");
      }
      await evil.disarm();
      await exchange2.connect(f.alice).deposit(usdc(1));
    });
  });
});
