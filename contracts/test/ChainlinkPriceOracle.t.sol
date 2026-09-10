// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ChainlinkPriceOracle, IChainlinkAggregatorV3 } from "../src/ChainlinkPriceOracle.sol";
import { PriceProtection } from "../src/libraries/PriceProtection.sol";
import { TestBase } from "./TestBase.sol";

contract MockChainlinkFeed is IChainlinkAggregatorV3 {
    uint8 private immutable _decimals;
    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    function setRound(
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) external {
        _roundId = roundId;
        _answer = answer;
        _startedAt = startedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}

contract ChainlinkPriceOracleTest is TestBase {
    function testReturnsNativeDecimalsAndRoundFingerprint() public {
        MockChainlinkFeed feed = new MockChainlinkFeed(8);
        feed.setRound(7, 1_234_567_890, 100, 101, 7);
        address token = address(0xBEEF);
        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        tokens[0] = token;
        feeds[0] = address(feed);
        ChainlinkPriceOracle oracle = new ChainlinkPriceOracle(tokens, feeds, 8);

        (uint256 price, uint8 decimals, uint64 observedAt, bytes32 snapshotId) =
            oracle.getPrice(token);
        assertEq(price, 1_234_567_890);
        assertEq(decimals, 8);
        assertEq(observedAt, 101);
        assertEq(
            snapshotId,
            keccak256(
                abi.encode(
                    address(feed),
                    uint80(7),
                    int256(1_234_567_890),
                    uint8(8),
                    uint8(8),
                    uint256(1_234_567_890),
                    uint256(101),
                    uint80(7)
                )
            )
        );
    }

    function testRejectsUnansweredRoundAndNonPositiveAnswer() public {
        MockChainlinkFeed feed = new MockChainlinkFeed(8);
        feed.setRound(7, 1, 100, 101, 6);
        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        tokens[0] = address(0xBEEF);
        feeds[0] = address(feed);
        ChainlinkPriceOracle oracle = new ChainlinkPriceOracle(tokens, feeds, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkPriceOracle.RoundNotAnswered.selector, tokens[0], uint80(7), uint80(6)
            )
        );
        oracle.getPrice(tokens[0]);

        feed.setRound(7, 0, 100, 101, 7);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkPriceOracle.InvalidAnswer.selector, tokens[0], int256(0)
            )
        );
        oracle.getPrice(tokens[0]);
    }

    function testStaleRoundIsRejectedBySettlementFreshnessGuard() public {
        MockChainlinkFeed feed = new MockChainlinkFeed(8);
        feed.setRound(8, 1_0000_0000, 100, 100, 8);
        address token = address(0xBEEF);
        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        tokens[0] = token;
        feeds[0] = address(feed);
        ChainlinkPriceOracle oracle = new ChainlinkPriceOracle(tokens, feeds, 0);

        (,, uint64 observedAt,) = oracle.getPrice(token);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceIsStale.selector, uint64(100), uint64(221), uint64(120)
            )
        );
        this.assertFresh(observedAt, 221, 120);
    }

    function assertFresh(uint64 observedAt, uint64 currentTime, uint64 maxAge) external pure {
        PriceProtection.assertFresh(observedAt, currentTime, maxAge);
    }
}
