// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAqua } from "../../src/interfaces/IAqua.sol";
import { IERC20Minimal } from "../../src/interfaces/IERC20Minimal.sol";

/// @notice Deterministic local Aqua fixture; it uses the official pull/push
/// virtual-balance direction and intentionally has no external dependencies.
contract MockAqua is IAqua {
    mapping(bytes32 key => uint256 balance) private _balances;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackBlocked;

    function seed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)
        external
    {
        _balances[_key(maker, app, strategyHash, token)] = amount;
    }

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount)
    {
        uint256 stored = _balances[_key(maker, app, strategyHash, token)];
        require(stored <= type(uint248).max, "balance overflow");
        return (uint248(stored), 1);
    }

    function safeBalances(
        address maker,
        address app,
        bytes32 strategyHash,
        address token0,
        address token1
    ) external view returns (uint256 balance0, uint256 balance1) {
        return (
            _balances[_key(maker, app, strategyHash, token0)],
            _balances[_key(maker, app, strategyHash, token1)]
        );
    }

    function ship(address, bytes calldata strategy, address[] calldata, uint256[] calldata)
        external
        pure
        returns (bytes32 strategyHash)
    {
        return keccak256(strategy);
    }

    function dock(address, bytes32, address[] calldata) external pure { }

    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to)
        external
    {
        _attemptCallback();
        bytes32 key = _key(maker, msg.sender, strategyHash, token);
        require(_balances[key] >= amount, "virtual balance");
        _balances[key] -= amount;
        require(IERC20Minimal(token).transferFrom(maker, to, amount), "pull transfer");
    }

    function push(address maker, address app, bytes32 strategyHash, address token, uint256 amount)
        external
    {
        _attemptCallback();
        bytes32 key = _key(maker, app, strategyHash, token);
        require(IERC20Minimal(token).transferFrom(msg.sender, maker, amount), "push transfer");
        _balances[key] += amount;
    }

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackAttempted = false;
        callbackBlocked = false;
    }

    function _attemptCallback() private {
        if (callbackTarget == address(0)) return;
        callbackAttempted = true;
        (bool success,) = callbackTarget.call(callbackData);
        callbackBlocked = !success;
    }

    function _key(address maker, address app, bytes32 strategyHash, address token)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(maker, app, strategyHash, token));
    }
}
