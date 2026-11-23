// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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
/// @dev The owner chooses the feeds and is therefore fully trusted for prices.
contract ChainlinkOracle is IOracle, Ownable {
    struct Feed {
        AggregatorV3Interface aggregator;
        uint8 decimals;
    }

    mapping(uint32 marketId => Feed) private _feeds;

    event FeedSet(uint32 indexed marketId, address aggregator, uint8 decimals);

    error FeedNotSet(uint32 marketId);
    error InvalidFeed();
    error InvalidAnswer(uint32 marketId);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Set (or replace) the feed of a market. Decimals are read once and cached.
    function setFeed(uint32 marketId, address aggregator) external onlyOwner {
        if (aggregator == address(0)) revert InvalidFeed();
        uint8 feedDecimals = AggregatorV3Interface(aggregator).decimals();
        if (feedDecimals > 36) revert InvalidFeed();
        _feeds[marketId] = Feed(AggregatorV3Interface(aggregator), feedDecimals);
        emit FeedSet(marketId, aggregator, feedDecimals);
    }

    function feedOf(uint32 marketId) external view returns (address aggregator, uint8 feedDecimals) {
        Feed storage feed = _feeds[marketId];
        return (address(feed.aggregator), feed.decimals);
    }

    /// @inheritdoc IOracle
    function getPrice(uint32 marketId) external view returns (uint256 priceWad, uint256 updatedAt) {
        Feed memory feed = _feeds[marketId];
        if (address(feed.aggregator) == address(0)) revert FeedNotSet(marketId);

        int256 answer;
        (, answer, , updatedAt, ) = feed.aggregator.latestRoundData();
        // updatedAt == 0 means the round is not complete; a timestamp in the future
        // cannot be a real observation.
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidAnswer(marketId);

        if (feed.decimals <= 18) {
            priceWad = uint256(answer) * 10 ** (18 - feed.decimals);
        } else {
            priceWad = uint256(answer) / 10 ** (feed.decimals - 18);
        }
        // A positive answer can only truncate to zero with >18 feed decimals.
        if (priceWad == 0) revert InvalidAnswer(marketId);
    }
}
