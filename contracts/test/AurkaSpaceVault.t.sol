// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { TestBase } from "./TestBase.sol";
import { AurkaSpaceVault } from "../src/AurkaSpaceVault.sol";
import { AurkaSpaceVaultFactory } from "../src/AurkaSpaceVaultFactory.sol";

contract VaultTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract VaultDockAqua {
    address public caller;
    address public app;
    bytes32 public strategyHash;
    uint256 public tokenCount;

    function dock(address app_, bytes32 strategyHash_, address[] calldata tokens) external {
        caller = msg.sender;
        app = app_;
        strategyHash = strategyHash_;
        tokenCount = tokens.length;
    }
}

contract AurkaSpaceVaultTest is TestBase {
    function _factory() private returns (AurkaSpaceVaultFactory) {
        return
            new AurkaSpaceVaultFactory(address(1), address(2), address(3), address(4), address(5));
    }

    function testIndependentTreasuriesAndIdempotentDeployment() public {
        AurkaSpaceVaultFactory factory = _factory();
        bytes32 first = keccak256("first");
        address one = factory.createVault(first);
        address two = factory.createVault(keccak256("second"));
        assertTrue(one != two);
        assertEq(factory.createVault(first), one);
        assertEq(factory.vaultAddress(address(this), first), one);
        VaultTestToken token = new VaultTestToken();
        token.mint(one, 100);
        token.mint(two, 200);
        AurkaSpaceVault(one).approve(address(token), address(123), 100);
        assertEq(token.allowance(one, address(123)), 100);
        assertEq(token.allowance(two, address(123)), 0);
        AurkaSpaceVault(one).withdraw(address(token), address(this), 40);
        assertEq(token.balanceOf(one), 60);
        assertEq(token.balanceOf(two), 200);
    }

    function testOtherOwnerCannotWithdrawApproveOrClaimTreasury() public {
        AurkaSpaceVaultFactory factory = _factory();
        bytes32 id = keccak256("space");
        address vault = factory.createVault(id);
        vm.startPrank(address(0xBAD));
        vm.expectRevert(AurkaSpaceVault.NotOwner.selector);
        AurkaSpaceVault(vault).approve(address(1), address(2), 10);
        vm.expectRevert(AurkaSpaceVault.NotOwner.selector);
        AurkaSpaceVault(vault).withdraw(address(1), address(2), 10);
        assertTrue(factory.createVault(id) != vault);
        vm.stopPrank();
    }

    function testOwnerCanDockAquaStrategyForExactRecovery() public {
        AurkaSpaceVault vault = new AurkaSpaceVault(address(this), address(this));
        vault.finalizeInitialization();
        VaultDockAqua aqua = new VaultDockAqua();
        address[] memory tokens = new address[](2);
        tokens[0] = address(1);
        tokens[1] = address(2);
        bytes32 strategyHash = keccak256("fixed-price-strategy");

        vault.dockAquaStrategy(address(aqua), address(3), strategyHash, tokens);

        assertEq(aqua.caller(), address(vault));
        assertEq(aqua.app(), address(3));
        assertEq(aqua.strategyHash(), strategyHash);
        assertEq(aqua.tokenCount(), 2);
    }

    function testNonOwnerCannotDockAquaStrategy() public {
        AurkaSpaceVault vault = new AurkaSpaceVault(address(this), address(this));
        vault.finalizeInitialization();
        address[] memory tokens = new address[](1);
        tokens[0] = address(1);
        vm.prank(address(0xBAD));
        vm.expectRevert(AurkaSpaceVault.NotOwner.selector);
        vault.dockAquaStrategy(address(2), address(3), keccak256("strategy"), tokens);
    }
}
