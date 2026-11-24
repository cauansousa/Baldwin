// Runs scripts/deploy-testnet.ts in-process against mock stand-ins for USDC, the
// Chainlink feeds and the sequencer uptime feed.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import fs from "fs";
import os from "os";
import path from "path";
import { deployTestnet, loadConfig } from "../scripts/deploy-testnet";
import { usdc, wad } from "./helpers";

describe("scripts/deploy-testnet.ts", () => {
  async function externals() {
    const [deployer, multisig, operator, feeRecipient, user] = await ethers.getSigners();
    const Agg = await ethers.getContractFactory("MockAggregator");
    const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await token.mint(user.address, usdc(1_000));
    const now = await time.latest();
    const btc = await Agg.deploy(8);
    await btc.set(65_000n * 10n ** 8n, now);
    const eth = await Agg.deploy(8);
    await eth.set(3_500n * 10n ** 8n, now);
    const sequencer = await Agg.deploy(0);
    await sequencer.setRound(0, now - 100_000, now);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "baldwin-deploy-")), "deployment.json");
    const env: Record<string, string | undefined> = {
      USDC_ADDRESS: await token.getAddress(),
      BTC_USD_FEED: await btc.getAddress(),
      ETH_USD_FEED: await eth.getAddress(),
      BTC_USD_MAX_STALENESS: "3900",
      ETH_USD_MAX_STALENESS: "86700",
      SEQUENCER_UPTIME_FEED: await sequencer.getAddress(),
      OWNER_ADDRESS: multisig.address,
      ALLOW_EOA_OWNER: "true",
      OPERATOR_ADDRESS: operator.address,
      FEE_RECIPIENT: feeRecipient.address,
      DEPLOYMENT_FILE: file,
    };
    return { deployer, multisig, operator, feeRecipient, user, token, btc, eth, sequencer, env, file, Agg };
  }
  const quiet = () => undefined;
  const run = (env: Record<string, string | undefined>) => deployTestnet(loadConfig(env), quiet);

  describe("configuration", () => {
    it("lists every missing required variable", () => {
      let message = "";
      try {
        loadConfig({});
      } catch (e) {
        message = (e as Error).message;
      }
      for (const name of [
        "USDC_ADDRESS",
        "BTC_USD_FEED",
        "ETH_USD_FEED",
        "BTC_USD_MAX_STALENESS",
        "ETH_USD_MAX_STALENESS",
        "OWNER_ADDRESS",
        "OPERATOR_ADDRESS",
        "FEE_RECIPIENT",
      ]) {
        expect(message).to.contain(`${name} is not set`);
      }
      expect(message).to.not.contain("SEQUENCER_UPTIME_FEED");
    });

    it("treats empty values as missing and rejects malformed ones", async () => {
      const { env } = await loadFixture(externals);
      expect(() => loadConfig({ ...env, USDC_ADDRESS: "  " })).to.throw("USDC_ADDRESS is not set");
      expect(() => loadConfig({ ...env, BTC_USD_FEED: "0x1234" })).to.throw("BTC_USD_FEED is not a valid non-zero address");
      expect(() => loadConfig({ ...env, OWNER_ADDRESS: ethers.ZeroAddress })).to.throw("OWNER_ADDRESS is not a valid non-zero address");
      expect(() => loadConfig({ ...env, ETH_USD_MAX_STALENESS: "1h" })).to.throw("ETH_USD_MAX_STALENESS must be a non-negative integer");
      expect(() => loadConfig({ ...env, BTC_MIN_ORDER_SIZE: "abc" })).to.throw("BTC_MIN_ORDER_SIZE must be a non-negative decimal number");
      expect(() => loadConfig({ ...env, MAX_FUNDING_RATE_BPS: "101" })).to.throw("MAX_FUNDING_RATE_BPS must be at most 100");
      expect(() => loadConfig({ ...env, MAX_PRICE_DEVIATION_BPS: "995" })).to.throw("below MAINTENANCE_MARGIN_BPS");
      expect(() => loadConfig({ ...env, MAINTENANCE_MARGIN_BPS: "2500" })).to.throw("margins must satisfy");
    });

    it("applies the documented defaults", async () => {
      const { env } = await loadFixture(externals);
      const c = loadConfig(env);
      expect(c.maxPriceAge).to.equal(86_700n); // the larger staleness limit
      expect(c.maxFundingRateBps).to.equal(10n);
      expect(c.maxPriceDeviationBps).to.equal(500n);
      expect([c.initialMarginBps, c.maintenanceMarginBps, c.makerFeeBps, c.takerFeeBps, c.liquidationPenaltyBps]).to.deep.equal([2000n, 1000n, 2n, 5n, 150n]);
      expect(c.sequencerGracePeriod).to.equal(3600n);
      expect(c.markets.map((m) => [m.symbol, m.maxOpenInterest, m.minOrderSize])).to.deep.equal([
        ["BTC-USD", wad(1000), wad("0.001")],
        ["ETH-USD", wad(20000), wad("0.01")],
      ]);
      expect(loadConfig({ ...env, SEQUENCER_UPTIME_FEED: "" }).sequencerUptimeFeed).to.equal(ethers.ZeroAddress);
      expect(loadConfig({ ...env, ALLOW_EOA_OWNER: undefined }).allowEoaOwner).to.equal(false);
    });
  });

  describe("preflight refuses to deploy", () => {
    const expectRefusal = async (env: Record<string, string | undefined>, reason: string) => {
      const nonce = await ethers.provider.getTransactionCount((await ethers.getSigners())[0].address);
      fs.rmSync(env.DEPLOYMENT_FILE!, { force: true }); // may exist from another test of this file
      let message = "";
      try {
        await run(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).to.contain("Preflight failed, nothing was deployed");
      expect(message).to.contain(reason);
      // literally nothing was sent
      expect(await ethers.provider.getTransactionCount((await ethers.getSigners())[0].address)).to.equal(nonce);
      expect(fs.existsSync(env.DEPLOYMENT_FILE!)).to.equal(false);
    };

    it("when an address that must be a contract has no code", async () => {
      const { env, user } = await loadFixture(externals);
      await expectRefusal({ ...env, USDC_ADDRESS: user.address }, "USDC_ADDRESS " + user.address + " has no contract code");
      await expectRefusal({ ...env, BTC_USD_FEED: user.address }, "BTC-USD feed " + user.address + " has no contract code");
      await expectRefusal({ ...env, ETH_USD_FEED: user.address }, "ETH-USD feed " + user.address + " has no contract code");
      await expectRefusal({ ...env, SEQUENCER_UPTIME_FEED: user.address }, "has no contract code");
      await expectRefusal({ ...env, ALLOW_EOA_OWNER: "false" }, "expected a multisig");
    });

    it("when the token is not a 6-decimal ERC-20", async () => {
      const { env } = await loadFixture(externals);
      const eighteen = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      await expectRefusal({ ...env, USDC_ADDRESS: await eighteen.getAddress() }, "has 18 decimals, expected 6");
      await expectRefusal({ ...env, USDC_ADDRESS: env.BTC_USD_FEED }, "has 8 decimals, expected 6");
      const notAToken = await (await ethers.getContractFactory("MockOracle")).deploy();
      await expectRefusal({ ...env, USDC_ADDRESS: await notAToken.getAddress() }, "does not answer decimals()");
    });

    it("when a feed is not a healthy Chainlink aggregator", async () => {
      const { env, btc, eth, token } = await loadFixture(externals);
      const now = await time.latest();
      await expectRefusal({ ...env, BTC_USD_FEED: await token.getAddress() }, "not a Chainlink aggregator");
      await btc.set(0, now);
      await expectRefusal(env, "answer 0 is not positive");
      await btc.set(-1, now);
      await expectRefusal(env, "answer -1 is not positive");
      await btc.set(65_000n * 10n ** 8n, now - 4000);
      await expectRefusal(env, "more than the configured 3900s");
      await btc.set(65_000n * 10n ** 8n, now + 4000);
      await expectRefusal(env, "is not a past timestamp");
      // the same feed twice, or the two swapped
      await btc.set(65_000n * 10n ** 8n, await time.latest());
      await expectRefusal({ ...env, BTC_USD_FEED: await eth.getAddress() }, "are the same address");
      await expectRefusal({ ...env, BTC_USD_FEED: env.ETH_USD_FEED, ETH_USD_FEED: env.BTC_USD_FEED, BTC_USD_MAX_STALENESS: "86700" }, "feeds swapped?");
      await eth.set(5n * 10n ** 8n, await time.latest());
      await expectRefusal(env, "ETH-USD feed " + env.ETH_USD_FEED + ": price 5 is outside the plausible range 10..1000000");
      // wrong decimals assumption would show up the same way
      await btc.set(65_000n, await time.latest());
      await expectRefusal(env, "outside the plausible range");
    });

    it("when the sequencer is down or inside the grace period", async () => {
      const { env, sequencer } = await loadFixture(externals);
      const now = await time.latest();
      await sequencer.setRound(1, now - 50, now);
      await expectRefusal(env, "reports the sequencer as down");
      await sequencer.setRound(0, now - 50, now);
      await expectRefusal(env, "inside the grace period");
      await sequencer.setRound(0, 0, 0);
      await expectRefusal(env, "is not a past timestamp");
    });

    it("on a mainnet chain id", async () => {
      // cannot switch chain id in-process; assert the guard exists by its list
      const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy-testnet.ts"), "utf8");
      expect(source).to.match(/MAINNET_CHAIN_IDS = \[1, .*42161/);
    });
  });

  it("deploys oracle and exchange, configures them and starts the ownership transfer", async () => {
    const { env, file, deployer, multisig, operator, feeRecipient, token, btc, eth, sequencer, user } = await loadFixture(externals);
    const supplyBefore = await token.totalSupply();
    const lines: string[] = [];
    const result = await deployTestnet(loadConfig(env), (l) => lines.push(l));

    // the Deployment file, in the shape of shared/src/index.ts
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written).to.deep.equal(result.deployment);
    expect(Object.keys(written)).to.deep.equal(["chainId", "exchange", "usdc", "oracle", "markets"]);
    expect(written.chainId).to.equal(31337);
    expect(written.usdc).to.equal(await token.getAddress());
    expect(written.markets).to.deep.equal([
      { marketId: 0, symbol: "BTC-USD" },
      { marketId: 1, symbol: "ETH-USD" },
    ]);

    const exchange = await ethers.getContractAt("Exchange", written.exchange);
    const oracle = await ethers.getContractAt("ChainlinkOracle", written.oracle);
    expect(await exchange.collateralToken()).to.equal(await token.getAddress());
    expect(await exchange.oracle()).to.equal(written.oracle);
    expect(await exchange.feeRecipient()).to.equal(feeRecipient.address);
    expect(await exchange.maxPriceAge()).to.equal(86_700);
    expect(await exchange.maxFundingRateBps()).to.equal(10);
    expect(await exchange.maxPriceDeviationBps()).to.equal(500);
    expect(await exchange.marketCount()).to.equal(2);
    const m0 = await exchange.getMarket(0);
    expect([m0.active, m0.initialMarginBps, m0.maintenanceMarginBps, m0.makerFeeBps, m0.takerFeeBps, m0.liquidationPenaltyBps, m0.maxOpenInterest, m0.minOrderSize, m0.symbol]).to.deep.equal(
      [true, 2000n, 1000n, 2n, 5n, 150n, wad(1000), wad("0.001"), "BTC-USD"],
    );
    const m1 = await exchange.getMarket(1);
    expect([m1.maxOpenInterest, m1.minOrderSize, m1.symbol]).to.deep.equal([wad(20000), wad("0.01"), "ETH-USD"]);
    expect(await exchange.indexPrice(0)).to.equal(wad(65_000));
    expect(await exchange.indexPrice(1)).to.equal(wad(3_500));
    expect(await exchange.isOperator(operator.address)).to.equal(true);
    expect(await exchange.isOperator(deployer.address)).to.equal(false);
    expect(await exchange.paused()).to.equal(false);

    expect(await oracle.feedOf(0)).to.deep.equal([await btc.getAddress(), 8n, 3900n]);
    expect(await oracle.feedOf(1)).to.deep.equal([await eth.getAddress(), 8n, 86_700n]);
    expect(await oracle.sequencerUptimeFeed()).to.equal(await sequencer.getAddress());
    expect(await oracle.sequencerGracePeriod()).to.equal(3600);

    // no mock token deployed, nothing minted
    expect(await token.totalSupply()).to.equal(supplyBefore);

    // ownership: started, not finished
    for (const c of [exchange, oracle]) {
      expect(await c.owner()).to.equal(deployer.address);
      expect(await c.pendingOwner()).to.equal(multisig.address);
    }
    const output = lines.join("\n");
    expect(output).to.contain("OWNERSHIP IS NOT TRANSFERRED YET");
    expect(output).to.contain(`${multisig.address} calls acceptOwnership() on BOTH contracts`);
    expect(output).to.contain(`npx hardhat verify --network hardhat ${written.exchange} ${written.usdc} ${written.oracle} ${deployer.address} ${feeRecipient.address} 86700 10 500`);
    expect(output).to.contain(`npx hardhat verify --network hardhat ${written.oracle} ${deployer.address} ${await sequencer.getAddress()} 3600`);

    await exchange.connect(multisig).acceptOwnership();
    await oracle.connect(multisig).acceptOwnership();
    expect(await exchange.owner()).to.equal(multisig.address);
    expect(await oracle.owner()).to.equal(multisig.address);
    await expect(exchange.setPaused(true)).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");

    // the deployed system works with the real (pre-existing) token
    await token.connect(user).approve(written.exchange, usdc(1_000));
    await exchange.connect(user).deposit(usdc(1_000));
    expect(await exchange.balanceOf(user.address)).to.equal(usdc(1_000));
  });

  it("works without a sequencer feed and with the deployer as owner", async () => {
    const { env, deployer } = await loadFixture(externals);
    const lines: string[] = [];
    const result = await deployTestnet(loadConfig({ ...env, SEQUENCER_UPTIME_FEED: "", OWNER_ADDRESS: deployer.address, ALLOW_EOA_OWNER: "false" }), (l) => lines.push(l));
    expect(result.ownershipPending).to.equal(false);
    expect(await result.oracle.sequencerUptimeFeed()).to.equal(ethers.ZeroAddress);
    expect(await result.exchange.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(lines.join("\n")).to.contain("sequencer uptime feed: disabled");
  });

  it("never reads or prints the private key", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy-testnet.ts"), "utf8");
    // the only mention is the presence check in main()
    const uses = source.split("\n").filter((l) => l.includes("DEPLOYER_PRIVATE_KEY") && !l.trim().startsWith("//"));
    expect(uses.length).to.equal(2);
    expect(uses.join("\n")).to.not.match(/console\.|log\(/);
  });
});
