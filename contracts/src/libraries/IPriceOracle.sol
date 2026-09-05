// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Adapter boundary for a future oracle/provider implementation.
interface IPriceOracle {
    function getPrice(address token)
        external
        view
        returns (uint256 price, uint8 priceDecimals, uint64 observedAt, bytes32 snapshotId);
}
