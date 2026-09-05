// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The narrow Aqua boundary used by the AURKA settlement adapter.
/// @dev Function shapes match the official 1inch Aqua IAqua interface.
interface IAqua {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);

    function safeBalances(
        address maker,
        address app,
        bytes32 strategyHash,
        address token0,
        address token1
    ) external view returns (uint256 balance0, uint256 balance1);

    function ship(
        address app,
        bytes calldata strategy,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external returns (bytes32 strategyHash);

    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;

    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to)
        external;

    function push(address maker, address app, bytes32 strategyHash, address token, uint256 amount)
        external;
}
