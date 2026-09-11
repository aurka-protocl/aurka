// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DirectSettlement } from "./libraries/DirectSettlement.sol";
import { OptionSpaceFee } from "./libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "./libraries/PortfolioBounds.sol";
import { PriceProtection } from "./libraries/PriceProtection.sol";

/// @notice Externalized deterministic settlement math for the Sepolia router.
/// @dev The implementation is the same AURKA library used by the local router;
///      the separate call keeps the public router below EIP-170.
contract AurkaSepoliaTradeMath {
    error FeeAccountingMismatch();
    error ProposalMismatch();
    error InvalidCapacityEpoch();

    function maximumSafeFill(
        PortfolioBounds.AssetState[] calldata assets,
        address inputToken,
        address outputToken,
        uint256 requestedValue,
        uint256 maximumTransactionValue,
        uint256 capacityBaseline,
        uint256 consumedBefore,
        OptionSpaceFee.FeeConfig calldata fee,
        PriceProtection.SettlementInput calldata priceInput,
        DirectSettlement.CapacityEpoch calldata epoch,
        uint64 currentTimestamp
    ) external pure returns (DirectSettlement.FillResult memory) {
        return DirectSettlement.maximumSafeFill(
            assets,
            inputToken,
            outputToken,
            requestedValue,
            maximumTransactionValue,
            capacityBaseline,
            consumedBefore,
            fee,
            priceInput,
            epoch,
            currentTimestamp
        );
    }

    function normalizeValue(
        uint256 amount,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 valueDecimals
    ) external pure returns (uint256) {
        return PortfolioBounds.normalizeValue(
            amount, tokenDecimals, price, priceDecimals, valueDecimals
        );
    }

    function isWithinBounds(PortfolioBounds.AssetState[] calldata assets)
        external
        pure
        returns (bool)
    {
        return PortfolioBounds.isWithinBounds(assets);
    }

    function validateFill(
        uint256 traderInputValue,
        uint256 traderOutputValue,
        uint256 treasuryOutputValue,
        uint256 feeBpsScaled,
        uint256 baseFeeAmount,
        uint256 treasuryBaseFeeAmount,
        uint256 optionSpacePremiumAmount,
        uint256 totalFeeAmount,
        uint256 treasuryAmount,
        uint256 solverAmount,
        uint256 protocolAmount,
        uint256 utilizationBefore,
        uint256 utilizationAfter,
        uint8 bindingConstraint,
        address bindingAsset,
        uint256 consumedBefore,
        uint256 consumedAfter,
        DirectSettlement.FillResult calldata fill
    ) external pure {
        if (
            traderInputValue != fill.maximumSafeFill
                || traderOutputValue != fill.traderOutputValue
                || treasuryOutputValue != fill.treasuryOutputValue
                || feeBpsScaled != fill.fees.feeBpsScaled
                || baseFeeAmount != fill.fees.baseFeeAmount
                || treasuryBaseFeeAmount != fill.fees.treasuryBaseFeeAmount
                || optionSpacePremiumAmount != fill.fees.premiumAmount
                || totalFeeAmount != fill.fees.totalFeeAmount
                || treasuryAmount != fill.fees.treasuryAmount
                || solverAmount != fill.fees.solverAmount
                || protocolAmount != fill.fees.protocolAmount
                || utilizationBefore != fill.utilizationBefore
                || utilizationAfter != fill.utilizationAfter
                || bindingConstraint != uint8(fill.bindingConstraint)
                || bindingAsset != fill.bindingAsset
                || consumedAfter != consumedBefore + fill.maximumSafeFill
        ) revert ProposalMismatch();
    }

    function validateRawOutputAmounts(
        uint256 traderOutputAmount,
        uint256 solverFeeAmount,
        uint256 protocolFeeAmount,
        PriceProtection.SettlementInput calldata priceInput,
        DirectSettlement.FillResult calldata fill
    ) external pure {
        uint256 traderOutputValue = PortfolioBounds.normalizeValue(
            traderOutputAmount,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            priceInput.valueDecimals
        );
        uint256 solverValue = PortfolioBounds.normalizeValue(
            solverFeeAmount,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            priceInput.valueDecimals
        );
        uint256 protocolValue = PortfolioBounds.normalizeValue(
            protocolFeeAmount,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            priceInput.valueDecimals
        );
        if (
            traderOutputValue != fill.traderOutputValue
                || solverValue != fill.fees.solverAmount
                || protocolValue != fill.fees.protocolAmount
                || traderOutputValue + solverValue + protocolValue != fill.treasuryOutputValue
        ) revert FeeAccountingMismatch();
    }

    function validateEpoch(
        DirectSettlement.CapacityEpoch calldata epoch,
        bytes32 intentPositionIdHash,
        address intentInputToken,
        address intentOutputToken,
        bytes32 intentBalanceSnapshot,
        bytes32 intentPriceSnapshot,
        uint256 proposalPolicyNonce,
        bytes32 proposalRiskCertificateHash,
        bytes32 proposalAquaStrategyHash,
        bytes32 proposalCapacityEpochId,
        uint256 proposalCapacityBaseline,
        uint256 proposalConsumedBefore
    ) external view {
        if (
            epoch.positionIdHash != intentPositionIdHash
                || epoch.traderInputTokenId != _tokenId(intentInputToken)
                || epoch.traderOutputTokenId != _tokenId(intentOutputToken)
                || epoch.balanceSnapshot != intentBalanceSnapshot
                || epoch.priceSnapshot != intentPriceSnapshot
                || epoch.portfolioPriceSnapshot == bytes32(0)
                || epoch.policyNonce != proposalPolicyNonce
                || epoch.riskCertificateHash != proposalRiskCertificateHash
                || epoch.aquaStrategyHash != proposalAquaStrategyHash
                || epoch.chainId != block.chainid
                || epoch.capacityEpochId != _capacityEpochId(epoch)
                || proposalCapacityEpochId != epoch.capacityEpochId
                || proposalCapacityBaseline != epoch.capacityBaseline
                || proposalConsumedBefore != epoch.consumedBefore
        ) revert InvalidCapacityEpoch();
    }

    function authorityHash(bytes32 policyId, DirectSettlement.CapacityEpoch calldata epoch)
        external
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                policyId,
                epoch.positionIdHash,
                epoch.traderInputTokenId,
                epoch.traderOutputTokenId,
                epoch.balanceSnapshot,
                epoch.priceSnapshot,
                epoch.portfolioPriceSnapshot,
                epoch.policyNonce,
                epoch.riskCertificateHash,
                epoch.aquaStrategyHash
            )
        );
    }

    function _capacityEpochId(DirectSettlement.CapacityEpoch calldata epoch)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                epoch.positionIdHash,
                epoch.traderInputTokenId,
                epoch.traderOutputTokenId,
                epoch.balanceSnapshot,
                epoch.priceSnapshot,
                epoch.portfolioPriceSnapshot,
                epoch.policyNonce,
                epoch.riskCertificateHash,
                epoch.aquaStrategyHash,
                epoch.capacityBaseline,
                epoch.chainId,
                epoch.verifyingContract
            )
        );
    }

    function _tokenId(address token) private pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }
}
