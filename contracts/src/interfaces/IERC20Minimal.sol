// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The standard ERC-20 surface required by the settlement adapter.
/// @dev AURKA deliberately does not use token-specific extensions.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
