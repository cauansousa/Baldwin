// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IOracle} from "../interfaces/IOracle.sol";

/// @dev Minimal subset of Chainlink's AggregatorV3Interface.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ChainlinkOracle
/// @notice Maps each market to a Chainlink USD feed and normalizes answers to WAD.
///         On an L2 it can additionally consult Chainlink's sequencer uptime feed.
/// @dev The owner chooses the feeds and is therefore fully trusted for prices.
///
///      getPrice reverts (instead of returning a flagged value) when
///       - the market has no feed,
///       - the sequencer is down, its feed has no round yet, or it came back less than
///         `sequencerGracePeriod` ago,
///       - the answer is not positive, the round is incomplete or dated in the future,
///       - the answer is older than the market's `maxStaleness` (the feed's heartbeat
///         plus a margin). The exchange applies its own global maxPriceAge on top.
contract ChainlinkOracle is IOracle, Ownable2Step {
    struct Feed {
        AggregatorV3Interface aggregator;
        uint8 decimals;
        uint32 maxStaleness; // seconds
    }

    /// @notice Chainlink L2 sequencer uptime feed (answer 0 = up, 1 = down);
    ///         address(0) disables the check (L1, or chains without such a feed).
    AggregatorV3Interface public sequencerUptimeFeed;
    /// @notice Seconds after the sequencer came back up during which prices are still
    ///         rejected, so that feeds and users can catch up before liquidations resume.
    uint256 public sequencerGracePeriod;

    mapping(uint32 marketId => Feed) private _feeds;

    event FeedSet(uint32 indexed marketId, address aggregator, uint8 decimals, uint32 maxStaleness);
    event SequencerUptimeFeedSet(address indexed feed, uint256 gracePeriod);

    error FeedNotSet(uint32 marketId);
    error InvalidFeed();
    error InvalidAnswer(uint32 marketId);
    error FeedStale(uint32 marketId, uint256 updatedAt);
    error SequencerDown();
    error SequencerGracePeriodNotOver();
    error RenounceDisabled();

    constructor(address owner_, address sequencerUptimeFeed_, uint256 sequencerGracePeriod_) Ownable(owner_) {
        _setSequencerUptimeFeed(sequencerUptimeFeed_, sequencerGracePeriod_);
    }

    /// @notice Set, replace or (with address(0)) disable the sequencer uptime check and
    ///         its grace period. This is the way out if the uptime feed itself breaks,
    ///         which would otherwise make every price unavailable for good.
    function setSequencerUptimeFeed(address feed, uint256 gracePeriod) external onlyOwner {
        _setSequencerUptimeFeed(feed, gracePeriod);
    }

    function _setSequencerUptimeFeed(address feed, uint256 gracePeriod) private {
        if (feed != address(0) && feed.code.length == 0) revert InvalidFeed();
        sequencerUptimeFeed = AggregatorV3Interface(feed);
        sequencerGracePeriod = gracePeriod;
        emit SequencerUptimeFeedSet(feed, gracePeriod);
    }

    /// @notice Disabled: without an owner a broken feed could never be replaced.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Set (or replace) the feed of a market. Decimals are read once and cached.
    /// @param maxStaleness seconds after which an answer of this feed is rejected; use the
    ///        feed's heartbeat plus a margin.
    function setFeed(uint32 marketId, address aggregator, uint32 maxStaleness) external onlyOwner {
        if (aggregator == address(0) || maxStaleness == 0) revert InvalidFeed();
        uint8 feedDecimals = AggregatorV3Interface(aggregator).decimals();
        if (feedDecimals > 36) revert InvalidFeed();
        _feeds[marketId] = Feed(AggregatorV3Interface(aggregator), feedDecimals, maxStaleness);
        emit FeedSet(marketId, aggregator, feedDecimals, maxStaleness);
    }

    function feedOf(
        uint32 marketId
    ) external view returns (address aggregator, uint8 feedDecimals, uint32 maxStaleness) {
        Feed storage feed = _feeds[marketId];
        return (address(feed.aggregator), feed.decimals, feed.maxStaleness);
    }

    /// @inheritdoc IOracle
    function getPrice(uint32 marketId) external view returns (uint256 priceWad, uint256 updatedAt) {
        Feed memory feed = _feeds[marketId];
        if (address(feed.aggregator) == address(0)) revert FeedNotSet(marketId);

        _requireSequencerUp();

        int256 answer;
        (, answer, , updatedAt, ) = feed.aggregator.latestRoundData();
        // updatedAt == 0 means the round is not complete; a timestamp in the future
        // cannot be a real observation.
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidAnswer(marketId);
        if (block.timestamp - updatedAt > feed.maxStaleness) revert FeedStale(marketId, updatedAt);

        if (feed.decimals <= 18) {
            priceWad = uint256(answer) * 10 ** (18 - feed.decimals);
        } else {
            priceWad = uint256(answer) / 10 ** (feed.decimals - 18);
        }
        // A positive answer can only truncate to zero with >18 feed decimals.
        if (priceWad == 0) revert InvalidAnswer(marketId);
    }

    /// @dev Chainlink's documented L2 pattern: answer 0 means the sequencer is up and
    ///      `startedAt` is when that status began. While the sequencer is down, L2 prices
    ///      can be stale without looking stale; right after it comes back, users need
    ///      time to react before their positions are judged at the new prices.
    function _requireSequencerUp() private view {
        AggregatorV3Interface uptimeFeed = sequencerUptimeFeed;
        if (address(uptimeFeed) == address(0)) return;
        (, int256 answer, uint256 startedAt, , ) = uptimeFeed.latestRoundData();
        // startedAt == 0: the uptime feed has not been initialized on this chain yet.
        if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) revert SequencerDown();
        if (block.timestamp - startedAt <= sequencerGracePeriod) revert SequencerGracePeriodNotOver();
    }
}
