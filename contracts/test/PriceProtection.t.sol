// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PriceProtection } from "../src/libraries/PriceProtection.sol";
import { TestBase } from "./TestBase.sol";

contract PriceProtectionHarness {
    function fresh(uint64 observedAt, uint64 currentTime, uint64 maxAge) external pure {
        PriceProtection.assertFresh(observedAt, currentTime, maxAge);
    }

    function identity(
        address expectedToken,
        bytes32 approvedSnapshotId,
        address actualToken,
        bytes32 actualSnapshotId
    ) external pure {
        PriceProtection.assertApprovedSnapshot(
            expectedToken, approvedSnapshotId, actualToken, actualSnapshotId
        );
    }

    function deviation(
        address referenceToken,
        uint256 referencePrice,
        uint8 referenceDecimals,
        address actualToken,
        uint256 actualPrice,
        uint8 actualDecimals,
        uint256 maximumDeviationBps
    ) external pure {
        PriceProtection.assertWithinDeviation(
            referenceToken,
            referencePrice,
            referenceDecimals,
            actualToken,
            actualPrice,
            actualDecimals,
            maximumDeviationBps
        );
    }

    function minimum(uint256 outputValue, uint256 maximumDeviationBps)
        external
        pure
        returns (uint256)
    {
        return PriceProtection.minimumTreasuryInputValue(outputValue, maximumDeviationBps);
    }

    function exchange(uint256 inputValue, uint256 outputValue, uint256 maximumDeviationBps)
        external
        pure
    {
        PriceProtection.assertMinimumTreasuryExchangeValue(
            inputValue, outputValue, maximumDeviationBps
        );
    }
}

contract PriceProtectionTest is TestBase {
    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);
    PriceProtectionHarness internal harness;

    function setUp() public {
        harness = new PriceProtectionHarness();
    }

    function testRejectsStalePrice() public {
        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.PriceIsStale.selector, 100, 221, 120)
        );
        harness.fresh(100, 221, 120);
    }

    function testRejectsFuturePrice() public {
        vm.expectRevert(abi.encodeWithSelector(PriceProtection.PriceFromFuture.selector, 222, 221));
        harness.fresh(222, 221, 120);
    }

    function testRequiresApprovedSnapshotIdentity() public {
        bytes32 snapshotId = keccak256("snapshot");
        harness.identity(USDC, snapshotId, USDC, snapshotId);

        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.PriceTokenMismatch.selector, USDC, WETH)
        );
        harness.identity(USDC, snapshotId, WETH, snapshotId);

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceSnapshotNotApproved.selector, snapshotId, bytes32(uint256(1))
            )
        );
        harness.identity(USDC, snapshotId, USDC, bytes32(uint256(1)));
    }

    function testRejectsExcessiveDeviation() public {
        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.PriceDeviationTooHigh.selector, 100, 102)
        );
        harness.deviation(USDC, 100, 2, USDC, 102, 2, 100);
    }

    function testChecksMinimumTreasuryExchangeValue() public view {
        assertEq(harness.minimum(1_000, 100), 990);
        harness.exchange(990, 1_000, 100);
        harness.exchange(991, 1_000, 100);
    }

    function testRejectsExchangeBelowMinimum() public {
        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.TreasuryExchangeValueTooLow.selector, 989, 990)
        );
        harness.exchange(989, 1_000, 100);
    }
}
