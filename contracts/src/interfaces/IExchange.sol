// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IExchange
/// @notice External surface of the Baldwin perpetuals exchange. This file is the
///         contract between the on-chain code, the matching engine and the web app.
///
/// Units
///  - Collateral (USDC) amounts and all account values: 6 decimals ("USDC units").
///  - Base sizes and prices: 18 decimals (WAD). Price is USD per 1 unit of base.
///  - Funding index: USDC-WAD per 1 unit of base (18 decimals), signed, cumulative.
///  - Rates and fees: basis points (1e4 = 100%).
interface IExchange {
    /// @dev EIP-712 typed order. Domain: name "Baldwin", version "1", chainId,
    ///      verifyingContract = this exchange.
    ///      Type string:
    ///      Order(address trader,uint32 marketId,bool isBuy,bool reduceOnly,uint256 size,uint256 limitPrice,uint256 nonce,uint64 expiry)
    struct Order {
        address trader;
        uint32 marketId;
        bool isBuy;
        bool reduceOnly;
        uint256 size; // total base size, WAD
        uint256 limitPrice; // worst acceptable price, WAD
        uint256 nonce; // unique per trader; identifies the order for cancellation
        uint64 expiry; // unix seconds; 0 = no expiry
    }

    /// @dev One fill between a resting (maker) and an incoming (taker) order.
    ///      fillPrice must equal the maker's limitPrice and satisfy the taker's limit.
    struct Match {
        Order maker;
        bytes makerSig;
        Order taker;
        bytes takerSig;
        uint256 fillSize; // base, WAD
    }

    struct Market {
        bool active;
        uint16 initialMarginBps; // e.g. 2000 = 5x max leverage
        uint16 maintenanceMarginBps; // e.g. 1000
        uint16 makerFeeBps;
        uint16 takerFeeBps;
        uint16 liquidationPenaltyBps; // of liquidated notional
        uint256 maxOpenInterest; // base, WAD, per side
        uint256 minOrderSize; // base, WAD
        string symbol; // e.g. "BTC-USD"
    }

    struct Position {
        int256 size; // base WAD; >0 long, <0 short
        uint256 entryNotional; // USDC units paid/received to open the current size
        int256 lastCumulativeFunding; // funding index snapshot at last touch
    }

    // ---------------------------------------------------------------- events
    event Deposit(address indexed trader, uint256 amount);
    event Withdraw(address indexed trader, uint256 amount);
    event MarketAdded(uint32 indexed marketId, string symbol);
    event MarketUpdated(uint32 indexed marketId);
    event Fill(
        uint32 indexed marketId,
        address indexed maker,
        address indexed taker,
        bytes32 makerOrderHash,
        bytes32 takerOrderHash,
        bool takerIsBuy,
        uint256 size,
        uint256 price,
        uint256 makerFee,
        uint256 takerFee
    );
    event MatchFailed(uint256 indexed index, bytes32 makerOrderHash, bytes32 takerOrderHash, bytes reason);
    event OrderCancelled(address indexed trader, uint256 nonce);
    event FundingUpdated(uint32 indexed marketId, int256 fundingRateBps, int256 cumulativeFunding, uint256 timestamp);
    event Liquidation(
        uint32 indexed marketId,
        address indexed trader,
        address indexed liquidator,
        int256 size,
        uint256 price,
        uint256 penalty,
        uint256 badDebt
    );
    event OperatorUpdated(address indexed operator, bool allowed);
    event Paused(bool paused);

    // --------------------------------------------------------------- trader
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    /// @notice On-chain cancel; works even if the operator is offline.
    function cancelOrder(uint256 nonce) external;

    // ------------------------------------------------------------- operator
    /// @notice Settle a batch. A failing match must NOT revert the batch: it emits
    ///         MatchFailed and the rest continue.
    function settleMatches(Match[] calldata matches) external;

    // --------------------------------------------------------- permissionless
    /// @notice Close an under-margined position (or part of it) at the oracle price.
    ///         `maxSize` is base WAD, unsigned; pass type(uint256).max for the whole position.
    function liquidate(address trader, uint32 marketId, uint256 maxSize) external;
    /// @notice Accrue funding for a market; callable by anyone, no-op if called too early.
    function updateFunding(uint32 marketId) external;

    // ---------------------------------------------------------------- views
    function collateralToken() external view returns (address);
    function marketCount() external view returns (uint32);
    function getMarket(uint32 marketId) external view returns (Market memory);
    function getPosition(address trader, uint32 marketId) external view returns (Position memory);
    /// @notice Cash balance in USDC units, excluding unrealized PnL and pending funding. May be negative.
    function balanceOf(address trader) external view returns (int256);
    /// @notice balance + unrealized PnL - pending funding, across all markets, at oracle prices.
    function accountValue(address trader) external view returns (int256);
    function marginRequirement(address trader) external view returns (uint256 initial, uint256 maintenance);
    /// @notice max(0, accountValue - initial margin requirement); what can be withdrawn.
    function freeCollateral(address trader) external view returns (uint256);
    function isLiquidatable(address trader) external view returns (bool);
    function indexPrice(uint32 marketId) external view returns (uint256);
    /// @notice Last fill price, used with the index price for funding.
    function markPrice(uint32 marketId) external view returns (uint256);
    function cumulativeFunding(uint32 marketId) external view returns (int256);
    function openInterest(uint32 marketId) external view returns (uint256 longs, uint256 shorts);
    function insuranceFund() external view returns (uint256);
    function hashOrder(Order calldata order) external view returns (bytes32);
    function filledSize(bytes32 orderHash) external view returns (uint256);
    function isCancelled(address trader, uint256 nonce) external view returns (bool);
    function isOperator(address account) external view returns (bool);
}
