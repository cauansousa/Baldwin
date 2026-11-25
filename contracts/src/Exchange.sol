// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IExchange} from "./interfaces/IExchange.sol";
import {IOracle} from "./interfaces/IOracle.sol";

/// @title Exchange
/// @notice Custody, margin, settlement, funding and liquidation for Baldwin perpetuals.
///
/// Accounting model
///  - Every account has one signed USDC cash balance shared by all markets (cross margin).
///  - A position stores its signed base size and `entryNotional`, the USDC notional at
///    which the current size was opened. Opening moves no cash; PnL is realized into the
///    cash balance when size is closed. Unrealized PnL is derived from the index price.
///  - Every trade (fill or liquidation) has exactly one buyer and one seller of the same
///    size, so total long size always equals total short size in each market.
///
/// Rounding
///  - USDC notional of a trade is rounded UP for the buyer and DOWN for the seller, fees
///    and margin requirements are rounded UP, funding is rounded so that the payer pays
///    more / the receiver gets less. Rounding dust stays in the contract unassigned.
///    Consequence: `USDC held + totalBadDebt >= sum(accountValue) + insuranceFund`.
contract Exchange is IExchange, Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    // ------------------------------------------------------------ constants
    uint256 internal constant BPS = 10_000;
    int256 internal constant WAD = 1e18;
    /// @dev size (WAD) * price (WAD) / NOTIONAL_SCALE = USDC units (6 decimals).
    uint256 internal constant NOTIONAL_SCALE = 1e30;
    /// @dev 1 bps expressed in WAD.
    int256 internal constant BPS_WAD = 1e14;

    /// @notice Minimum time between two funding accruals of a market.
    uint256 public constant FUNDING_INTERVAL = 1 hours;
    /// @notice Longest period a single funding accrual can charge for. If nobody pokes a
    ///         market for longer than this, the excess time accrues no funding.
    uint256 public constant MAX_FUNDING_ELAPSED = 8 hours;
    /// @notice Share of the liquidation penalty paid to the liquidator; the rest goes to
    ///         the insurance fund.
    uint256 public constant LIQUIDATOR_SHARE_BPS = 5_000;
    /// @notice Upper bound for maker and taker fees.
    uint256 public constant MAX_FEE_BPS = 100;
    /// @notice An order is only fillable while its expiry is at most this far ahead.
    /// @dev This is not a cap on how long a signature lives: an order dated further
    ///      ahead is rejected now but becomes fillable once its expiry is within the
    ///      window. It only guarantees that every fillable order ends within 30 days;
    ///      `cancelOrder` / `cancelAllOrders` are the way to end one earlier.
    uint256 public constant MAX_ORDER_LIFETIME = 30 days;
    /// @notice Upper bound on the number of markets. Margin checks loop over all markets
    ///         and the per-match gas floor grows with them; the cap keeps both bounded
    ///         (floor at the cap: MATCH_GAS_BASE + 16 * MATCH_GAS_PER_MARKET).
    uint256 public constant MAX_MARKETS = 16;
    /// @notice `cancelAllOrders` accepts values up to one day ahead in the documented
    ///         nonce scheme: (unix milliseconds << 64) | counter.
    uint256 public constant NONCE_TIME_SHIFT = 64;
    /// @notice Upper bound for `maxFundingRateBps` (1% per hour).
    uint256 public constant MAX_FUNDING_RATE_CAP_BPS = 100;
    /// @notice Gas that must be available before each match of a batch is attempted:
    ///         MATCH_GAS_BASE + MATCH_GAS_PER_MARKET * marketCount. If less is left the
    ///         whole batch reverts, so that an under-gassed transaction cannot make a
    ///         valid match fail with out-of-gas and be reported as `MatchFailed`.
    /// @dev Measured as the gas used by a whole single-match `settleMatches`
    ///      transaction (optimizer 200 runs, cancun; test "batch gas floor, measured"),
    ///      which is an upper bound for the match itself, with the ChainlinkOracle
    ///      adapter, mock aggregators and the sequencer uptime check enabled. The two most
    ///      expensive cases found, with both accounts holding a position in every market,
    ///      cold storage, pending funding to settle and a funding accrual due in every
    ///      market:
    ///        - both sides flip:   372k gas with 2 markets, 834k with 8;
    ///        - both sides reduce: 413k gas with 2 markets, 998k with 8 (~97k per market;
    ///          a reducing side is valued twice).
    ///      The floor is 800k for 2 markets (1.9x the measurement), 2.0M for 8 (2.0x) and
    ///      3.6M at MAX_MARKETS. The headroom is for real Chainlink feeds, which sit
    ///      behind a proxy and cost more per read than the mock aggregators, and for the
    ///      1/64 of gas withheld from the inner call. Re-measure on a fork before mainnet.
    uint256 public constant MATCH_GAS_BASE = 400_000;
    uint256 public constant MATCH_GAS_PER_MARKET = 200_000;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,uint32 marketId,bool isBuy,bool reduceOnly,uint256 size,uint256 limitPrice,uint256 nonce,uint64 expiry)"
    );

    // ----------------------------------------------------------- immutables
    IERC20 private immutable _collateral;
    /// @notice Index price source. Replaceable by the owner (see `setOracle`).
    IOracle public oracle;
    /// @notice Oracle prices older than this many seconds are stale.
    uint256 public immutable maxPriceAge;
    /// @notice Cap on the absolute funding rate, in bps of notional per FUNDING_INTERVAL.
    uint256 public immutable maxFundingRateBps;
    /// @notice Every fill price must be within this many bps of the index price.
    uint256 public immutable maxPriceDeviationBps;

    // -------------------------------------------------------------- storage
    struct MarketState {
        int256 cumulativeFunding; // USD (WAD) per 1 unit of base, paid by longs to shorts
        uint256 lastFundingTime;
        uint256 longOpenInterest;
        uint256 shortOpenInterest;
        // --- one slot ---
        uint128 markPrice; // last fill price, 0 until the first fill
        // Last index price read successfully by a transaction; used to value this market
        // for liquidations elsewhere while its price is unavailable. 0 = never read.
        uint128 lastGoodPrice;
        // --- one slot: premium bookkeeping of the current funding period, see _recordFill ---
        uint64 periodFirstFillTime; // 0 = no fill in this period yet
        uint64 lastFillTime;
        // sum of clamp(premium, ±rate cap) * seconds over the completed fill-to-fill segments
        int128 cappedPremiumTimeSum;
        // --- one slot ---
        int128 lastPremium; // (price - index) / index of the last fill, WAD, at the index of that moment
        int128 premiumTimeSum; // sum of premium * seconds over the completed segments (for markTwap)
    }

    Market[] private _markets;
    mapping(uint32 marketId => MarketState) private _marketState;
    mapping(address trader => int256) private _balances;
    mapping(address trader => mapping(uint32 marketId => Position)) private _positions;
    mapping(bytes32 orderHash => uint256) private _filled;
    mapping(address trader => mapping(uint256 nonce => bool)) private _cancelled;
    /// @dev Orders with a nonce below this value are cancelled (bulk cancel).
    mapping(address trader => uint256) private _minValidNonce;
    mapping(address => bool) private _operators;

    uint256 private _insuranceFund;
    /// @inheritdoc IExchange
    /// @dev Sum of all losses that neither the losing account nor the insurance fund
    ///      could cover, less what `depositInsurance` has repaid. The contract is short of
    ///      USDC by (at most) this amount.
    uint256 public totalBadDebt;
    address public feeRecipient;
    /// @notice Account that may pause, but not unpause (see `setPaused`).
    address public guardian;
    bool public paused;

    // ---------------------------------------------------- additional events
    event FeeRecipientUpdated(address indexed feeRecipient);
    event OracleUpdated(address indexed oracle);
    /// @notice An account with no positions was left with a negative balance, which was
    ///         reset to zero. `fromInsurance` was taken from the insurance fund and
    ///         `badDebt` was recorded as uncovered.
    event DeficitAbsorbed(address indexed trader, uint256 fromInsurance, uint256 badDebt);

    // --------------------------------------------------------------- errors
    error ZeroAddress();
    error ZeroAmount();
    error InvalidConfig();
    error InvalidMarketConfig();
    error UnknownMarket(uint32 marketId);
    error NotOperator();
    error OnlySelf();
    error InvalidPrice(uint32 marketId);
    error StalePrice(uint32 marketId);
    error MarketMismatch();
    error SelfTrade();
    error SameSide();
    error PriceNotCrossed();
    error InvalidSignature();
    error OrderIsCancelled();
    error OrderExpired();
    error InvalidExpiry();
    error NonceNotIncreased();
    error NonceTooHigh();
    error TooManyMarkets();
    error NotAContract();
    error RenounceDisabled();
    error OrderTooSmall();
    error FillTooSmall();
    error PriceOutOfBand(uint256 price, uint256 index);
    error InsufficientGas();
    error Overfill();
    error ReduceOnlyViolated(address trader);
    error OnlyReducingAllowed();
    error OpenInterestCapExceeded();
    error InsufficientMargin(address trader);
    error NegativeAccountValue(address trader);
    error InsufficientFreeCollateral();
    error NoPosition();
    error NotLiquidatable();
    error SelfLiquidation();

    // ---------------------------------------------------------- constructor
    /// @param collateral_ USDC (must have 6 decimals and no transfer fee).
    /// @param oracle_ index price source.
    /// @param owner_ admin.
    /// @param feeRecipient_ account credited with trading fees.
    /// @param maxPriceAge_ seconds after which an oracle price is stale.
    /// @param maxFundingRateBps_ funding rate cap per hour, in bps (at most 100).
    /// @param maxPriceDeviationBps_ width of the fill price band around the index, in bps.
    constructor(
        address collateral_,
        address oracle_,
        address owner_,
        address feeRecipient_,
        uint256 maxPriceAge_,
        uint256 maxFundingRateBps_,
        uint256 maxPriceDeviationBps_
    ) Ownable(owner_) EIP712("Baldwin", "1") {
        if (collateral_ == address(0) || oracle_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (
            maxPriceAge_ == 0 ||
            maxFundingRateBps_ > MAX_FUNDING_RATE_CAP_BPS ||
            maxPriceDeviationBps_ == 0 ||
            maxPriceDeviationBps_ >= BPS
        ) revert InvalidConfig();
        maxPriceDeviationBps = maxPriceDeviationBps_;
        _collateral = IERC20(collateral_);
        if (oracle_.code.length == 0) revert NotAContract();
        oracle = IOracle(oracle_);
        emit OracleUpdated(oracle_);
        maxPriceAge = maxPriceAge_;
        maxFundingRateBps = maxFundingRateBps_;
        feeRecipient = feeRecipient_;
        emit FeeRecipientUpdated(feeRecipient_);
    }

    // ================================================================ admin

    function addMarket(Market calldata market) external onlyOwner returns (uint32 marketId) {
        _validateMarket(market);
        if (_markets.length >= MAX_MARKETS) revert TooManyMarkets();
        marketId = _markets.length.toUint32();
        _markets.push(market);
        _marketState[marketId].lastFundingTime = block.timestamp;
        emit MarketAdded(marketId, market.symbol);
    }

    /// @notice Replace a market's parameters. Raising margin requirements can make
    ///         existing accounts liquidatable immediately.
    function updateMarket(uint32 marketId, Market calldata market) external onlyOwner {
        _requireMarket(marketId);
        _validateMarket(market);
        // Funding is suspended while a market is inactive. Close the running period under
        // the old status before switching: charged normally when deactivating, at zero
        // when reactivating.
        if (_markets[marketId].active != market.active) _closeFundingPeriod(marketId, true);
        _markets[marketId] = market;
        emit MarketUpdated(marketId);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        _operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    /// @notice Fees already credited stay with the previous recipient.
    function setFeeRecipient(address feeRecipient_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        emit FeeRecipientUpdated(feeRecipient_);
    }

    /// @notice Replace the index price source, e.g. when a feed or the adapter is
    ///         permanently broken.
    /// @dev Whoever controls the oracle controls every price, hence every liquidation
    ///      and every withdrawal of profit. This function gives the owner exactly that
    ///      power; the owner must be a multisig behind a timelock.
    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        if (oracle_.code.length == 0) revert NotAContract();
        oracle = IOracle(oracle_);
        emit OracleUpdated(oracle_);
    }

    /// @notice Disabled: an exchange without an owner could never pause, replace a broken
    ///         oracle or adjust a market.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice The guardian can pause but not unpause, so that pausing stays immediate
    ///         when the owner acts through a timelock. address(0) removes it.
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    /// @notice While paused: only fills that reduce both sides' positions, and no funding.
    ///         Deposits, withdrawals, cancels and liquidations stay open.
    ///         Pausing: owner or guardian. Unpausing: owner only.
    /// @dev Funding is suspended while paused: with opening trades blocked, the accounts
    ///      that can still trade (reducing against each other) would set the rate
    ///      unopposed. On a change of state every market's running period is closed
    ///      first: charged normally up to the pause, at zero up to the unpause.
    function setPaused(bool paused_) external {
        if (msg.sender != owner() && !(paused_ && msg.sender == guardian)) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
        if (paused != paused_) {
            uint256 count = _markets.length;
            for (uint32 marketId = 0; marketId < count; ++marketId) _closeFundingPeriod(marketId, true);
            paused = paused_;
        }
        emit Paused(paused_);
    }

    function _validateMarket(Market calldata market) private view {
        uint256 maxFeeBps = Math.max(market.makerFeeBps, market.takerFeeBps);
        if (
            market.maintenanceMarginBps == 0 ||
            market.maintenanceMarginBps > market.initialMarginBps ||
            market.initialMarginBps > BPS ||
            market.makerFeeBps > MAX_FEE_BPS ||
            market.takerFeeBps > MAX_FEE_BPS ||
            // The penalty must fit in the margin an account still has when it becomes liquidatable.
            market.liquidationPenaltyBps > market.maintenanceMarginBps ||
            // A fill that reduces a position by index notional N releases
            // maintenanceMarginBps of N and costs at most the band width on N plus the
            // fee on the fill notional, which can be up to N * (1 + band). Keeping the
            // cost below the release means a reducing fill can never lower
            // (accountValue - maintenance requirement):
            //   band + fee * (1 + band) < maintenance          (all as fractions)
            maxPriceDeviationBps * BPS + maxFeeBps * (BPS + maxPriceDeviationBps) >=
            uint256(market.maintenanceMarginBps) * BPS ||
            // Funding is charged at most MAX_FUNDING_ELAPSED (8h) at a time at the capped
            // rate. Together with a fill at the edge of the band it must not be able to
            // consume the whole maintenance margin in one step.
            maxFundingRateBps * (MAX_FUNDING_ELAPSED / FUNDING_INTERVAL) + maxPriceDeviationBps >=
            market.maintenanceMarginBps ||
            market.minOrderSize == 0 ||
            market.maxOpenInterest == 0 ||
            bytes(market.symbol).length == 0
        ) revert InvalidMarketConfig();
    }

    // =============================================================== trader

    /// @inheritdoc IExchange
    /// @dev Open while paused: liquidations stay open, so accounts must be able to add margin.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _balances[msg.sender] += amount.toInt256();
        _collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, amount);
    }

    /// @inheritdoc IExchange
    /// @dev Allowed up to `freeCollateral`, i.e. unrealized profit is withdrawable and
    ///      the cash balance may go negative. An account with open positions needs fresh
    ///      oracle prices for all of them; an account without positions needs no oracle.
    ///      Funding that is due in the account's markets is accrued first, so that it
    ///      cannot be withdrawn just before it is charged.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrueFundingOf(msg.sender);
        Health memory h = _health(msg.sender);
        if (h.value < (amount + h.initial).toInt256()) revert InsufficientFreeCollateral();
        _balances[msg.sender] -= amount.toInt256();
        _collateral.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    /// @inheritdoc IExchange
    /// @dev One-way: there is no withdrawal from the insurance fund. Recorded bad debt is a
    ///      shortfall of USDC held against what accounts and the fund are owed; USDC that
    ///      comes in without creating a claim closes that gap first, and only the rest
    ///      is credited to the fund. Either way
    ///        USDC held + totalBadDebt >= sum(accountValue) + insuranceFund
    ///      moves by the same amount on both sides. Open while paused.
    function depositInsurance(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 badDebtRepaid = _creditInsurance(amount);
        _collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit InsuranceDeposit(msg.sender, amount, badDebtRepaid);
    }

    /// @dev Books `amount` of USDC that belongs to nobody (a deposit to the fund, or the
    ///      fund's share of a penalty): recorded bad debt is repaid first, the rest goes
    ///      to the insurance fund. The fund therefore never shows money that the
    ///      contract does not hold while a shortfall is on record.
    function _creditInsurance(uint256 amount) private returns (uint256 badDebtRepaid) {
        badDebtRepaid = Math.min(amount, totalBadDebt);
        if (badDebtRepaid != 0) totalBadDebt -= badDebtRepaid;
        _insuranceFund += amount - badDebtRepaid;
    }

    /// @inheritdoc IExchange
    /// @dev Cancels every order of the caller that carries this nonce, filled or not.
    function cancelOrder(uint256 nonce) external {
        _cancelled[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    /// @inheritdoc IExchange
    /// @dev The value can only go up, so a bulk cancel can never be undone. Clients are
    ///      expected to use increasing nonces (e.g. derived from the time of signing).
    function cancelAllOrders(uint256 newMinValidNonce) external {
        if (newMinValidNonce <= _minValidNonce[msg.sender]) revert NonceNotIncreased();
        // A value far beyond any nonce in use (e.g. type(uint256).max) would disable the
        // account for good, since the threshold can never be lowered.
        if (newMinValidNonce > ((block.timestamp + 1 days) * 1000) << NONCE_TIME_SHIFT) revert NonceTooHigh();
        _minValidNonce[msg.sender] = newMinValidNonce;
        emit OrdersCancelledBelow(msg.sender, newMinValidNonce);
    }

    // ============================================================= operator

    /// @inheritdoc IExchange
    function settleMatches(Match[] calldata matches) external nonReentrant {
        if (!_operators[msg.sender]) revert NotOperator();
        uint256 gasFloor = MATCH_GAS_BASE + MATCH_GAS_PER_MARKET * _markets.length;
        for (uint256 i = 0; i < matches.length; ++i) {
            if (gasleft() < gasFloor) revert InsufficientGas();
            // Each match runs in its own call frame so that a failure rolls back only
            // that match.
            try this.executeMatch(matches[i]) {} catch (bytes memory reason) {
                emit MatchFailed(i, _hashOrder(matches[i].maker), _hashOrder(matches[i].taker), reason);
            }
        }
    }

    struct FillResult {
        bytes32 orderHash;
        uint256 fee;
        int256 oldSize;
        int256 newSize;
        MarginBefore marginBefore; // see _marginBeforeTrade
        bool smallFillAllowed; // the fill completes the order or closes the position
    }

    /// @notice Settles one match. Only callable by this contract, from `settleMatches`.
    function executeMatch(Match calldata m) external {
        if (msg.sender != address(this)) revert OnlySelf();

        uint32 marketId = m.maker.marketId;
        if (m.taker.marketId != marketId) revert MarketMismatch();
        _requireMarket(marketId);
        if (m.maker.trader == m.taker.trader) revert SelfTrade();
        if (m.maker.isBuy == m.taker.isBuy) revert SameSide();
        if (m.fillSize == 0) revert ZeroAmount();

        // The resting order sets the price; it must be within the taker's limit.
        uint256 price = m.maker.limitPrice;
        if (price == 0) revert InvalidPrice(marketId);
        if (m.taker.isBuy ? price > m.taker.limitPrice : price < m.taker.limitPrice) revert PriceNotCrossed();

        // Every fill needs a fresh index price and must be priced close to it. This is
        // what stops two accounts from moving value between them through an off-market
        // fill, and keeps the mark price (hence funding) anchored to the index.
        uint256 index = _requireInBand(marketId, price);

        // Funding up to now is charged on the positions as they were before this fill,
        // using the mark price before this fill. Every other market the two accounts are
        // exposed to is brought up to date too, so that the margin checks below see all
        // funding that is due.
        _accrueFunding(marketId);
        _accrueFundingOf(m.maker.trader);
        _accrueFundingOf(m.taker.trader);
        // The fill's premium counts towards the period that is open now.
        _recordFill(marketId, price, index);

        MarketState storage state = _marketState[marketId];
        uint256 longsBefore = state.longOpenInterest;

        FillResult memory maker = _fillSide(m.maker, m.makerSig, m.fillSize, price, false);
        FillResult memory taker = _fillSide(m.taker, m.takerSig, m.fillSize, price, true);

        // Fills below the minimum size are only for finishing an order or closing a position.
        if (
            m.fillSize < _markets[marketId].minOrderSize && !maker.smallFillAllowed && !taker.smallFillAllowed
        ) revert FillTooSmall();

        // Longs and shorts move together, so checking one side covers both. Fills that
        // do not add open interest pass even if the cap was lowered below the current level.
        if (state.longOpenInterest > longsBefore && state.longOpenInterest > _markets[marketId].maxOpenInterest) {
            revert OpenInterestCapExceeded();
        }
        _requireMarginAfterTrade(m.maker.trader, maker.oldSize, maker.newSize, maker.marginBefore);
        _requireMarginAfterTrade(m.taker.trader, taker.oldSize, taker.newSize, taker.marginBefore);

        emit Fill(
            marketId,
            m.maker.trader,
            m.taker.trader,
            maker.orderHash,
            taker.orderHash,
            m.taker.isBuy,
            m.fillSize,
            price,
            maker.fee,
            taker.fee
        );
    }

    /// @dev Validates one order of a match and applies the fill to its trader.
    function _fillSide(
        Order calldata order,
        bytes calldata signature,
        uint256 fillSize,
        uint256 price,
        bool isTaker
    ) private returns (FillResult memory r) {
        uint32 marketId = order.marketId;
        Market storage market = _markets[marketId];
        address trader = order.trader;

        r.orderHash = _hashOrder(order);
        // ECDSA.recover reverts on malformed and high-s (malleable) signatures.
        if (trader == address(0) || ECDSA.recover(r.orderHash, signature) != trader) revert InvalidSignature();
        if (_isCancelled(trader, order.nonce)) revert OrderIsCancelled();
        // Valid through `expiry` inclusive; an order without expiry, or one that expires
        // more than MAX_ORDER_LIFETIME from now, is not acceptable (yet).
        if (order.expiry == 0) revert InvalidExpiry();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (order.expiry > block.timestamp + MAX_ORDER_LIFETIME) revert InvalidExpiry();
        if (order.size < market.minOrderSize) revert OrderTooSmall();
        uint256 filled = _filled[r.orderHash] + fillSize;
        if (filled > order.size) revert Overfill();
        _filled[r.orderHash] = filled;

        _settleFunding(trader, marketId);

        int256 delta = order.isBuy ? fillSize.toInt256() : -fillSize.toInt256();
        r.oldSize = _positions[trader][marketId].size;
        r.newSize = r.oldSize + delta;

        bool reducing = _isReduction(r.oldSize, r.newSize);
        if (order.reduceOnly && !reducing) revert ReduceOnlyViolated(trader);
        if ((paused || !market.active) && !reducing) revert OnlyReducingAllowed();
        r.smallFillAllowed = filled == order.size || (r.newSize == 0 && r.oldSize != 0);

        r.marginBefore = _marginBeforeTrade(trader, r.oldSize, r.newSize);
        _changePosition(trader, marketId, delta, price);

        // fee = ceil(ceil(notional) * feeBps)
        uint256 notional = Math.mulDiv(fillSize, price, NOTIONAL_SCALE, Math.Rounding.Ceil);
        r.fee = Math.mulDiv(notional, isTaker ? market.takerFeeBps : market.makerFeeBps, BPS, Math.Rounding.Ceil);
        if (r.fee != 0) {
            _balances[trader] -= r.fee.toInt256();
            _balances[feeRecipient] += r.fee.toInt256();
        }
    }

    // ======================================================= permissionless

    /// @inheritdoc IExchange
    /// @dev The liquidator takes over up to `maxSize` of the position at the index price
    ///      (so it needs collateral of its own) and is paid part of the penalty.
    ///
    ///      Prices: the liquidated market needs a fresh price. The trader's positions in
    ///      OTHER markets whose price is unavailable (stale, or the oracle reverts) are
    ///      valued at the last index price a transaction read for that market
    ///      (`lastGoodPrice`), or at entry if there never was one; pending funding as
    ///      usual. Otherwise one dead feed (or a dust position in an illiquid market)
    ///      would make an account unliquidatable everywhere. The price of this: the
    ///      valuation of that market is as old as its last good price, so a trader can be
    ///      liquidated although healthy at the true price, or be judged too kindly.
    ///      When such a fallback valuation was used, the liquidator receives no share of
    ///      the penalty (see _chargePenaltyAndAbsorb).
    ///      The liquidator's own margin check always requires fresh prices.
    function liquidate(address trader, uint32 marketId, uint256 maxSize) external nonReentrant {
        if (trader == msg.sender) revert SelfLiquidation();
        _requireMarket(marketId);
        _accrueFunding(marketId);
        _accrueFundingOf(trader);
        _accrueFundingOf(msg.sender);

        int256 oldSize = _positions[trader][marketId].size;
        if (oldSize == 0) revert NoPosition();

        Health memory h = _healthForLiquidation(trader, marketId);
        if (h.value >= h.maintenance.toInt256()) revert NotLiquidatable();

        uint256 closeSize = Math.min(maxSize, _abs(oldSize));
        if (closeSize == 0) revert ZeroAmount();
        uint256 price = _price(marketId);
        _marketState[marketId].lastGoodPrice = price.toUint128();
        // Signed size moved from the trader to the liquidator.
        int256 moved = oldSize > 0 ? closeSize.toInt256() : -closeSize.toInt256();

        _settleFunding(trader, marketId);
        _settleFunding(msg.sender, marketId);
        int256 liquidatorOldSize = _positions[msg.sender][marketId].size;
        MarginBefore memory liquidatorBefore = _marginBeforeTrade(
            msg.sender,
            liquidatorOldSize,
            liquidatorOldSize + moved
        );
        _changePosition(trader, marketId, -moved, price);
        _changePosition(msg.sender, marketId, moved, price);

        (uint256 penalty, uint256 badDebt) = _chargePenaltyAndAbsorb(trader, marketId, closeSize, price);

        _requireMarginAfterTrade(msg.sender, liquidatorOldSize, liquidatorOldSize + moved, liquidatorBefore);

        emit Liquidation(marketId, trader, msg.sender, moved, price, penalty, badDebt);
    }

    /// @dev Charges the liquidation penalty and, if the account ends with no positions
    ///      and a negative balance, covers the deficit from the insurance fund / bad debt.
    function _chargePenaltyAndAbsorb(
        address trader,
        uint32 marketId,
        uint256 closeSize,
        uint256 price
    ) private returns (uint256 penalty, uint256 badDebt) {
        Health memory h = _healthForLiquidation(trader, marketId);

        // The penalty is capped at what the account is still worth, so that with fresh
        // prices it cannot create or enlarge a deficit. If another market had to be
        // valued without a current price (h.usedFallback), "worth" is an estimate: a loss
        // there since the last known price is not in it, and the penalty can then exceed
        // the true value and end up as a deficit later. In that case the liquidator gets
        // no share: the whole penalty stays with the insurance fund, which is the party
        // that would pay for the deficit, and nobody can profit from liquidating on a
        // price that is known to be missing.
        uint256 notional = Math.mulDiv(closeSize, price, NOTIONAL_SCALE, Math.Rounding.Ceil);
        penalty = Math.mulDiv(notional, _markets[marketId].liquidationPenaltyBps, BPS, Math.Rounding.Ceil);
        uint256 payable_ = h.value > 0 ? uint256(h.value) : 0;
        if (penalty > payable_) penalty = payable_;
        if (penalty != 0) {
            uint256 liquidatorShare = h.usedFallback ? 0 : (penalty * LIQUIDATOR_SHARE_BPS) / BPS;
            _balances[trader] -= penalty.toInt256();
            if (liquidatorShare != 0) _balances[msg.sender] += liquidatorShare.toInt256();
            _creditInsurance(penalty - liquidatorShare);
        }

        // With no positions left nothing can bring the balance back above zero.
        int256 balance = _balances[trader];
        if (h.positions == 0 && balance < 0) {
            uint256 deficit = uint256(-balance);
            uint256 fromInsurance = Math.min(deficit, _insuranceFund);
            badDebt = deficit - fromInsurance;
            _insuranceFund -= fromInsurance;
            totalBadDebt += badDebt;
            _balances[trader] = 0;
            emit DeficitAbsorbed(trader, fromInsurance, badDebt);
        }
    }

    /// @inheritdoc IExchange
    function updateFunding(uint32 marketId) external {
        _requireMarket(marketId);
        _accrueFunding(marketId);
    }

    // ============================================================== funding

    /// @dev Adds to the market's cumulative funding index, at most once per
    ///      FUNDING_INTERVAL.
    function _accrueFunding(uint32 marketId) private {
        _closeFundingPeriod(marketId, false);
    }

    /// @dev Closes the running funding period of a market and starts a new one.
    ///
    ///        rate  = funding rate of the period, see _fundingRate              per hour
    ///        index += indexPrice * rate * elapsed / 1 hour
    ///
    ///      The rate comes from the premiums observed at the period's fills; the index
    ///      price of this moment only converts the rate into USD per unit of base. The
    ///      charge covers the elapsed time, capped at MAX_FUNDING_ELAPSED. The period
    ///      accrues nothing if
    ///       - the index price is unavailable or stale,
    ///       - the market did not trade in the period,
    ///       - the exchange is paused or the market inactive (funding is suspended).
    ///      Without `force` this does nothing until FUNDING_INTERVAL has passed. It
    ///      never reverts.
    function _closeFundingPeriod(uint32 marketId, bool force) private {
        MarketState storage state = _marketState[marketId];
        uint256 elapsed = block.timestamp - state.lastFundingTime;
        if (elapsed == 0 || (!force && elapsed < FUNDING_INTERVAL)) return;

        int256 rateWad = 0;
        (uint256 index, bool usable) = _tryFreshPrice(marketId);
        if (usable) {
            state.lastGoodPrice = index.toUint128();
            if (!_fundingSuspended(marketId)) {
                rateWad = _fundingRate(state);
                uint256 charged = elapsed > MAX_FUNDING_ELAPSED ? MAX_FUNDING_ELAPSED : elapsed;
                state.cumulativeFunding +=
                    (index.toInt256() * rateWad * charged.toInt256()) /
                    (WAD * FUNDING_INTERVAL.toInt256());
            }
        }

        // A new period starts: it has no fills yet.
        state.lastFundingTime = block.timestamp;
        if (state.periodFirstFillTime != 0) {
            state.periodFirstFillTime = 0;
            state.cappedPremiumTimeSum = 0;
            state.premiumTimeSum = 0;
        }
        emit FundingUpdated(marketId, rateWad / BPS_WAD, state.cumulativeFunding, block.timestamp);
    }

    function _fundingSuspended(uint32 marketId) private view returns (bool) {
        return paused || !_markets[marketId].active;
    }

    /// @dev Records a fill. Must run after _accrueFunding, so that the fill belongs to
    ///      the period that is open.
    ///
    ///      What is recorded for funding is the fill's PREMIUM over the index of the same
    ///      moment, (price - index) / index, not its price: comparing old fill prices
    ///      with a later index would charge plain index drift as if it were a premium.
    ///      The previous fill's premium is credited with the time it stood, at most one
    ///      FUNDING_INTERVAL: a trade says nothing about the market an hour later, and a
    ///      stale last trade must not keep a premium alive while nobody accrues.
    ///      While funding is suspended (paused / inactive market) fills are not recorded.
    function _recordFill(uint32 marketId, uint256 price, uint256 index) private {
        MarketState storage state = _marketState[marketId];
        state.markPrice = price.toUint128();
        state.lastGoodPrice = index.toUint128();
        if (_fundingSuspended(marketId)) return;

        if (state.periodFirstFillTime == 0) {
            state.periodFirstFillTime = uint64(block.timestamp);
        } else {
            int256 weight = _lastFillWeight(state).toInt256();
            state.premiumTimeSum += (int256(state.lastPremium) * weight).toInt128();
            state.cappedPremiumTimeSum += (_capPremium(state.lastPremium) * weight).toInt128();
        }
        state.lastFillTime = uint64(block.timestamp);
        state.lastPremium = (((price.toInt256() - index.toInt256()) * WAD) / index.toInt256()).toInt128();
    }

    /// @dev Seconds for which the last fill's premium counts so far: the time since that
    ///      fill, at most one FUNDING_INTERVAL.
    function _lastFillWeight(MarketState storage state) private view returns (uint256) {
        return Math.min(block.timestamp - state.lastFillTime, FUNDING_INTERVAL);
    }

    /// @dev clamp(premium, ± maxFundingRateBps), WAD.
    function _capPremium(int256 premium) private view returns (int256) {
        int256 cap = maxFundingRateBps.toInt256() * BPS_WAD;
        if (premium > cap) return cap;
        if (premium < -cap) return -cap;
        return premium;
    }

    /// @dev Time-weighted average premium (WAD) of the current funding period so far,
    ///      uncapped. Informational (markTwap); the funding rate is _fundingRate.
    ///
    ///        average = sum(premium_i * weight_i) / T       T = time since the period started
    ///
    ///      weight_i is the time from fill i to the next fill (for the last fill: to now),
    ///      capped at FUNDING_INTERVAL. All other time - before the period's first fill,
    ///      beyond the cap, a whole period without fills - counts as zero premium, and
    ///      nothing is carried over from an earlier period.
    function _averagePremium(MarketState storage state) private view returns (int256) {
        uint256 period = block.timestamp - state.lastFundingTime;
        if (state.periodFirstFillTime == 0 || period == 0) return 0;
        int256 weight = _lastFillWeight(state).toInt256();
        return (int256(state.premiumTimeSum) + int256(state.lastPremium) * weight) / period.toInt256();
    }

    /// @dev Funding rate of the current period, WAD per hour:
    ///
    ///        rate = sum(clamp(premium_i, ± maxFundingRate) * weight_i) / T
    ///
    ///      with the weights of _averagePremium. Every observation is capped before it is
    ///      averaged, so the rate is within ± maxFundingRate, and a fill can never earn
    ///      more than the capped rate for the time its premium actually stood:
    ///       - a fill one second before the accrual moves the hourly rate by at most
    ///         cap / 3600, however far from the index it was;
    ///       - a fill at the edge of the band that is followed by a fair fill a minute
    ///         later counts for one minute at the cap, not for the average of a 5% premium;
    ///       - if nobody accrues for hours after the last fill, that fill is charged for
    ///         one interval at most, not for the gap;
    ///       - fills in the same block as a later fill have no weight, and an index that
    ///         drifts while trades happen at the index produces no funding.
    ///      A fill early in an otherwise quiet period does carry that period (see README,
    ///      known limitations).
    function _fundingRate(MarketState storage state) private view returns (int256) {
        uint256 period = block.timestamp - state.lastFundingTime;
        if (state.periodFirstFillTime == 0 || period == 0) return 0;
        int256 weight = _lastFillWeight(state).toInt256();
        return (int256(state.cappedPremiumTimeSum) + _capPremium(state.lastPremium) * weight) / period.toInt256();
    }

    /// @dev Accrues funding in every market in which the account has a position.
    function _accrueFundingOf(address trader) private {
        uint256 count = _markets.length;
        for (uint32 marketId = 0; marketId < count; ++marketId) {
            if (_positions[trader][marketId].size != 0) _accrueFunding(marketId);
        }
    }

    /// @dev Moves a position's pending funding into the cash balance.
    function _settleFunding(address trader, uint32 marketId) private {
        Position storage position = _positions[trader][marketId];
        int256 cumulative = _marketState[marketId].cumulativeFunding;
        if (position.size != 0) {
            _balances[trader] -= _fundingOwed(position.size, cumulative - position.lastCumulativeFunding);
        }
        position.lastCumulativeFunding = cumulative;
    }

    /// @dev USDC owed by a position (negative: owed to it) for a funding index move:
    ///      size * indexDelta / 1e30, rounded towards +infinity, i.e. payers pay the
    ///      ceiling and receivers get the floor.
    function _fundingOwed(int256 size, int256 indexDelta) private pure returns (int256 owed) {
        int256 product = size * indexDelta;
        int256 scale = int256(NOTIONAL_SCALE);
        owed = product / scale; // truncates towards zero
        if (product > 0 && product % scale != 0) owed += 1;
    }

    // ============================================================ positions

    /// @dev Applies a signed size change at `price` to a position. Funding must have been
    ///      settled first.
    ///       - Increasing (or opening): the trade notional is added to entryNotional.
    ///       - Reducing: the proportional share of entryNotional is released and the
    ///         difference to the exit notional is realized into the cash balance.
    ///       - Flipping: the whole old position is closed as above and the remainder
    ///         opens a new position whose entryNotional is the remainder's notional.
    ///      Notionals are rounded up when the trader buys and down when it sells; the
    ///      released entry share is rounded up for longs (higher cost basis) and down
    ///      for shorts (lower proceeds), so every rounding goes against the trader.
    function _changePosition(address trader, uint32 marketId, int256 delta, uint256 price) private {
        Position storage position = _positions[trader][marketId];
        int256 oldSize = position.size;
        int256 newSize = oldSize + delta;
        bool buying = delta > 0;

        if (oldSize == 0 || (oldSize > 0) == buying) {
            position.entryNotional += _tradeNotional(_abs(delta), price, buying);
        } else {
            _balances[trader] += _reducePosition(position, _abs(delta), price);
        }
        position.size = newSize;

        MarketState storage state = _marketState[marketId];
        if (oldSize > 0) state.longOpenInterest -= uint256(oldSize);
        else if (oldSize < 0) state.shortOpenInterest -= _abs(oldSize);
        if (newSize > 0) state.longOpenInterest += uint256(newSize);
        else if (newSize < 0) state.shortOpenInterest += _abs(newSize);
    }

    /// @dev Trades `absDelta` against an existing position (closing part or all of it,
    ///      possibly flipping), updates entryNotional and returns the realized PnL.
    ///      Does not touch `position.size`.
    function _reducePosition(
        Position storage position,
        uint256 absDelta,
        uint256 price
    ) private returns (int256 pnl) {
        bool wasLong = position.size > 0;
        bool buying = !wasLong;
        uint256 absOld = _abs(position.size);
        uint256 entry = position.entryNotional;

        uint256 closeSize = Math.min(absDelta, absOld);
        uint256 entryReleased = closeSize == absOld
            ? entry
            : Math.mulDiv(entry, closeSize, absOld, wasLong ? Math.Rounding.Ceil : Math.Rounding.Floor);
        uint256 exitNotional = _tradeNotional(closeSize, price, buying);

        // Long: sold for exit, bought for entry. Short: sold for entry, bought back for exit.
        pnl = wasLong
            ? exitNotional.toInt256() - entryReleased.toInt256()
            : entryReleased.toInt256() - exitNotional.toInt256();

        position.entryNotional = closeSize == absOld
            ? _tradeNotional(absDelta - closeSize, price, buying) // zero unless flipping
            : entry - entryReleased;
    }

    /// @dev USDC notional of a trade: buyers pay the ceiling, sellers receive the floor.
    function _tradeNotional(uint256 size, uint256 price, bool buying) private pure returns (uint256) {
        return Math.mulDiv(size, price, NOTIONAL_SCALE, buying ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @dev True if the position got strictly smaller without changing direction.
    function _isReduction(int256 oldSize, int256 newSize) private pure returns (bool) {
        if (newSize == 0) return oldSize != 0;
        return (oldSize > 0) == (newSize > 0) && _abs(newSize) < _abs(oldSize);
    }

    // =============================================================== margin

    struct Health {
        int256 value; // balance + unrealized PnL - pending funding
        uint256 initial; // initial margin requirement
        uint256 maintenance; // maintenance margin requirement
        uint256 positions; // number of markets with a non-zero position
        bool usedFallback; // a market was valued without a current price (liquidation only)
    }

    /// @dev Account state before a trade that strictly reduces a position without
    ///      flipping. `applies` is false (and the rest unused) for any other trade.
    struct MarginBefore {
        bool applies;
        int256 value;
        uint256 maintenance;
    }

    /// @dev Call after funding was settled and before the position is changed.
    function _marginBeforeTrade(
        address trader,
        int256 oldSize,
        int256 newSize
    ) private view returns (MarginBefore memory before) {
        if (!_isReduction(oldSize, newSize)) return before;
        Health memory h = _health(trader);
        before = MarginBefore(true, h.value, h.maintenance);
    }

    /// @dev Margin rule applied to an account after a trade changed one of its positions.
    ///      All prices must be fresh.
    ///       - Open, increase or flip: initial margin must hold.
    ///       - Position strictly reduced without flipping: the account must not end with
    ///         negative value. If it then satisfies initial margin, fine. Otherwise
    ///           (a) it must not have lowered (value - maintenance requirement), and
    ///           (b) if it was below maintenance before the trade, it must not have
    ///               lowered the ratio value / maintenance requirement either:
    ///                 valueAfter * maintBefore >= valueBefore * maintAfter.
    ///         (a) alone is not enough for an account that is already liquidatable: a
    ///         reduction releases the full maintenance rate of the reduced notional, so
    ///         (a) lets it pay up to that much to the counterparty, i.e. hand over its
    ///         last equity while keeping most of the position. (b) only lets a
    ///         liquidatable account reduce on terms that cost no more, per unit of
    ///         maintenance released, than the equity it has per unit of maintenance.
    ///         Closing everything (no maintenance left) is allowed whenever the value
    ///         stays non-negative.
    function _requireMarginAfterTrade(
        address trader,
        int256 oldSize,
        int256 newSize,
        MarginBefore memory before
    ) private view {
        Health memory h = _health(trader);
        if (before.applies && _isReduction(oldSize, newSize)) {
            if (h.value < 0) revert NegativeAccountValue(trader);
            if (h.value >= h.initial.toInt256()) return;
            int256 maintBefore = before.maintenance.toInt256();
            int256 maintAfter = h.maintenance.toInt256();
            bool healthKept = h.value - maintAfter >= before.value - maintBefore;
            bool ratioKept = before.value >= maintBefore || h.value * maintBefore >= before.value * maintAfter;
            if (!healthKept || !ratioKept) revert InsufficientMargin(trader);
            return;
        }
        if (h.value < h.initial.toInt256()) revert InsufficientMargin(trader);
    }

    /// @dev Account value and margin requirements over all markets at fresh index prices.
    ///      Reads the oracle only for markets in which the account has a position.
    ///      Long value is rounded down and short liability up; requirements are rounded up.
    function _health(address trader) private view returns (Health memory h) {
        return _healthWith(trader, false, 0);
    }

    /// @dev Valuation used to decide and settle a liquidation in `strictMarket`: that
    ///      market needs a fresh price; other markets without a usable price are valued
    ///      at their last known price, or at entry if there is none (see `liquidate`).
    function _healthForLiquidation(address trader, uint32 strictMarket) private view returns (Health memory h) {
        return _healthWith(trader, true, strictMarket);
    }

    function _healthWith(
        address trader,
        bool entryFallback,
        uint32 strictMarket
    ) private view returns (Health memory h) {
        h.value = _balances[trader];
        uint256 count = _markets.length;
        for (uint32 marketId = 0; marketId < count; ++marketId) {
            Position storage position = _positions[trader][marketId];
            int256 size = position.size;
            if (size == 0) continue;

            uint256 price;
            if (entryFallback && marketId != strictMarket) {
                bool usable;
                (price, usable) = _tryFreshPrice(marketId);
                if (!usable) {
                    // No current price: use the last one a transaction saw. If there
                    // never was one (price == 0), value the position at entry.
                    h.usedFallback = true;
                    price = _marketState[marketId].lastGoodPrice;
                }
            } else {
                price = _price(marketId);
            }

            // Notional for margin purposes, and unrealized PnL.
            uint256 notional;
            if (price != 0) {
                uint256 absSize = _abs(size);
                notional = Math.mulDiv(absSize, price, NOTIONAL_SCALE, Math.Rounding.Ceil);
                h.value += size > 0
                    ? Math.mulDiv(absSize, price, NOTIONAL_SCALE).toInt256() - position.entryNotional.toInt256()
                    : position.entryNotional.toInt256() - notional.toInt256();
            } else {
                notional = position.entryNotional;
            }
            h.value -= _fundingOwed(size, _marketState[marketId].cumulativeFunding - position.lastCumulativeFunding);

            Market storage market = _markets[marketId];
            h.initial += Math.mulDiv(notional, market.initialMarginBps, BPS, Math.Rounding.Ceil);
            h.maintenance += Math.mulDiv(notional, market.maintenanceMarginBps, BPS, Math.Rounding.Ceil);
            h.positions += 1;
        }
    }

    // =============================================================== oracle

    /// @dev A price is usable if it is at most maxPriceAge old. A timestamp in the future
    ///      is rejected: it cannot be a real observation and would stay "fresh" for longer
    ///      than intended.
    function _isFresh(uint256 updatedAt) private view returns (bool) {
        return updatedAt <= block.timestamp && block.timestamp - updatedAt <= maxPriceAge;
    }

    /// @dev Fresh index price; reverts if the oracle reverts or returns a zero or stale price.
    function _price(uint32 marketId) private view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = oracle.getPrice(marketId);
        if (price == 0) revert InvalidPrice(marketId);
        if (!_isFresh(updatedAt)) revert StalePrice(marketId);
    }

    /// @dev Reverts unless |price - index| <= index * maxPriceDeviationBps / 1e4.
    function _requireInBand(uint32 marketId, uint256 price) private view returns (uint256 index) {
        index = _price(marketId);
        uint256 diff = price > index ? price - index : index - price;
        if (diff * BPS > index * maxPriceDeviationBps) revert PriceOutOfBand(price, index);
    }

    /// @dev Non-reverting variant: `usable` is false if the oracle call fails or the
    ///      price is zero or stale.
    function _tryFreshPrice(uint32 marketId) private view returns (uint256 price, bool usable) {
        try oracle.getPrice(marketId) returns (uint256 p, uint256 updatedAt) {
            return (p, p != 0 && _isFresh(updatedAt));
        } catch {
            return (0, false);
        }
    }

    // ================================================================ views

    /// @inheritdoc IExchange
    function collateralToken() external view returns (address) {
        return address(_collateral);
    }

    /// @inheritdoc IExchange
    function marketCount() external view returns (uint32) {
        return uint32(_markets.length);
    }

    /// @inheritdoc IExchange
    function getMarket(uint32 marketId) external view returns (Market memory) {
        _requireMarket(marketId);
        return _markets[marketId];
    }

    /// @inheritdoc IExchange
    function getPosition(address trader, uint32 marketId) external view returns (Position memory) {
        return _positions[trader][marketId];
    }

    /// @inheritdoc IExchange
    function balanceOf(address trader) external view returns (int256) {
        return _balances[trader];
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function accountValue(address trader) external view returns (int256) {
        return _health(trader).value;
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function marginRequirement(address trader) external view returns (uint256 initial, uint256 maintenance) {
        Health memory h = _health(trader);
        return (h.initial, h.maintenance);
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function freeCollateral(address trader) external view returns (uint256) {
        Health memory h = _health(trader);
        int256 free = h.value - h.initial.toInt256();
        return free > 0 ? uint256(free) : 0;
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function isLiquidatable(address trader) external view returns (bool) {
        Health memory h = _health(trader);
        return h.value < h.maintenance.toInt256();
    }

    /// @notice Whether `liquidate(trader, marketId, ...)` would find the account under
    ///         maintenance margin right now, using the same valuation as `liquidate`
    ///         (other markets without a usable price are valued at their last known
    ///         price, or at entry if there is none). Unlike
    ///         `isLiquidatable` it does not revert because of another market's oracle.
    ///         False if the trader has no position in the market; reverts if this
    ///         market's own price is unavailable. Funding not yet accrued is not included.
    function isLiquidatableIn(address trader, uint32 marketId) external view returns (bool) {
        _requireMarket(marketId);
        if (_positions[trader][marketId].size == 0) return false;
        Health memory h = _healthForLiquidation(trader, marketId);
        return h.value < h.maintenance.toInt256();
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the price is stale.
    function indexPrice(uint32 marketId) external view returns (uint256) {
        _requireMarket(marketId);
        return _price(marketId);
    }

    /// @inheritdoc IExchange
    function markPrice(uint32 marketId) external view returns (uint256) {
        return _marketState[marketId].markPrice;
    }

    /// @inheritdoc IExchange
    /// @dev index now * (1 + average premium of the current funding period so far): the
    ///      price the period's fills imply relative to today's index. Equals the index if
    ///      the market has not traded in the period. Never reverts for an existing
    ///      market: returns 0 if the index price is unavailable or stale.
    function markTwap(uint32 marketId) external view returns (uint256) {
        _requireMarket(marketId);
        (uint256 index, bool usable) = _tryFreshPrice(marketId);
        if (!usable) return 0;
        return ((index.toInt256() * (WAD + _averagePremium(_marketState[marketId]))) / WAD).toUint256();
    }

    /// @inheritdoc IExchange
    /// @dev Never reverts for an existing market. This is the rate an accrual would use
    ///      if it happened now; it keeps moving until the period is accrued. Zero while
    ///      funding is suspended (paused, or the market is inactive).
    function currentFundingRate(uint32 marketId) external view returns (int256) {
        _requireMarket(marketId);
        (, bool usable) = _tryFreshPrice(marketId);
        if (!usable || _fundingSuspended(marketId)) return 0;
        return _fundingRate(_marketState[marketId]);
    }

    /// @notice Last index price of the market that a transaction read successfully (fill,
    ///         funding accrual or liquidation of that market); 0 if none yet. Used to
    ///         value the market in liquidations elsewhere while its price is unavailable.
    function lastGoodPrice(uint32 marketId) external view returns (uint256) {
        return _marketState[marketId].lastGoodPrice;
    }

    /// @inheritdoc IExchange
    function cumulativeFunding(uint32 marketId) external view returns (int256) {
        return _marketState[marketId].cumulativeFunding;
    }

    /// @notice Timestamp of the market's last funding accrual.
    function lastFundingTime(uint32 marketId) external view returns (uint256) {
        return _marketState[marketId].lastFundingTime;
    }

    /// @inheritdoc IExchange
    function openInterest(uint32 marketId) external view returns (uint256 longs, uint256 shorts) {
        MarketState storage state = _marketState[marketId];
        return (state.longOpenInterest, state.shortOpenInterest);
    }

    /// @inheritdoc IExchange
    function insuranceFund() external view returns (uint256) {
        return _insuranceFund;
    }

    /// @inheritdoc IExchange
    /// @dev The full EIP-712 digest (domain separator included); also the key of `filledSize`.
    function hashOrder(Order calldata order) external view returns (bytes32) {
        return _hashOrder(order);
    }

    /// @inheritdoc IExchange
    function filledSize(bytes32 orderHash) external view returns (uint256) {
        return _filled[orderHash];
    }

    /// @inheritdoc IExchange
    function isCancelled(address trader, uint256 nonce) external view returns (bool) {
        return _isCancelled(trader, nonce);
    }

    /// @inheritdoc IExchange
    function minValidNonce(address trader) external view returns (uint256) {
        return _minValidNonce[trader];
    }

    /// @inheritdoc IExchange
    function maxOrderLifetime() external pure returns (uint256) {
        return MAX_ORDER_LIFETIME;
    }

    /// @inheritdoc IExchange
    function isOperator(address account) external view returns (bool) {
        return _operators[account];
    }

    // ============================================================== helpers

    function _hashOrder(Order calldata order) private view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        ORDER_TYPEHASH,
                        order.trader,
                        order.marketId,
                        order.isBuy,
                        order.reduceOnly,
                        order.size,
                        order.limitPrice,
                        order.nonce,
                        order.expiry
                    )
                )
            );
    }

    function _isCancelled(address trader, uint256 nonce) private view returns (bool) {
        return nonce < _minValidNonce[trader] || _cancelled[trader][nonce];
    }

    function _requireMarket(uint32 marketId) private view {
        if (marketId >= _markets.length) revert UnknownMarket(marketId);
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
