// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IOracle
/// @notice Index price source for the exchange.
interface IOracle {
    /// @notice Latest index price of a market.
    /// @dev Must revert if no usable price exists. Staleness is NOT judged here:
    ///      the exchange compares `updatedAt` with its own maximum age.
    /// @return priceWad USD per 1 unit of base, 18 decimals, strictly positive.
    /// @return updatedAt Unix timestamp of the last price update.
    function getPrice(uint32 marketId) external view returns (uint256 priceWad, uint256 updatedAt);
}
