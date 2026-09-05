// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Minimal } from "../../src/interfaces/IERC20Minimal.sol";

contract MockERC20 is IERC20Minimal {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    bool public transferFromReturnsFalse;
    bool public transferFromReverts;
    uint256 public transferFeeBps;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackBlocked;
    mapping(address account => uint256 balance) private _balances;
    mapping(address owner => mapping(address spender => uint256 amount)) private _allowances;

    constructor(string memory name_, uint8 decimals_) {
        name = name_;
        symbol = name_;
        decimals = decimals_;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (transferFromReverts) revert("mock transferFrom reverted");
        if (transferFromReturnsFalse) return false;
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "allowance");
        require(_balances[from] >= amount, "balance");
        if (allowed != type(uint256).max) _allowances[from][msg.sender] = allowed - amount;
        _balances[from] -= amount;
        uint256 received = amount - (amount * transferFeeBps / 10_000);
        _balances[to] += received;
        if (callbackTarget != address(0)) {
            callbackAttempted = true;
            (bool success,) = callbackTarget.call(callbackData);
            callbackBlocked = !success;
        }
        return true;
    }

    function setTransferFromReturnsFalse(bool value) external {
        transferFromReturnsFalse = value;
    }

    function setTransferFromReverts(bool value) external {
        transferFromReverts = value;
    }

    function setTransferFeeBps(uint256 value) external {
        require(value <= 10_000, "fee");
        transferFeeBps = value;
    }

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackAttempted = false;
        callbackBlocked = false;
    }

    function mint(address account, uint256 amount) external {
        _balances[account] += amount;
        totalSupply += amount;
    }
}
