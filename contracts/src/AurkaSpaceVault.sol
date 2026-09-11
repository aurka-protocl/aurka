// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAqua } from "./interfaces/IAqua.sol";

/// @notice A separate token treasury for one owner-managed Space.
/// @dev Policy governance stays with the owner. This vault only holds funds,
/// approves the settlement custodian, and allows its owner to withdraw tokens.
contract AurkaSpaceVault {
    address public immutable owner;
    address public immutable initializationAuthority;
    bool public initializationFinalized;

    error NotOwner();
    error NotInitializationAuthority();
    error InitializationFinalized();
    error InvalidAddress();
    error TokenCallFailed();
    error InvalidStrategy();

    constructor(address owner_, address initializationAuthority_) {
        if (owner_ == address(0) || initializationAuthority_ == address(0)) {
            revert InvalidAddress();
        }
        owner = owner_;
        initializationAuthority = initializationAuthority_;
    }

    function initializeApproval(address token, address spender, uint256 amount) external {
        if (msg.sender != initializationAuthority) revert NotInitializationAuthority();
        if (initializationFinalized) revert InitializationFinalized();
        _call(token, abi.encodeWithSignature("approve(address,uint256)", spender, amount));
    }

    /// @notice Registers this vault as a maker for an Aqua strategy.
    /// @dev Aqua.ship records virtual balances against its caller. Keeping the
    /// call inside the vault preserves the maker boundary: the factory can
    /// initialize only this vault, while Aqua never sees the factory as maker.
    function initializeAquaStrategy(
        address aqua,
        address app,
        bytes calldata strategy,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external returns (bytes32 strategyHash) {
        if (msg.sender != initializationAuthority) revert NotInitializationAuthority();
        if (initializationFinalized || aqua == address(0) || app == address(0)) {
            revert InvalidStrategy();
        }
        if (strategy.length == 0 || tokens.length == 0 || tokens.length != amounts.length) {
            revert InvalidStrategy();
        }
        strategyHash = IAqua(aqua).ship(app, strategy, tokens, amounts);
        if (strategyHash != keccak256(strategy)) revert InvalidStrategy();
    }

    function finalizeInitialization() external {
        if (msg.sender != initializationAuthority) revert NotInitializationAuthority();
        if (initializationFinalized) revert InitializationFinalized();
        initializationFinalized = true;
    }

    function approve(address token, address spender, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _call(token, abi.encodeWithSignature("approve(address,uint256)", spender, amount));
    }

    function withdraw(address token, address recipient, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _call(token, abi.encodeWithSignature("transfer(address,uint256)", recipient, amount));
    }

    /// @notice Closes this vault's Aqua strategy before an owner-led recovery.
    /// @dev Aqua records the vault as maker because this call originates here;
    ///      the owner can then withdraw the exact underlying token balances.
    function dockAquaStrategy(
        address aqua,
        address app,
        bytes32 strategyHash,
        address[] calldata tokens
    ) external {
        if (msg.sender != owner) revert NotOwner();
        if (
            initializationFinalized == false || aqua == address(0) || app == address(0)
                || strategyHash == bytes32(0) || tokens.length == 0
        ) revert InvalidStrategy();
        IAqua(aqua).dock(app, strategyHash, tokens);
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
