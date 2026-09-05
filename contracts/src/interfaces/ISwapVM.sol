// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The view/execution boundary of the official SwapVM router.
/// @dev MakerTraits is represented by its ABI type, uint256, to avoid importing
///      the external implementation into deterministic local builds.
interface ISwapVM {
    struct Order {
        address maker;
        uint256 traits;
        bytes data;
    }

    function hash(Order calldata order) external view returns (bytes32);

    function quote(Order calldata order, uint256 amount, bytes calldata takerTraitsAndData)
        external
        view
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    function swap(Order calldata order, uint256 amount, bytes calldata takerTraitsAndData)
        external
        payable
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}
