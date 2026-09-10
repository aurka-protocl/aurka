// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAurkaSwapVMExecutionContext {
    function validateSwapVMExecution(
        bytes32 orderHash,
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external view;
}

interface IAurkaMakerHook {
    function preTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;

    function postTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeIn,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;

    function preTransferOut(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;

    function postTransferOut(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;
}

/// @notice Maker-side guard binding an upstream SwapVM order to one AURKA call.
/// @dev The official VM remains unchanged. Its pre-transfer hook is part of the
/// Aqua-shipped order, so a direct call with the same order reaches this guard
/// but fails because the AURKA router has no active execution context.
contract AurkaSwapVMExecutionGuard is IAurkaMakerHook {
    address public immutable route;
    address public immutable swapVM;

    error OnlySwapVM();
    error UnauthorizedSwapVMExecution();

    constructor(address route_, address swapVM_) {
        route = route_;
        swapVM = swapVM_;
    }

    modifier onlySwapVM() {
        if (msg.sender != swapVM) revert OnlySwapVM();
        _;
    }

    function preTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata,
        bytes calldata
    ) external onlySwapVM {
        _validate(orderHash, maker, taker, tokenIn, tokenOut, amountIn, amountOut);
    }

    function preTransferOut(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata,
        bytes calldata
    ) external onlySwapVM {
        _validate(orderHash, maker, taker, tokenIn, tokenOut, amountIn, amountOut);
    }

    function postTransferIn(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external onlySwapVM { }

    function postTransferOut(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external onlySwapVM { }

    function _validate(
        bytes32 orderHash,
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) private view {
        if (taker != route) revert UnauthorizedSwapVMExecution();
        try IAurkaSwapVMExecutionContext(route).validateSwapVMExecution(
            orderHash, maker, taker, tokenIn, tokenOut, amountIn, amountOut
        ) { } catch {
            revert UnauthorizedSwapVMExecution();
        }
    }
}
