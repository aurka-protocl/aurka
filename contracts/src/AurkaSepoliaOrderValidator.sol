// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Validates the fixed, reviewed AURKA upstream order template.
/// @dev Kept outside the Sepolia settlement router so the router remains below
///      EIP-170 without weakening the order, token, guard, or deadline checks.
contract AurkaSepoliaOrderValidator {
    error InvalidOrderTemplate();

    function expectedAmountOut(
        uint256 traderInputValue,
        uint8 traderOutputDecimals,
        uint256 traderOutputPrice,
        uint8 traderOutputPriceDecimals
    ) external pure returns (uint256) {
        uint256 numerator = traderInputValue
            * 10 ** uint256(traderOutputDecimals)
            * 10 ** uint256(traderOutputPriceDecimals);
        return numerator == 0 ? 0 : (numerator - 1) / traderOutputPrice + 1;
    }

    function validate(
        address traderInputToken,
        address traderOutputToken,
        address swapVMGuard,
        uint256 makerTraits,
        bytes calldata orderData,
        bytes calldata takerTraitsAndData,
        uint256 expectedAmountOut_,
        uint256 deadline
    ) external pure {
        if (orderData.length != 129 || takerTraitsAndData.length != 59) {
            revert InvalidOrderTemplate();
        }
        address tokenA = _addressAt(orderData, 0);
        address tokenB = _addressAt(orderData, 20);
        if (
            tokenA >= tokenB
                || !(
                    (tokenA == traderInputToken && tokenB == traderOutputToken)
                        || (tokenA == traderOutputToken && tokenB == traderInputToken)
                ) || _addressAt(orderData, 40) != swapVMGuard
        ) revert InvalidOrderTemplate();

        uint256 expectedTraits = (1 << 254) | (1 << 250) | (1 << 246) | (uint256(60) << 208)
            | (uint256(60) << 192) | (uint256(40) << 176) | (uint256(40) << 160);
        if (makerTraits != expectedTraits) revert InvalidOrderTemplate();
        if (
            _byteAt(orderData, 60) != 0x90 || _byteAt(orderData, 61) != 0x40
                || _byteAt(orderData, 126) != 0x53 || _byteAt(orderData, 127) != 0x01
                || _byteAt(orderData, 128) != (traderInputToken == tokenA ? 0x80 : 0x00)
        ) revert InvalidOrderTemplate();

        uint16 flags = _uint16At(takerTraitsAndData, 20);
        uint16 expectedFlags =
            0x0051 | (traderInputToken == tokenA ? uint16(0x0080) : uint16(0));
        if (flags != expectedFlags) revert InvalidOrderTemplate();
        for (uint256 i; i < 8; ++i) {
            if (_uint16At(takerTraitsAndData, i * 2) != 37) revert InvalidOrderTemplate();
        }
        if (
            _uint16At(takerTraitsAndData, 16) != 32
                || _uint16At(takerTraitsAndData, 18) != 32
                || _uint256At(takerTraitsAndData, 22) != expectedAmountOut_
                || uint256(_uint40At(takerTraitsAndData, 54)) != deadline
        ) revert InvalidOrderTemplate();
    }

    function _addressAt(bytes calldata data, uint256 offset) private pure returns (address value) {
        assembly ("memory-safe") {
            value := shr(96, calldataload(add(data.offset, offset)))
        }
    }

    function _byteAt(bytes calldata data, uint256 offset) private pure returns (uint8 value) {
        assembly ("memory-safe") {
            value := byte(0, calldataload(add(data.offset, offset)))
        }
    }

    function _uint16At(bytes calldata data, uint256 offset) private pure returns (uint16 value) {
        assembly ("memory-safe") {
            value := shr(240, calldataload(add(data.offset, offset)))
        }
    }

    function _uint40At(bytes calldata data, uint256 offset) private pure returns (uint40 value) {
        assembly ("memory-safe") {
            value := shr(216, calldataload(add(data.offset, offset)))
        }
    }

    function _uint256At(bytes calldata data, uint256 offset) private pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := calldataload(add(data.offset, offset))
        }
    }
}
