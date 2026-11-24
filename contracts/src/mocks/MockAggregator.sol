// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Test double for a Chainlink aggregator (price feed or sequencer uptime feed).
contract MockAggregator {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    /// @notice Price feed style: startedAt == updatedAt.
    function set(int256 answer_, uint256 updatedAt_) external {
        setRound(answer_, updatedAt_, updatedAt_);
    }

    function setRound(int256 answer_, uint256 startedAt_, uint256 updatedAt_) public {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}
