// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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
contract Exchange is IExchange, Ownable, ReentrancyGuard, EIP712 {
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

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,uint32 marketId,bool isBuy,bool reduceOnly,uint256 size,uint256 limitPrice,uint256 nonce,uint64 expiry)"
    );

    // ----------------------------------------------------------- immutables
    IERC20 private immutable _collateral;
    IOracle public immutable oracle;
    /// @notice Oracle prices older than this many seconds are stale.
    uint256 public immutable maxPriceAge;
    /// @notice Cap on the absolute funding rate, in bps of notional per FUNDING_INTERVAL.
    uint256 public immutable maxFundingRateBps;

    // -------------------------------------------------------------- storage
    struct MarketState {
        int256 cumulativeFunding; // USD (WAD) per 1 unit of base, paid by longs to shorts
        uint256 lastFundingTime;
        uint256 markPrice; // last fill price, 0 until the first fill
        uint256 longOpenInterest;
        uint256 shortOpenInterest;
    }

    Market[] private _markets;
    mapping(uint32 marketId => MarketState) private _marketState;
    mapping(address trader => int256) private _balances;
    mapping(address trader => mapping(uint32 marketId => Position)) private _positions;
    mapping(bytes32 orderHash => uint256) private _filled;
    mapping(address trader => mapping(uint256 nonce => bool)) private _cancelled;
    mapping(address => bool) private _operators;

    uint256 private _insuranceFund;
    /// @notice Sum of all losses that neither the losing account nor the insurance fund
    ///         could cover. The contract is short of USDC by (at most) this amount.
    uint256 public totalBadDebt;
    address public feeRecipient;
    bool public paused;

    // ---------------------------------------------------- additional events
    event FeeRecipientUpdated(address indexed feeRecipient);
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
    error ExchangePaused();
    error InvalidPrice(uint32 marketId);
    error StalePrice(uint32 marketId);
    error MarketMismatch();
    error SelfTrade();
    error SameSide();
    error PriceNotCrossed();
    error InvalidSignature();
    error OrderIsCancelled();
    error OrderExpired();
    error OrderTooSmall();
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
    /// @param maxFundingRateBps_ funding rate cap per hour, in bps.
    constructor(
        address collateral_,
        address oracle_,
        address owner_,
        address feeRecipient_,
        uint256 maxPriceAge_,
        uint256 maxFundingRateBps_
    ) Ownable(owner_) EIP712("Baldwin", "1") {
        if (collateral_ == address(0) || oracle_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (maxPriceAge_ == 0 || maxFundingRateBps_ > BPS) revert InvalidConfig();
        _collateral = IERC20(collateral_);
        oracle = IOracle(oracle_);
        maxPriceAge = maxPriceAge_;
        maxFundingRateBps = maxFundingRateBps_;
        feeRecipient = feeRecipient_;
        emit FeeRecipientUpdated(feeRecipient_);
    }

    // ================================================================ admin

    function addMarket(Market calldata market) external onlyOwner returns (uint32 marketId) {
        _validateMarket(market);
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

    /// @notice While paused: no deposits and only fills that reduce both sides' positions.
    ///         Withdrawals, cancels, funding and liquidations stay open.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function _validateMarket(Market calldata market) private pure {
        if (
            market.maintenanceMarginBps == 0 ||
            market.maintenanceMarginBps > market.initialMarginBps ||
            market.initialMarginBps > BPS ||
            market.makerFeeBps > MAX_FEE_BPS ||
            market.takerFeeBps > MAX_FEE_BPS ||
            // The penalty must fit in the margin an account still has when it becomes liquidatable.
            market.liquidationPenaltyBps > market.maintenanceMarginBps ||
            bytes(market.symbol).length == 0
        ) revert InvalidMarketConfig();
    }

    // =============================================================== trader

    /// @inheritdoc IExchange
    function deposit(uint256 amount) external nonReentrant {
        if (paused) revert ExchangePaused();
        if (amount == 0) revert ZeroAmount();
        _balances[msg.sender] += amount.toInt256();
        _collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, amount);
    }

    /// @inheritdoc IExchange
    /// @dev Allowed up to `freeCollateral`, i.e. unrealized profit is withdrawable and
    ///      the cash balance may go negative. An account with open positions needs fresh
    ///      oracle prices for all of them; an account without positions needs no oracle.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Health memory h = _health(msg.sender, true);
        if (h.value < (amount + h.initial).toInt256()) revert InsufficientFreeCollateral();
        _balances[msg.sender] -= amount.toInt256();
        _collateral.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    /// @inheritdoc IExchange
    /// @dev Cancels every order of the caller that carries this nonce, filled or not.
    function cancelOrder(uint256 nonce) external {
        _cancelled[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    // ============================================================= operator

    /// @inheritdoc IExchange
    function settleMatches(Match[] calldata matches) external nonReentrant {
        if (!_operators[msg.sender]) revert NotOperator();
        for (uint256 i = 0; i < matches.length; ++i) {
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

        // Funding up to now is charged on the positions as they were before this fill,
        // using the mark price before this fill.
        _accrueFunding(marketId);

        MarketState storage state = _marketState[marketId];
        uint256 longsBefore = state.longOpenInterest;

        FillResult memory maker = _fillSide(m.maker, m.makerSig, m.fillSize, price, false);
        FillResult memory taker = _fillSide(m.taker, m.takerSig, m.fillSize, price, true);

        // Longs and shorts move together, so checking one side covers both. Fills that
        // do not add open interest pass even if the cap was lowered below the current level.
        if (state.longOpenInterest > longsBefore && state.longOpenInterest > _markets[marketId].maxOpenInterest) {
            revert OpenInterestCapExceeded();
        }
        state.markPrice = price;

        _requireMarginAfterTrade(m.maker.trader, maker.oldSize, maker.newSize);
        _requireMarginAfterTrade(m.taker.trader, taker.oldSize, taker.newSize);

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
        if (_cancelled[trader][order.nonce]) revert OrderIsCancelled();
        if (order.expiry != 0 && block.timestamp > order.expiry) revert OrderExpired();
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
    ///      (so it needs collateral of its own) and is paid part of the penalty. Requires
    ///      fresh prices for every market in which the trader has a position.
    function liquidate(address trader, uint32 marketId, uint256 maxSize) external nonReentrant {
        if (trader == msg.sender) revert SelfLiquidation();
        _requireMarket(marketId);
        _accrueFunding(marketId);

        int256 oldSize = _positions[trader][marketId].size;
        if (oldSize == 0) revert NoPosition();

        Health memory h = _health(trader, true);
        if (h.value >= h.maintenance.toInt256()) revert NotLiquidatable();

        uint256 closeSize = Math.min(maxSize, _abs(oldSize));
        if (closeSize == 0) revert ZeroAmount();
        uint256 price = _price(marketId, true);
        // Signed size moved from the trader to the liquidator.
        int256 moved = oldSize > 0 ? closeSize.toInt256() : -closeSize.toInt256();

        _settleFunding(trader, marketId);
        _settleFunding(msg.sender, marketId);
        int256 liquidatorOldSize = _positions[msg.sender][marketId].size;
        _changePosition(trader, marketId, -moved, price);
        _changePosition(msg.sender, marketId, moved, price);

        (uint256 penalty, uint256 badDebt) = _chargePenaltyAndAbsorb(trader, marketId, closeSize, price);

        _requireMarginAfterTrade(msg.sender, liquidatorOldSize, liquidatorOldSize + moved);

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
        Health memory h = _health(trader, true);

        // The penalty is capped at what the account is still worth, so that it can never
        // create or enlarge a deficit (which the insurance fund would have to pay).
        uint256 notional = Math.mulDiv(closeSize, price, NOTIONAL_SCALE, Math.Rounding.Ceil);
        penalty = Math.mulDiv(notional, _markets[marketId].liquidationPenaltyBps, BPS, Math.Rounding.Ceil);
        uint256 payable_ = h.value > 0 ? uint256(h.value) : 0;
        if (penalty > payable_) penalty = payable_;
        if (penalty != 0) {
            uint256 liquidatorShare = (penalty * LIQUIDATOR_SHARE_BPS) / BPS;
            _balances[trader] -= penalty.toInt256();
            _balances[msg.sender] += liquidatorShare.toInt256();
            _insuranceFund += penalty - liquidatorShare;
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
    ///
    ///        rate  = clamp((mark - index) / index, ±maxFundingRateBps)   per hour
    ///        index += indexPrice * rate * elapsed / 1 hour
    ///
    ///      The rate is sampled once, at accrual time, and applied to the whole elapsed
    ///      period (capped at MAX_FUNDING_ELAPSED). If the index price is unavailable or
    ///      stale, or the market never traded, the period accrues no funding; this never
    ///      reverts, so that risk-reducing fills keep working during an oracle outage.
    function _accrueFunding(uint32 marketId) private {
        MarketState storage state = _marketState[marketId];
        uint256 elapsed = block.timestamp - state.lastFundingTime;
        if (elapsed < FUNDING_INTERVAL) return;
        if (elapsed > MAX_FUNDING_ELAPSED) elapsed = MAX_FUNDING_ELAPSED;
        state.lastFundingTime = block.timestamp;

        int256 rateWad = 0;
        (uint256 index, bool usable) = _tryFreshPrice(marketId);
        if (usable && state.markPrice != 0) {
            int256 indexInt = index.toInt256();
            rateWad = ((state.markPrice.toInt256() - indexInt) * WAD) / indexInt;
            int256 cap = maxFundingRateBps.toInt256() * BPS_WAD;
            if (rateWad > cap) rateWad = cap;
            if (rateWad < -cap) rateWad = -cap;
            state.cumulativeFunding +=
                (indexInt * rateWad * elapsed.toInt256()) /
                (WAD * FUNDING_INTERVAL.toInt256());
        }
        emit FundingUpdated(marketId, rateWad / BPS_WAD, state.cumulativeFunding, block.timestamp);
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
    }

    /// @dev Margin rule applied to an account after a trade changed one of its positions.
    ///       - Position strictly reduced without flipping: always allowed, provided the
    ///         account is not left with negative value. Without that floor, an account
    ///         could sell its position far below the index price to an accomplice and
    ///         leave the loss to the insurance fund. This branch accepts stale prices so
    ///         that positions can be reduced during an oracle outage.
    ///       - Anything else (open, increase, flip): initial margin must hold at fresh
    ///         prices.
    function _requireMarginAfterTrade(address trader, int256 oldSize, int256 newSize) private view {
        if (_isReduction(oldSize, newSize)) {
            if (_health(trader, false).value < 0) revert NegativeAccountValue(trader);
        } else {
            Health memory h = _health(trader, true);
            if (h.value < h.initial.toInt256()) revert InsufficientMargin(trader);
        }
    }

    /// @dev Account value and margin requirements over all markets at index prices.
    ///      Reads the oracle only for markets in which the account has a position.
    ///      Long value is rounded down and short liability up; requirements are rounded up.
    function _health(address trader, bool requireFresh) private view returns (Health memory h) {
        h.value = _balances[trader];
        uint256 count = _markets.length;
        for (uint32 marketId = 0; marketId < count; ++marketId) {
            Position storage position = _positions[trader][marketId];
            int256 size = position.size;
            if (size == 0) continue;

            uint256 price = _price(marketId, requireFresh);
            uint256 absSize = _abs(size);
            int256 pnl = size > 0
                ? Math.mulDiv(absSize, price, NOTIONAL_SCALE).toInt256() - position.entryNotional.toInt256()
                : position.entryNotional.toInt256() -
                    Math.mulDiv(absSize, price, NOTIONAL_SCALE, Math.Rounding.Ceil).toInt256();
            int256 funding = _fundingOwed(
                size,
                _marketState[marketId].cumulativeFunding - position.lastCumulativeFunding
            );
            h.value += pnl - funding;

            Market storage market = _markets[marketId];
            uint256 notional = Math.mulDiv(absSize, price, NOTIONAL_SCALE, Math.Rounding.Ceil);
            h.initial += Math.mulDiv(notional, market.initialMarginBps, BPS, Math.Rounding.Ceil);
            h.maintenance += Math.mulDiv(notional, market.maintenanceMarginBps, BPS, Math.Rounding.Ceil);
            h.positions += 1;
        }
    }

    // =============================================================== oracle

    function _isFresh(uint256 updatedAt) private view returns (bool) {
        return updatedAt + maxPriceAge >= block.timestamp;
    }

    /// @dev Index price; reverts if the oracle reverts, returns zero or, when
    ///      `requireFresh`, returns a stale price.
    function _price(uint32 marketId, bool requireFresh) private view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = oracle.getPrice(marketId);
        if (price == 0) revert InvalidPrice(marketId);
        if (requireFresh && !_isFresh(updatedAt)) revert StalePrice(marketId);
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
        return _health(trader, true).value;
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function marginRequirement(address trader) external view returns (uint256 initial, uint256 maintenance) {
        Health memory h = _health(trader, true);
        return (h.initial, h.maintenance);
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function freeCollateral(address trader) external view returns (uint256) {
        Health memory h = _health(trader, true);
        int256 free = h.value - h.initial.toInt256();
        return free > 0 ? uint256(free) : 0;
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the account has a position in a market whose price is stale.
    function isLiquidatable(address trader) external view returns (bool) {
        Health memory h = _health(trader, true);
        return h.value < h.maintenance.toInt256();
    }

    /// @inheritdoc IExchange
    /// @dev Reverts if the price is stale.
    function indexPrice(uint32 marketId) external view returns (uint256) {
        _requireMarket(marketId);
        return _price(marketId, true);
    }

    /// @inheritdoc IExchange
    function markPrice(uint32 marketId) external view returns (uint256) {
        return _marketState[marketId].markPrice;
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
        return _cancelled[trader][nonce];
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

    function _requireMarket(uint32 marketId) private view {
        if (marketId >= _markets.length) revert UnknownMarket(marketId);
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
