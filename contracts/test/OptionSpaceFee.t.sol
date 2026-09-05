// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { OptionSpaceFee } from "../src/libraries/OptionSpaceFee.sol";
import { TestBase } from "./TestBase.sol";

contract OptionSpaceFeeHarness {
    function calculate(
        uint16 baseFeeBps,
        uint16 slopeBps,
        uint16 maximumFeeBps,
        uint256 utilizationBefore,
        uint256 utilizationAfter
    ) external pure returns (uint256 feeBpsScaled, uint256 premiumBpsScaled) {
        return OptionSpaceFee.calculateFeeBps(
            baseFeeBps, slopeBps, maximumFeeBps, utilizationBefore, utilizationAfter
        );
    }

    function distribute(
        uint256 tradeValue,
        OptionSpaceFee.FeeConfig memory config,
        uint256 utilizationBefore,
        uint256 utilizationAfter
    ) external pure returns (OptionSpaceFee.FeeResult memory) {
        return OptionSpaceFee.distribute(tradeValue, config, utilizationBefore, utilizationAfter);
    }
}

contract OptionSpaceFeeTest is TestBase {
    uint256 internal constant SCALE = 1e18;
    OptionSpaceFeeHarness internal harness;

    function setUp() public {
        harness = new OptionSpaceFeeHarness();
    }

    function testSharedFeeVectors() public view {
        _assertFee(20e16, 21_066_666_666_666_666_667);
        _assertFee(50e16, 26_666_666_666_666_666_667);
        _assertFee(90e16, 41_600_000_000_000_000_000);
        _assertFee(100e16, 46_666_666_666_666_666_667);
        (uint256 boundary,) = harness.calculate(20, 80, 100, SCALE, SCALE);
        assertEq(boundary, 100_000_000_000_000_000_000);
    }

    function testFeeDistributionAndUpwardRounding() public view {
        OptionSpaceFee.FeeResult memory result = harness.distribute(50_000, _config(), 0, SCALE);
        assertEq(result.totalFeeAmount, 234);
        assertEq(result.baseFeeAmount, 100);
        assertEq(result.treasuryBaseFeeAmount, 50);
        assertEq(result.premiumAmount, 134);
        assertEq(result.treasuryAmount, 184);
        assertEq(result.solverAmount, 25);
        assertEq(result.protocolAmount, 25);

        OptionSpaceFee.FeeResult memory dust = harness.distribute(1, _config(), 0, SCALE);
        assertEq(dust.totalFeeAmount, 1);
        assertEq(dust.treasuryAmount + dust.solverAmount + dust.protocolAmount, 1);
    }

    function testSplitPremiumIsNotMateriallyCheaper() public view {
        OptionSpaceFee.FeeResult memory whole = harness.distribute(50_000, _config(), 0, SCALE);
        OptionSpaceFee.FeeResult memory first = harness.distribute(25_000, _config(), 0, SCALE / 2);
        OptionSpaceFee.FeeResult memory second =
            harness.distribute(25_000, _config(), SCALE / 2, SCALE);
        uint256 splitPremium = first.premiumAmount + second.premiumAmount;
        assertGe(splitPremium, whole.premiumAmount);
        assertLe(splitPremium - whole.premiumAmount, 2);
    }

    function testRejectsConfigurationAboveTheBoundedCurve() public {
        vm.expectRevert(OptionSpaceFee.InvalidFeeConfiguration.selector);
        harness.calculate(20, 80, 90, SCALE, SCALE);
    }

    function testFuzzFeeIsMonotonic(uint256 earlier, uint256 later) public view {
        earlier = bound(earlier, 0, SCALE);
        later = bound(later, earlier, SCALE);
        (uint256 first,) = harness.calculate(20, 80, 100, 0, earlier);
        (uint256 second,) = harness.calculate(20, 80, 100, 0, later);
        assertGe(second, first);
    }

    function testFuzzDistributionAlwaysReconciles(uint256 tradeValue, uint256 utilization)
        public
        view
    {
        tradeValue = bound(tradeValue, 0, type(uint192).max);
        utilization = bound(utilization, 0, SCALE);
        OptionSpaceFee.FeeResult memory result =
            harness.distribute(tradeValue, _config(), 0, utilization);
        assertEq(
            result.treasuryAmount + result.solverAmount + result.protocolAmount,
            result.totalFeeAmount
        );
        // Separately rounded base and premium components add at most two dust units.
        assertLe(result.totalFeeAmount, tradeValue + 1);
    }

    function _assertFee(uint256 utilization, uint256 expected) internal view {
        (uint256 actual,) = harness.calculate(20, 80, 100, 0, utilization);
        assertEq(actual, expected);
    }

    function _config() internal pure returns (OptionSpaceFee.FeeConfig memory) {
        return OptionSpaceFee.FeeConfig({
            baseFeeBps: 20,
            slopeBps: 80,
            maximumFeeBps: 100,
            treasuryBaseFeeBps: 10,
            solverFeeBps: 5,
            protocolFeeBps: 5
        });
    }
}
