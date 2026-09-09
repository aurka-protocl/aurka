// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A separate token treasury for one owner-managed Space.
/// @dev Policy governance stays with the owner. This vault only holds funds,
/// approves the settlement custodian, and allows its owner to withdraw tokens.
contract AurkaSpaceVault {
    address public immutable owner;

    error NotOwner();
    error TokenCallFailed();

    constructor(address owner_) {
        owner = owner_;
    }

    function approve(address token, address spender, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _call(token, abi.encodeWithSignature("approve(address,uint256)", spender, amount));
    }

    function withdraw(address token, address recipient, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _call(token, abi.encodeWithSignature("transfer(address,uint256)", recipient, amount));
    }

    function _call(address token, bytes memory data) private {
        (bool success, bytes memory result) = token.call(data);
        if (
            token.code.length == 0 || !success
                || (result.length != 0 && !abi.decode(result, (bool)))
        ) {
            revert TokenCallFailed();
        }
    }
}
