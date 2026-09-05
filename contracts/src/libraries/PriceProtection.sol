// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PortfolioBounds } from "./PortfolioBounds.sol";

/// @title Deterministic price protection
/// @notice Validates caller-supplied snapshots; it does not read a live oracle.
library PriceProtection {
    uint256 internal constant BASIS_POINTS = 10_000;
    uint8 internal constant MAX_DECIMALS = 36;

    error PriceIsStale(uint64 observedAt, uint64 currentTime, uint64 maxAge);
    error PriceFromFuture(uint64 observedAt, uint64 currentTime);
    error PriceIsZero();
    error PriceTokenMismatch(address expectedToken, address actualToken);
    error PriceSnapshotNotApproved(bytes32 approvedSnapshotId, bytes32 actualSnapshotId);
    error PriceDeviationTooHigh(uint256 referencePrice, uint256 actualPrice);
    error InvalidDeviation(uint256 maximumDeviationBps);
    error InvalidMaxAge();
    error TreasuryExchangeValueTooLow(uint256 inputValue, uint256 minimumInputValue);
    error DecimalScaleTooLarge(uint8 maximumDecimals);
    error InvalidSettlementAmount();

    struct Snapshot {
        address token;
        bytes32 snapshotId;
        uint256 price;
        uint8 priceDecimals;
        uint64 observedAt;
    }

    struct SettlementInput {
        address traderInputToken;
        address traderOutputToken;
        Snapshot traderInputReferencePrice;
        Snapshot traderInputExecutionPrice;
        Snapshot traderOutputReferencePrice;
        Snapshot traderOutputExecutionPrice;
        bytes32 approvedTraderInputSnapshotId;
        bytes32 approvedTraderOutputSnapshotId;
        uint256 traderInputAmount;
        uint256 traderOutputAmount;
        uint8 traderInputDecimals;
        uint8 traderOutputDecimals;
        uint8 valueDecimals;
        uint64 currentTime;
        uint64 maximumPriceAgeSeconds;
        uint256 maximumPriceDeviationBps;
    }

    function assertFresh(uint64 observedAt, uint64 currentTime, uint64 maxAge) internal pure {
        if (maxAge == 0) revert InvalidMaxAge();
        if (observedAt > currentTime) revert PriceFromFuture(observedAt, currentTime);
        if (currentTime - observedAt > maxAge) {
            revert PriceIsStale(observedAt, currentTime, maxAge);
        }
    }

    /// @notice Bind a supplied price to the token and snapshot selected by the quote.
    function assertApprovedSnapshot(
        address expectedToken,
        bytes32 approvedSnapshotId,
        address actualToken,
        bytes32 actualSnapshotId
    ) internal pure {
        if (expectedToken != actualToken) revert PriceTokenMismatch(expectedToken, actualToken);
        if (approvedSnapshotId != actualSnapshotId) {
            revert PriceSnapshotNotApproved(approvedSnapshotId, actualSnapshotId);
        }
    }

    function assertWithinDeviation(
        address referenceToken,
        uint256 referencePrice,
        uint8 referenceDecimals,
        address actualToken,
        uint256 actualPrice,
        uint8 actualDecimals,
        uint256 maximumDeviationBps
    ) internal pure {
        if (referenceToken != actualToken) revert PriceTokenMismatch(referenceToken, actualToken);
        if (referencePrice == 0 || actualPrice == 0) revert PriceIsZero();
        if (maximumDeviationBps > BASIS_POINTS) revert InvalidDeviation(maximumDeviationBps);
        if (referenceDecimals > MAX_DECIMALS || actualDecimals > MAX_DECIMALS) {
            revert DecimalScaleTooLarge(MAX_DECIMALS);
        }
        uint256 referenceNormalized = referencePrice * _pow10(actualDecimals);
        uint256 actualNormalized = actualPrice * _pow10(referenceDecimals);
        uint256 difference = actualNormalized >= referenceNormalized
            ? actualNormalized - referenceNormalized
            : referenceNormalized - actualNormalized;
        if (difference * BASIS_POINTS > referenceNormalized * maximumDeviationBps) {
            revert PriceDeviationTooHigh(referencePrice, actualPrice);
        }
    }

    /// @notice Required treasury input value for an output value and tolerance.
    function minimumTreasuryInputValue(uint256 treasuryOutputValue, uint256 maximumDeviationBps)
        internal
        pure
        returns (uint256)
    {
        if (maximumDeviationBps > BASIS_POINTS) revert InvalidDeviation(maximumDeviationBps);
        return (treasuryOutputValue / BASIS_POINTS) * (BASIS_POINTS - maximumDeviationBps)
            + _ceilDiv(
                (treasuryOutputValue % BASIS_POINTS) * (BASIS_POINTS - maximumDeviationBps),
                BASIS_POINTS
            );
    }

    function assertMinimumTreasuryExchangeValue(
        uint256 treasuryInputValue,
        uint256 treasuryOutputValue,
        uint256 maximumDeviationBps
    ) internal pure {
        uint256 minimumInput = minimumTreasuryInputValue(treasuryOutputValue, maximumDeviationBps);
        if (treasuryInputValue < minimumInput) {
            revert TreasuryExchangeValueTooLow(treasuryInputValue, minimumInput);
        }
    }

    /// @notice Validate all price commitments using the caller-provided clock.
    /// @dev Kept for pure library consumers. Routers must use `assertSettlementPricesAt`
    ///      with the block timestamp instead of trusting `input.currentTime`.
    function assertSettlementPrices(SettlementInput memory input)
        internal
        pure
        returns (uint256 treasuryInputValue, uint256 treasuryOutputValue)
    {
        return _assertSettlementPrices(input, input.currentTime);
    }

    /// @notice Validate prices against an authoritative settlement clock.
    function assertSettlementPricesAt(SettlementInput memory input, uint64 settlementTime)
        internal
        pure
        returns (uint256 treasuryInputValue, uint256 treasuryOutputValue)
    {
        return _assertSettlementPrices(input, settlementTime);
    }

    function _assertSettlementPrices(SettlementInput memory input, uint64 settlementTime)
        private
        pure
        returns (uint256 treasuryInputValue, uint256 treasuryOutputValue)
    {
        if (input.traderInputAmount == 0 || input.traderOutputAmount == 0) {
            revert InvalidSettlementAmount();
        }
        assertFresh(
            input.traderInputReferencePrice.observedAt, settlementTime, input.maximumPriceAgeSeconds
        );
        assertFresh(
            input.traderInputExecutionPrice.observedAt, settlementTime, input.maximumPriceAgeSeconds
        );
        assertFresh(
            input.traderOutputReferencePrice.observedAt,
            settlementTime,
            input.maximumPriceAgeSeconds
        );
        assertFresh(
            input.traderOutputExecutionPrice.observedAt,
            settlementTime,
            input.maximumPriceAgeSeconds
        );
        assertApprovedSnapshot(
            input.traderInputToken,
            input.approvedTraderInputSnapshotId,
            input.traderInputExecutionPrice.token,
            input.traderInputExecutionPrice.snapshotId
        );
        assertApprovedSnapshot(
            input.traderOutputToken,
            input.approvedTraderOutputSnapshotId,
            input.traderOutputExecutionPrice.token,
            input.traderOutputExecutionPrice.snapshotId
        );
        assertWithinDeviation(
            input.traderInputReferencePrice.token,
            input.traderInputReferencePrice.price,
            input.traderInputReferencePrice.priceDecimals,
            input.traderInputExecutionPrice.token,
            input.traderInputExecutionPrice.price,
            input.traderInputExecutionPrice.priceDecimals,
            input.maximumPriceDeviationBps
        );
        assertWithinDeviation(
            input.traderOutputReferencePrice.token,
            input.traderOutputReferencePrice.price,
            input.traderOutputReferencePrice.priceDecimals,
            input.traderOutputExecutionPrice.token,
            input.traderOutputExecutionPrice.price,
            input.traderOutputExecutionPrice.priceDecimals,
            input.maximumPriceDeviationBps
        );
        treasuryInputValue = PortfolioBounds.normalizeValueDown(
            input.traderInputAmount,
            input.traderInputDecimals,
            input.traderInputExecutionPrice.price,
            input.traderInputExecutionPrice.priceDecimals,
            input.valueDecimals
        );
        treasuryOutputValue = PortfolioBounds.normalizeValue(
            input.traderOutputAmount,
            input.traderOutputDecimals,
            input.traderOutputExecutionPrice.price,
            input.traderOutputExecutionPrice.priceDecimals,
            input.valueDecimals
        );
        assertMinimumTreasuryExchangeValue(
            treasuryInputValue, treasuryOutputValue, input.maximumPriceDeviationBps
        );
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }

    function _pow10(uint8 decimals) private pure returns (uint256) {
        return 10 ** uint256(decimals);
    }
}
