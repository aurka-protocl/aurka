// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IPriceOracle } from "../../src/libraries/IPriceOracle.sol";

/// @notice Deterministic approved-price fixture used by router tests.
contract MockPriceOracle is IPriceOracle {
    struct Price {
        uint256 value;
        uint8 decimals;
        uint64 observedAt;
        bytes32 snapshotId;
    }

    mapping(address token => Price price) private _prices;

    function setPrice(
        address token,
        uint256 value,
        uint8 decimals,
        uint64 observedAt,
        bytes32 snapshotId
    ) external {
        _prices[token] = Price(value, decimals, observedAt, snapshotId);
    }

    function getPrice(address token)
        external
        view
        returns (uint256 price, uint8 priceDecimals, uint64 observedAt, bytes32 snapshotId)
    {
        Price memory current = _prices[token];
        return (current.value, current.decimals, current.observedAt, current.snapshotId);
    }
}
