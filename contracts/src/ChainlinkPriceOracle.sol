// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IPriceOracle } from "./libraries/IPriceOracle.sol";

/// @notice Chainlink Data Feeds adapter for a fixed set of managed tokens.
/// @dev Feed answers are explicitly normalized to the protocol settlement
/// scale. The raw feed round, answer and normalization scale are bound into
/// the snapshot fingerprint, so this is not a silent fixture-price fallback.
interface IChainlinkAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

contract ChainlinkPriceOracle is IPriceOracle {
    bytes32 public constant QUOTE_CURRENCY = keccak256("USD");

    mapping(address token => address feed) public feedFor;
    uint8 public immutable settlementPriceDecimals;

    error InvalidConfiguration();
    error FeedNotConfigured(address token);
    error InvalidRound(address token, address feed);
    error InvalidAnswer(address token, int256 answer);
    error InvalidTimestamp(address token);
    error RoundNotAnswered(address token, uint80 roundId, uint80 answeredInRound);

    constructor(address[] memory tokens, address[] memory feeds, uint8 settlementPriceDecimals_) {
        if (tokens.length == 0 || tokens.length != feeds.length) revert InvalidConfiguration();
        if (settlementPriceDecimals_ > 36) revert InvalidConfiguration();
        settlementPriceDecimals = settlementPriceDecimals_;
        for (uint256 i; i < tokens.length; ++i) {
            if (
                tokens[i] == address(0) || feeds[i] == address(0)
                    || feedFor[tokens[i]] != address(0)
            ) {
                revert InvalidConfiguration();
            }
            feedFor[tokens[i]] = feeds[i];
        }
    }

    function getPrice(address token)
        external
        view
        returns (uint256 price, uint8 priceDecimals, uint64 observedAt, bytes32 snapshotId)
    {
        address feed = feedFor[token];
        if (feed == address(0)) revert FeedNotConfigured(token);
        uint8 decimals_ = IChainlinkAggregatorV3(feed).decimals();
        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = IChainlinkAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert InvalidAnswer(token, answer);
        if (updatedAt == 0 || updatedAt > type(uint64).max || startedAt > updatedAt) {
            revert InvalidTimestamp(token);
        }
        if (roundId == 0 || answeredInRound < roundId) {
            revert RoundNotAnswered(token, roundId, answeredInRound);
        }
        if (decimals_ > 36) revert InvalidRound(token, feed);
        if (settlementPriceDecimals < decimals_) {
            uint256 scale = 10 ** (decimals_ - settlementPriceDecimals);
            price = (uint256(answer) + scale / 2) / scale;
        } else {
            price = uint256(answer) * 10 ** (settlementPriceDecimals - decimals_);
        }
        if (price == 0) revert InvalidAnswer(token, answer);
        priceDecimals = settlementPriceDecimals;
        observedAt = uint64(updatedAt);
        snapshotId = keccak256(
            abi.encode(
                feed,
                roundId,
                answer,
                decimals_,
                settlementPriceDecimals,
                price,
                updatedAt,
                answeredInRound
            )
        );
    }
}
