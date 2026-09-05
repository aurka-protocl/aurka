// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { OptionSpaceFee } from "./OptionSpaceFee.sol";
import { PortfolioBounds } from "./PortfolioBounds.sol";
import { PriceProtection } from "./PriceProtection.sol";

/// @title Direct pairwise settlement math
/// @notice Fee-inclusive direct-settlement math; the AURKA-005 router owns custody.
library DirectSettlement {
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    struct CapacityEpoch {
        bytes32 positionIdHash;
        bytes32 traderInputTokenId;
        bytes32 traderOutputTokenId;
        bytes32 balanceSnapshot;
        bytes32 priceSnapshot;
        bytes32 portfolioPriceSnapshot;
        uint256 policyNonce;
        bytes32 riskCertificateHash;
        bytes32 aquaStrategyHash;
        uint256 capacityBaseline;
        uint256 consumedBefore;
        uint256 chainId;
        address verifyingContract;
        bytes32 capacityEpochId;
    }

    struct FillResult {
        uint256 maximumSafeFill;
        uint256 utilizationBefore;
        uint256 utilizationAfter;
        OptionSpaceFee.FeeResult fees;
        uint256 traderOutputValue;
        uint256 treasuryOutputValue;
        PortfolioBounds.Constraint bindingConstraint;
        address bindingAsset;
        PortfolioBounds.AssetState[] postTrade;
    }

    struct SearchParams {
        PortfolioBounds.AssetState[] assets;
        address traderInputToken;
        address traderOutputToken;
        uint256 consumedBefore;
        uint256 capacityBaseline;
        OptionSpaceFee.FeeConfig feeConfig;
    }

    error FeeExceedsTradeValue(uint256 feeAmount, uint256 tradeValue);
    error ConsumedExceedsBaseline(uint256 consumed, uint256 baseline);
    error CapacityEpochMismatch(bytes32 expected, bytes32 actual);
    error CapacityEpochStateMismatch();
    error PriceProtectionTokenMismatch();

    function previewFeeInclusiveTrade(
        PortfolioBounds.AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 tradeValue,
        OptionSpaceFee.FeeResult memory fees
    ) internal pure returns (PortfolioBounds.AssetState[] memory result) {
        if (fees.totalFeeAmount > tradeValue) {
            revert FeeExceedsTradeValue(fees.totalFeeAmount, tradeValue);
        }
        result =
            PortfolioBounds.previewTrade(assets, traderInputToken, traderOutputToken, tradeValue);
        // The fair-value preview removes gross output. Treasury fee revenue is
        // retained in that output token, so it is added back; solver and
        // protocol shares remain outside the treasury.
        result[_assetIndex(result, traderOutputToken)].value += fees.treasuryAmount;
    }

    function maximumSafeFill(
        PortfolioBounds.AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 requestedValue,
        uint256 maximumTransactionValue,
        uint256 capacityBaseline,
        uint256 consumedBefore,
        OptionSpaceFee.FeeConfig memory feeConfig,
        PriceProtection.SettlementInput memory priceInput,
        CapacityEpoch memory epoch,
        uint64 settlementTime
    ) internal pure returns (FillResult memory result) {
        SearchParams memory search = SearchParams({
            assets: assets,
            traderInputToken: traderInputToken,
            traderOutputToken: traderOutputToken,
            consumedBefore: consumedBefore,
            capacityBaseline: capacityBaseline,
            feeConfig: feeConfig
        });
        _assertCommitments(
            search, capacityBaseline, consumedBefore, priceInput, epoch, settlementTime
        );
        return _solve(search, requestedValue, maximumTransactionValue);
    }

    function _assertCommitments(
        SearchParams memory search,
        uint256 capacityBaseline,
        uint256 consumedBefore,
        PriceProtection.SettlementInput memory priceInput,
        CapacityEpoch memory epoch,
        uint64 settlementTime
    ) private pure {
        PortfolioBounds.validateConfiguration(search.assets);
        if (!PortfolioBounds.isWithinBounds(search.assets)) {
            revert PortfolioBounds.InitialPortfolioUnsafe();
        }
        if (consumedBefore > capacityBaseline) {
            revert ConsumedExceedsBaseline(consumedBefore, capacityBaseline);
        }
        if (epoch.capacityBaseline != capacityBaseline || epoch.consumedBefore != consumedBefore) {
            revert CapacityEpochStateMismatch();
        }
        bytes32 actualEpochId = capacityEpochId(epoch);
        if (epoch.capacityEpochId != actualEpochId) {
            revert CapacityEpochMismatch(epoch.capacityEpochId, actualEpochId);
        }
        if (
            priceInput.traderInputToken != search.traderInputToken
                || priceInput.traderOutputToken != search.traderOutputToken
        ) revert PriceProtectionTokenMismatch();
        PriceProtection.assertSettlementPricesAt(priceInput, settlementTime);
    }

    function _solve(
        SearchParams memory search,
        uint256 requestedValue,
        uint256 maximumTransactionValue
    ) private pure returns (FillResult memory result) {
        uint256 high = requestedValue;
        if (high > maximumTransactionValue) high = maximumTransactionValue;
        uint256 remaining = search.capacityBaseline - search.consumedBefore;
        if (high > remaining) high = remaining;
        uint256 outputIndex = _assetIndex(search.assets, search.traderOutputToken);
        if (high > search.assets[outputIndex].value) high = search.assets[outputIndex].value;
        uint256 low;
        while (low < high) {
            uint256 mid = low + (high - low + 1) / 2;
            if (_isSafe(search, mid)) low = mid;
            else high = mid - 1;
        }
        result.maximumSafeFill = low;
        result.utilizationBefore = _utilization(search.consumedBefore, search.capacityBaseline);
        result.utilizationAfter = _utilization(search.consumedBefore + low, search.capacityBaseline);
        result.fees = OptionSpaceFee.distribute(
            low, search.feeConfig, result.utilizationBefore, result.utilizationAfter
        );
        result.traderOutputValue = low - result.fees.totalFeeAmount;
        result.treasuryOutputValue = low - result.fees.treasuryAmount;
        if (low < requestedValue) {
            if (low == maximumTransactionValue && requestedValue > maximumTransactionValue) {
                result.bindingConstraint = PortfolioBounds.Constraint.TRANSACTION_CAP;
            } else if (
                low == search.capacityBaseline - search.consumedBefore
                    && requestedValue > search.capacityBaseline - search.consumedBefore
            ) {
                result.bindingConstraint = PortfolioBounds.Constraint.CAPACITY_EXHAUSTED;
            } else {
                result.bindingConstraint = PortfolioBounds.Constraint.NONE;
            }
        }
        result.postTrade = previewFeeInclusiveTrade(
            search.assets, search.traderInputToken, search.traderOutputToken, low, result.fees
        );
    }

    function capacityEpochId(CapacityEpoch memory epoch) internal pure returns (bytes32) {
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

    function _isSafe(SearchParams memory search, uint256 fillValue) private pure returns (bool) {
        uint256 beforeUtilization = _utilization(search.consumedBefore, search.capacityBaseline);
        uint256 afterUtilization =
            _utilization(search.consumedBefore + fillValue, search.capacityBaseline);
        OptionSpaceFee.FeeResult memory fees = OptionSpaceFee.distribute(
            fillValue, search.feeConfig, beforeUtilization, afterUtilization
        );
        if (fees.totalFeeAmount > fillValue) return false;
        PortfolioBounds.AssetState[] memory postTrade = previewFeeInclusiveTrade(
            search.assets, search.traderInputToken, search.traderOutputToken, fillValue, fees
        );
        return PortfolioBounds.isWithinBounds(postTrade);
    }

    function _utilization(uint256 consumed, uint256 capacity) private pure returns (uint256) {
        if (capacity == 0) return consumed == 0 ? 0 : FIXED_POINT_SCALE;
        return (consumed / capacity) * FIXED_POINT_SCALE
            + ((consumed % capacity) * FIXED_POINT_SCALE) / capacity;
    }

    function _assetIndex(PortfolioBounds.AssetState[] memory assets, address token)
        private
        pure
        returns (uint256)
    {
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i].token == token) return i;
        }
        revert PortfolioBounds.AssetNotFound(token);
    }
}
