// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DirectSettlement } from "../src/libraries/DirectSettlement.sol";
import { OptionSpaceFee } from "../src/libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "../src/libraries/PortfolioBounds.sol";
import { PriceProtection } from "../src/libraries/PriceProtection.sol";
import { TestBase } from "./TestBase.sol";
import { SettlementVectors } from "./SettlementVectors.sol";

contract DirectSettlementHarness {
    function solve(
        PortfolioBounds.AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 requested,
        uint256 maximumTransactionValue,
        uint256 capacityBaseline,
        uint256 consumedBefore,
        OptionSpaceFee.FeeConfig memory config,
        PriceProtection.SettlementInput memory priceInput,
        DirectSettlement.CapacityEpoch memory epoch
    ) external pure returns (DirectSettlement.FillResult memory) {
        return DirectSettlement.maximumSafeFill(
            assets,
            traderInputToken,
            traderOutputToken,
            requested,
            maximumTransactionValue,
            capacityBaseline,
            consumedBefore,
            config,
            priceInput,
            epoch,
            priceInput.currentTime
        );
    }
}

contract DirectSettlementTest is TestBase {
    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);
    address internal constant LINK = address(0x1003);
    uint256 internal constant SCALE = 1e18;
    DirectSettlementHarness internal harness;

    function setUp() public {
        harness = new DirectSettlementHarness();
    }

    function testCanonicalFillIncludesEveryFeeTransfer() public view {
        assertEq(_epoch(WETH, USDC, 50_000, 0).capacityEpochId, SettlementVectors.CAPACITY_EPOCH_ID);
        DirectSettlement.FillResult memory result = harness.solve(
            _portfolio(),
            WETH,
            USDC,
            SettlementVectors.REQUESTED_VALUE,
            SettlementVectors.EXECUTED_VALUE,
            SettlementVectors.EXECUTED_VALUE,
            0,
            _config(),
            _priceInput(WETH, USDC),
            _epoch(WETH, USDC, 50_000, 0)
        );
        assertEq(result.maximumSafeFill, SettlementVectors.EXECUTED_VALUE);
        assertEq(result.fees.totalFeeAmount, SettlementVectors.TOTAL_FEE);
        assertEq(result.fees.baseFeeAmount, 100);
        assertEq(result.fees.treasuryBaseFeeAmount, 50);
        assertEq(result.fees.premiumAmount, 134);
        assertEq(result.fees.treasuryAmount, SettlementVectors.TREASURY_FEE);
        assertEq(result.fees.solverAmount, SettlementVectors.SOLVER_FEE);
        assertEq(result.fees.protocolAmount, SettlementVectors.PROTOCOL_FEE);
        assertEq(result.traderOutputValue, SettlementVectors.TRADER_OUTPUT_VALUE);
        assertEq(result.treasuryOutputValue, SettlementVectors.TREASURY_OUTPUT_VALUE);
        assertEq(result.postTrade[0].value, SettlementVectors.FINAL_USDC);
        assertEq(result.postTrade[1].value, SettlementVectors.FINAL_WETH);
        assertEq(result.postTrade[2].value, SettlementVectors.FINAL_LINK);
        assertEq(
            result.postTrade[0].value + result.postTrade[1].value + result.postTrade[2].value,
            SettlementVectors.FINAL_NAV
        );
    }

    function testSplitUsesTheSameBaselineAndOnlyRoundsByTwoUnits() public view {
        DirectSettlement.FillResult memory first = harness.solve(
            _portfolio(),
            WETH,
            USDC,
            25_000,
            50_000,
            50_000,
            0,
            _config(),
            _priceInput(WETH, USDC),
            _epoch(WETH, USDC, 50_000, 0)
        );
        DirectSettlement.FillResult memory second = harness.solve(
            first.postTrade,
            WETH,
            USDC,
            25_000,
            50_000,
            50_000,
            25_000,
            _config(),
            _priceInput(WETH, USDC),
            _epoch(WETH, USDC, 50_000, 25_000)
        );
        DirectSettlement.FillResult memory whole = harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            _priceInput(WETH, USDC),
            _epoch(WETH, USDC, 50_000, 0)
        );
        assertEq(first.utilizationAfter, SCALE / 2);
        assertEq(second.utilizationAfter, SCALE);
        assertEq(first.fees.totalFeeAmount + second.fees.totalFeeAmount, whole.fees.totalFeeAmount);
        assertEq(second.postTrade[0].value - whole.postTrade[0].value, 2);
    }

    function testDirectSettlementRejectsStalePrice() public {
        PriceProtection.SettlementInput memory input = _priceInput(WETH, USDC);
        input.traderInputExecutionPrice.observedAt = 100;
        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.PriceIsStale.selector, 100, 221, 120)
        );
        harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            input,
            _epoch(WETH, USDC, 50_000, 0)
        );
    }

    function testDirectSettlementRejectsFuturePrice() public {
        PriceProtection.SettlementInput memory input = _priceInput(WETH, USDC);
        input.traderInputExecutionPrice.observedAt = 222;
        vm.expectRevert(abi.encodeWithSelector(PriceProtection.PriceFromFuture.selector, 222, 221));
        harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            input,
            _epoch(WETH, USDC, 50_000, 0)
        );
    }

    function testDirectSettlementRejectsMismatchedPriceToken() public {
        PriceProtection.SettlementInput memory input = _priceInput(WETH, USDC);
        input.traderInputExecutionPrice.token = USDC;
        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.PriceTokenMismatch.selector, WETH, USDC)
        );
        harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            input,
            _epoch(WETH, USDC, 50_000, 0)
        );
    }

    function testDirectSettlementRejectsExcessivePriceDeviation() public {
        PriceProtection.SettlementInput memory input = _priceInput(WETH, USDC);
        input.traderInputExecutionPrice.price = 102;
        vm.expectRevert(
            abi.encodeWithSelector(PriceProtection.PriceDeviationTooHigh.selector, 1, 102)
        );
        harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            input,
            _epoch(WETH, USDC, 50_000, 0)
        );
    }

    function testDirectSettlementRejectsBelowMinimumTreasuryExchange() public {
        PriceProtection.SettlementInput memory input = _priceInput(WETH, USDC);
        input.traderInputAmount = 49_000;
        input.traderOutputAmount = 50_000;
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.TreasuryExchangeValueTooLow.selector, 49_000, 49_500
            )
        );
        harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            input,
            _epoch(WETH, USDC, 50_000, 0)
        );
    }

    function testDirectSettlementRejectsChangedRiskCertificateEpoch() public {
        DirectSettlement.CapacityEpoch memory epoch = _epoch(WETH, USDC, 50_000, 0);
        epoch.riskCertificateHash = bytes32(uint256(6));
        vm.expectRevert(
            abi.encodeWithSelector(
                DirectSettlement.CapacityEpochMismatch.selector,
                epoch.capacityEpochId,
                DirectSettlement.capacityEpochId(epoch)
            )
        );
        harness.solve(
            _portfolio(),
            WETH,
            USDC,
            50_000,
            50_000,
            50_000,
            0,
            _config(),
            _priceInput(WETH, USDC),
            epoch
        );
    }

    function testDirectSettlementReportsExhaustedCapacity() public view {
        DirectSettlement.FillResult memory result = harness.solve(
            _portfolio(),
            WETH,
            USDC,
            1,
            50_000,
            50_000,
            50_000,
            _config(),
            _priceInput(WETH, USDC),
            _epoch(WETH, USDC, 50_000, 50_000)
        );
        assertEq(result.maximumSafeFill, 0);
        assertEq(
            uint256(result.bindingConstraint),
            uint256(PortfolioBounds.Constraint.CAPACITY_EXHAUSTED)
        );
    }

    function _priceInput(address traderInputToken, address traderOutputToken)
        internal
        pure
        returns (PriceProtection.SettlementInput memory input)
    {
        PriceProtection.Snapshot memory inputSnapshot = PriceProtection.Snapshot({
            token: traderInputToken,
            snapshotId: bytes32(uint256(1)),
            price: 1,
            priceDecimals: 0,
            observedAt: 200
        });
        PriceProtection.Snapshot memory inputExecution = PriceProtection.Snapshot({
            token: traderInputToken,
            snapshotId: bytes32(uint256(1)),
            price: 1,
            priceDecimals: 0,
            observedAt: 200
        });
        PriceProtection.Snapshot memory outputSnapshot = PriceProtection.Snapshot({
            token: traderOutputToken,
            snapshotId: bytes32(uint256(2)),
            price: 1,
            priceDecimals: 0,
            observedAt: 200
        });
        PriceProtection.Snapshot memory outputExecution = PriceProtection.Snapshot({
            token: traderOutputToken,
            snapshotId: bytes32(uint256(2)),
            price: 1,
            priceDecimals: 0,
            observedAt: 200
        });
        input = PriceProtection.SettlementInput({
            traderInputToken: traderInputToken,
            traderOutputToken: traderOutputToken,
            traderInputReferencePrice: inputSnapshot,
            traderInputExecutionPrice: inputExecution,
            traderOutputReferencePrice: outputSnapshot,
            traderOutputExecutionPrice: outputExecution,
            approvedTraderInputSnapshotId: bytes32(uint256(1)),
            approvedTraderOutputSnapshotId: bytes32(uint256(2)),
            traderInputAmount: 50_000,
            traderOutputAmount: 49_816,
            traderInputDecimals: 0,
            traderOutputDecimals: 0,
            valueDecimals: 0,
            currentTime: 221,
            maximumPriceAgeSeconds: 120,
            maximumPriceDeviationBps: 100
        });
    }

    function _epoch(
        address traderInputToken,
        address traderOutputToken,
        uint256 capacityBaseline,
        uint256 consumedBefore
    ) internal pure returns (DirectSettlement.CapacityEpoch memory epoch) {
        epoch = DirectSettlement.CapacityEpoch({
            positionIdHash: keccak256("position:example"),
            traderInputTokenId: traderInputToken == WETH ? keccak256("WETH") : keccak256("USDC"),
            traderOutputTokenId: traderOutputToken == WETH ? keccak256("WETH") : keccak256("USDC"),
            balanceSnapshot: bytes32(uint256(3)),
            priceSnapshot: bytes32(uint256(4)),
            portfolioPriceSnapshot: bytes32(uint256(6)),
            policyNonce: 1,
            riskCertificateHash: bytes32(uint256(5)),
            aquaStrategyHash: bytes32(uint256(7)),
            capacityBaseline: capacityBaseline,
            consumedBefore: consumedBefore,
            chainId: 31_337,
            verifyingContract: address(0x1111111111111111111111111111111111111111),
            capacityEpochId: bytes32(0)
        });
        epoch.capacityEpochId = DirectSettlement.capacityEpochId(epoch);
    }

    function _portfolio() internal pure returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](3);
        assets[0] = PortfolioBounds.AssetState(USDC, 600_000, 5_500, 10_000);
        assets[1] = PortfolioBounds.AssetState(WETH, 300_000, 0, 3_500);
        assets[2] = PortfolioBounds.AssetState(LINK, 100_000, 0, 1_500);
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
