// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title OptionSpace Fee
/// @notice Bounded, interval-average directional-capacity fee calculation.
library OptionSpaceFee {
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant MAXIMUM_TOTAL_FEE_BPS = 100;
    uint256 internal constant FIXED_POINT_SCALE = 1e18;
    uint256 internal constant FEE_DENOMINATOR = BASIS_POINTS * FIXED_POINT_SCALE;

    struct FeeConfig {
        uint16 baseFeeBps;
        uint16 slopeBps;
        uint16 maximumFeeBps;
        uint16 treasuryBaseFeeBps;
        uint16 solverFeeBps;
        uint16 protocolFeeBps;
    }

    struct FeeResult {
        uint256 feeBpsScaled;
        uint256 premiumBpsScaled;
        uint256 baseFeeAmount;
        uint256 treasuryBaseFeeAmount;
        uint256 premiumAmount;
        uint256 totalFeeAmount;
        uint256 treasuryAmount;
        uint256 solverAmount;
        uint256 protocolAmount;
    }

    error FeeAboveCap(uint256 feeBpsScaled, uint256 capBpsScaled);
    error InvalidFeeConfiguration();
    error InvalidUtilization(uint256 utilizationBefore, uint256 utilizationAfter);

    function calculateFeeBps(
        uint16 baseFeeBps,
        uint16 slopeBps,
        uint16 maximumFeeBps,
        uint256 utilizationBefore,
        uint256 utilizationAfter
    ) internal pure returns (uint256 feeBpsScaled, uint256 premiumBpsScaled) {
        if (
            baseFeeBps > maximumFeeBps || uint256(baseFeeBps) + slopeBps > maximumFeeBps
                || maximumFeeBps > MAXIMUM_TOTAL_FEE_BPS || utilizationBefore > FIXED_POINT_SCALE
                || utilizationAfter > FIXED_POINT_SCALE || utilizationAfter < utilizationBefore
        ) {
            if (
                baseFeeBps > maximumFeeBps || uint256(baseFeeBps) + slopeBps > maximumFeeBps
                    || maximumFeeBps > MAXIMUM_TOTAL_FEE_BPS
            ) {
                revert InvalidFeeConfiguration();
            }
            revert InvalidUtilization(utilizationBefore, utilizationAfter);
        }
        // The instantaneous premium is slopeBps * u^2. Its average over the
        // interval [u0, u1] is slopeBps * (u0^2 + u0*u1 + u1^2) / 3.
        uint256 quadraticSum = utilizationAfter * utilizationAfter
            + utilizationBefore * utilizationAfter + utilizationBefore * utilizationBefore;
        premiumBpsScaled = _ceilDiv(uint256(slopeBps) * quadraticSum, 3 * FIXED_POINT_SCALE);
        feeBpsScaled = uint256(baseFeeBps) * FIXED_POINT_SCALE + premiumBpsScaled;
        uint256 cap = uint256(maximumFeeBps) * FIXED_POINT_SCALE;
        if (feeBpsScaled > cap) revert FeeAboveCap(feeBpsScaled, cap);
    }

    function distribute(
        uint256 tradeValue,
        FeeConfig memory config,
        uint256 utilizationBefore,
        uint256 utilizationAfter
    ) internal pure returns (FeeResult memory result) {
        if (
            uint256(config.treasuryBaseFeeBps) + config.solverFeeBps + config.protocolFeeBps
                != config.baseFeeBps
        ) revert InvalidFeeConfiguration();
        (result.feeBpsScaled, result.premiumBpsScaled) = calculateFeeBps(
            config.baseFeeBps,
            config.slopeBps,
            config.maximumFeeBps,
            utilizationBefore,
            utilizationAfter
        );
        result.baseFeeAmount =
            _mulDivUpBounded(tradeValue, uint256(config.baseFeeBps) * FIXED_POINT_SCALE);
        // Round the complete fee once. Rounding the components independently
        // can make a one-unit trade pay more than its bounded fee.
        result.totalFeeAmount = _mulDivUpBounded(tradeValue, result.feeBpsScaled);
        result.premiumAmount = result.totalFeeAmount - result.baseFeeAmount;

        if (config.baseFeeBps != 0) {
            result.solverAmount =
                _mulDivDownSmall(result.baseFeeAmount, config.solverFeeBps, config.baseFeeBps);
            result.protocolAmount =
                _mulDivDownSmall(result.baseFeeAmount, config.protocolFeeBps, config.baseFeeBps);
        }
        // Premiums and every integer remainder accrue to the treasury.
        result.treasuryBaseFeeAmount =
            result.baseFeeAmount - result.solverAmount - result.protocolAmount;
        result.treasuryAmount = result.totalFeeAmount - result.solverAmount - result.protocolAmount;
    }

    /// @dev feeBpsScaled <= FEE_DENOMINATOR, so this decomposition cannot overflow.
    function _mulDivUpBounded(uint256 value, uint256 feeBpsScaled) private pure returns (uint256) {
        uint256 quotient = (value / FEE_DENOMINATOR) * feeBpsScaled;
        uint256 remainder = (value % FEE_DENOMINATOR) * feeBpsScaled;
        return quotient + _ceilDiv(remainder, FEE_DENOMINATOR);
    }

    function _mulDivDownSmall(uint256 value, uint256 multiplier, uint256 denominator)
        private
        pure
        returns (uint256)
    {
        return
            (value / denominator) * multiplier + ((value % denominator) * multiplier) / denominator;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }
}
