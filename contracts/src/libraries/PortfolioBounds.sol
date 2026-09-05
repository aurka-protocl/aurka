// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Portfolio Bounds
/// @notice Deterministic portfolio valuation, conservative bounds, and maximum safe fills.
library PortfolioBounds {
    uint256 internal constant BASIS_POINTS = 10_000;
    uint8 internal constant MAX_DECIMALS = 36;

    enum Constraint {
        NONE,
        TRANSACTION_CAP,
        AVAILABLE_BALANCE,
        CAPACITY_EXHAUSTED,
        MINIMUM_WEIGHT,
        MAXIMUM_WEIGHT
    }

    struct AssetState {
        address token;
        uint256 value;
        uint16 minimumWeightBps;
        uint16 maximumWeightBps;
    }

    struct FillResult {
        uint256 maximumSafeFill;
        Constraint bindingConstraint;
        address bindingAsset;
    }

    error AssetNotFound(address token);
    error DecimalScaleTooLarge(uint8 decimals);
    error DuplicateAsset(address token);
    error EmptyPortfolio();
    error InitialPortfolioUnsafe();
    error InvalidAsset(address token);
    error InvalidPortfolioBounds();
    error NavIsZero();
    error PriceIsZero();
    error SameAssetTrade();

    /// @dev Values round upward so dust exposure cannot be hidden.
    function normalizeValue(
        uint256 balance,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 valueDecimals
    ) internal pure returns (uint256) {
        if (
            tokenDecimals > MAX_DECIMALS || priceDecimals > MAX_DECIMALS
                || valueDecimals > MAX_DECIMALS
        ) revert DecimalScaleTooLarge(MAX_DECIMALS);
        if (price == 0) revert PriceIsZero();
        uint256 numerator = balance * price * _pow10(valueDecimals);
        uint256 denominator = _pow10(tokenDecimals) * _pow10(priceDecimals);
        return _ceilDiv(numerator, denominator);
    }

    /// @dev Values received by the treasury are floored so input is never overstated.
    function normalizeValueDown(
        uint256 balance,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 valueDecimals
    ) internal pure returns (uint256) {
        if (
            tokenDecimals > MAX_DECIMALS || priceDecimals > MAX_DECIMALS
                || valueDecimals > MAX_DECIMALS
        ) revert DecimalScaleTooLarge(MAX_DECIMALS);
        if (price == 0) revert PriceIsZero();
        uint256 numerator = balance * price * _pow10(valueDecimals);
        uint256 denominator = _pow10(tokenDecimals) * _pow10(priceDecimals);
        return numerator / denominator;
    }

    function nav(AssetState[] memory assets) internal pure returns (uint256 total) {
        if (assets.length == 0) revert EmptyPortfolio();
        for (uint256 i; i < assets.length; ++i) {
            total += assets[i].value;
        }
        if (total == 0) revert NavIsZero();
    }

    /// @notice Exposure rounded down. Use for minimum-bound reporting.
    function weightBpsDown(uint256 value, uint256 total) internal pure returns (uint256) {
        if (total == 0) revert NavIsZero();
        if (value > total) revert InvalidPortfolioBounds();
        return _ratioBps(value, total, false);
    }

    /// @notice Exposure rounded up. Use for maximum-bound reporting.
    function weightBpsUp(uint256 value, uint256 total) internal pure returns (uint256) {
        if (total == 0) revert NavIsZero();
        if (value > total) revert InvalidPortfolioBounds();
        return _ratioBps(value, total, true);
    }

    function validateConfiguration(AssetState[] memory assets) internal pure {
        if (assets.length == 0) revert EmptyPortfolio();
        uint256 minimumTotal;
        uint256 maximumTotal;
        for (uint256 i; i < assets.length; ++i) {
            AssetState memory asset = assets[i];
            if (
                asset.token == address(0) || asset.minimumWeightBps > asset.maximumWeightBps
                    || asset.maximumWeightBps > BASIS_POINTS
            ) revert InvalidAsset(asset.token);
            minimumTotal += asset.minimumWeightBps;
            maximumTotal += asset.maximumWeightBps;
            for (uint256 j; j < i; ++j) {
                if (assets[j].token == asset.token) revert DuplicateAsset(asset.token);
            }
        }
        if (minimumTotal > BASIS_POINTS || maximumTotal < BASIS_POINTS) {
            revert InvalidPortfolioBounds();
        }
    }

    function isWithinBounds(AssetState[] memory assets) internal pure returns (bool) {
        validateConfiguration(assets);
        uint256 total = nav(assets);
        for (uint256 i; i < assets.length; ++i) {
            AssetState memory asset = assets[i];
            uint256 minimumValue = _bpsOfUp(total, asset.minimumWeightBps);
            uint256 maximumValue = _bpsOfDown(total, asset.maximumWeightBps);
            if (asset.value < minimumValue || asset.value > maximumValue) return false;
        }
        return true;
    }

    function previewTrade(
        AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 fillValue
    ) internal pure returns (AssetState[] memory result) {
        if (traderInputToken == traderOutputToken) revert SameAssetTrade();
        uint256 traderInputIndex = _assetIndex(assets, traderInputToken);
        uint256 traderOutputIndex = _assetIndex(assets, traderOutputToken);
        result = _copy(assets);
        result[traderInputIndex].value += fillValue;
        result[traderOutputIndex].value -= fillValue;
    }

    function maximumSafeFill(
        AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 requestedValue,
        uint256 maximumTransactionValue
    ) internal pure returns (FillResult memory result) {
        validateConfiguration(assets);
        if (!isWithinBounds(assets)) revert InitialPortfolioUnsafe();
        if (traderInputToken == traderOutputToken) revert SameAssetTrade();
        _assetIndex(assets, traderInputToken);
        uint256 outputIndex = _assetIndex(assets, traderOutputToken);

        uint256 high = requestedValue;
        if (high > maximumTransactionValue) high = maximumTransactionValue;
        if (high > assets[outputIndex].value) high = assets[outputIndex].value;
        uint256 low;
        while (low < high) {
            uint256 mid = low + (high - low + 1) / 2;
            if (_isTradeSafe(assets, traderInputToken, traderOutputToken, mid)) low = mid;
            else high = mid - 1;
        }
        result.maximumSafeFill = low;
        if (low == requestedValue) return result;

        uint256 probe = low + 1;
        if (probe > maximumTransactionValue) {
            result.bindingConstraint = Constraint.TRANSACTION_CAP;
            return result;
        }
        if (probe > assets[outputIndex].value) {
            result.bindingConstraint = Constraint.AVAILABLE_BALANCE;
            result.bindingAsset = traderOutputToken;
            return result;
        }
        (result.bindingConstraint, result.bindingAsset) =
            _firstTradeViolation(assets, traderInputToken, traderOutputToken, probe);
    }

    function _isTradeSafe(
        AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 fillValue
    ) private pure returns (bool) {
        AssetState[] memory postTrade =
            previewTrade(assets, traderInputToken, traderOutputToken, fillValue);
        return isWithinBounds(postTrade);
    }

    function _firstTradeViolation(
        AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 fillValue
    ) private pure returns (Constraint constraint, address token) {
        AssetState[] memory postTrade =
            previewTrade(assets, traderInputToken, traderOutputToken, fillValue);
        uint256 total = nav(postTrade);
        for (uint256 i; i < postTrade.length; ++i) {
            AssetState memory asset = postTrade[i];
            if (asset.value < _bpsOfUp(total, asset.minimumWeightBps)) {
                return (Constraint.MINIMUM_WEIGHT, asset.token);
            }
            if (asset.value > _bpsOfDown(total, asset.maximumWeightBps)) {
                return (Constraint.MAXIMUM_WEIGHT, asset.token);
            }
        }
        return (Constraint.NONE, address(0));
    }

    function _assetIndex(AssetState[] memory assets, address token)
        private
        pure
        returns (uint256)
    {
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i].token == token) return i;
        }
        revert AssetNotFound(token);
    }

    function _copy(AssetState[] memory assets) private pure returns (AssetState[] memory result) {
        result = new AssetState[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            // Explicit fields avoid Solidity memory-to-memory struct aliasing.
            result[i] = AssetState({
                token: assets[i].token,
                value: assets[i].value,
                minimumWeightBps: assets[i].minimumWeightBps,
                maximumWeightBps: assets[i].maximumWeightBps
            });
        }
    }

    /// @dev Computes floor(total * bps / 10_000) without overflowing total * bps.
    function _bpsOfDown(uint256 total, uint256 bps) private pure returns (uint256) {
        return (total / BASIS_POINTS) * bps + ((total % BASIS_POINTS) * bps) / BASIS_POINTS;
    }

    function _bpsOfUp(uint256 total, uint256 bps) private pure returns (uint256) {
        uint256 quotient = (total / BASIS_POINTS) * bps;
        uint256 remainder = (total % BASIS_POINTS) * bps;
        return quotient + _ceilDiv(remainder, BASIS_POINTS);
    }

    /// @dev Binary search keeps multiplication out of uint256-sensitive ratio calculation.
    function _ratioBps(uint256 value, uint256 total, bool roundUp) private pure returns (uint256) {
        uint256 low;
        uint256 high = BASIS_POINTS;
        if (roundUp) {
            while (low < high) {
                uint256 mid = low + (high - low) / 2;
                if (_bpsOfDown(total, mid) >= value) high = mid;
                else low = mid + 1;
            }
            return low;
        }
        while (low < high) {
            uint256 mid = low + (high - low + 1) / 2;
            if (_bpsOfUp(total, mid) <= value) low = mid;
            else high = mid - 1;
        }
        return low;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }

    function _pow10(uint8 decimals) private pure returns (uint256) {
        return 10 ** uint256(decimals);
    }
}
