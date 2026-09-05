// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ISwapVM } from "./interfaces/ISwapVM.sol";

/// @title AURKA direct SwapVM adapter
/// @notice Executes the reviewed ISwapVM order boundary for the one direct
///         pair program. Aqua custody remains in AurkaSwapVMRouter so the
///         router can enforce all five accounting legs atomically.
contract AurkaDirectSwapVM is ISwapVM {
    bytes32 public constant DIRECT_PROGRAM_ID = keccak256("AURKA_DIRECT_PAIR_V1");

    error DirectProgramMismatch();
    error InputAmountMismatch();

    function hash(Order calldata order) public pure returns (bytes32) {
        return keccak256(abi.encode(order.maker, order.traits, order.data));
    }

    function quote(Order calldata order, uint256 amount, bytes calldata)
        external
        pure
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        return _quote(order, amount);
    }

    function swap(Order calldata order, uint256 amount, bytes calldata)
        external
        payable
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        return _quote(order, amount);
    }

    function _quote(Order calldata order, uint256 amount)
        private
        pure
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        if (order.data.length != 16 * 32) revert DirectProgramMismatch();
        (
            bytes32 programId,
            bytes32 policyId,
            bytes32 positionIdHash,
            address trader,
            address inputToken,
            address outputToken,
            bytes32 strategyHash,
            uint256 inputAmount,
            uint256 traderOutputAmount,
            uint256 solverFeeAmount,
            uint256 protocolFeeAmount,
            uint256 traderInputValue,
            uint256 traderOutputValue,
            uint256 treasuryOutputValue,
            bytes32 capacityEpochId,
            bytes32 intentHash
        ) = abi.decode(
            order.data,
            (
                bytes32,
                bytes32,
                bytes32,
                address,
                address,
                address,
                bytes32,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                bytes32,
                bytes32
            )
        );
        if (programId != DIRECT_PROGRAM_ID) revert DirectProgramMismatch();
        if (inputAmount != amount) revert InputAmountMismatch();
        orderHash = hash(order);
        return (amount, traderOutputAmount + solverFeeAmount + protocolFeeAmount, orderHash);
    }
}
