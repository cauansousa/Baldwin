// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IOracle} from "../interfaces/IOracle.sol";

/// @notice Test/local oracle. Anyone can set prices. NEVER deploy to production.
contract MockOracle is IOracle {
    struct Price {
        uint256 priceWad;
        uint256 updatedAt;
    }

    mapping(uint32 marketId => Price) private _prices;
    bool public broken;

    event PriceSet(uint32 indexed marketId, uint256 priceWad, uint256 updatedAt);

    error PriceNotSet(uint32 marketId);
    error OracleBroken();

    /// @notice Set a price stamped with the current block time.
    function setPrice(uint32 marketId, uint256 priceWad) external {
        setPriceAt(marketId, priceWad, block.timestamp);
    }

    /// @notice Set a price with an explicit timestamp (to simulate stale data).
    function setPriceAt(uint32 marketId, uint256 priceWad, uint256 updatedAt) public {
        _prices[marketId] = Price(priceWad, updatedAt);
        emit PriceSet(marketId, priceWad, updatedAt);
    }

    /// @notice Make getPrice revert (to simulate a dead feed).
    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function getPrice(uint32 marketId) external view returns (uint256 priceWad, uint256 updatedAt) {
        if (broken) revert OracleBroken();
        Price memory p = _prices[marketId];
        if (p.priceWad == 0) revert PriceNotSet(marketId);
        return (p.priceWad, p.updatedAt);
    }
}
