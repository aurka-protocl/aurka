// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AurkaSwapVMExecutionGuard,
    IAurkaMakerHook,
    IAurkaSwapVMExecutionContext
} from "../src/AurkaSwapVMExecutionGuard.sol";
import { TestBase } from "./TestBase.sol";

contract GuardRoute is IAurkaSwapVMExecutionContext {
    bool public enabled = true;

    function setEnabled(bool enabled_) external {
        enabled = enabled_;
    }

    function validateSwapVMExecution(
        bytes32 orderHash,
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external view {
        require(enabled);
    }
}

contract GuardVM {
    function invoke(
        IAurkaMakerHook hook,
        address taker,
        bytes32 orderHash,
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        hook.preTransferOut(maker, taker, tokenIn, tokenOut, amountIn, amountOut, orderHash, "", "");
    }
}

contract AurkaSwapVMExecutionGuardTest is TestBase {
    GuardRoute private route;
    GuardVM private vmCaller;
    AurkaSwapVMExecutionGuard private guard;

    function setUp() public {
        route = new GuardRoute();
        vmCaller = new GuardVM();
        guard = new AurkaSwapVMExecutionGuard(address(route), address(vmCaller));
    }

    function testOnlyPinnedVmCanReachHook() public {
        vm.expectRevert(AurkaSwapVMExecutionGuard.OnlySwapVM.selector);
        guard.preTransferOut(
            address(route),
            address(route),
            address(1),
            address(2),
            10,
            20,
            bytes32(uint256(1)),
            "",
            ""
        );
    }

    function testAuthorizedVmHookBindsTheRouteAndAmounts() public {
        vmCaller.invoke(
            guard, address(route), bytes32(uint256(3)), address(4), address(5), address(6), 7, 8
        );
    }

    function testWrongTakerCannotUseAuthorizedVm() public {
        vm.expectRevert(AurkaSwapVMExecutionGuard.UnauthorizedSwapVMExecution.selector);
        vmCaller.invoke(
            guard, address(this), bytes32(uint256(3)), address(4), address(5), address(6), 7, 8
        );
    }

    function testRouteCanDisableTheExecutionContext() public {
        route.setEnabled(false);
        vm.expectRevert(AurkaSwapVMExecutionGuard.UnauthorizedSwapVMExecution.selector);
        vmCaller.invoke(
            guard, address(route), bytes32(uint256(3)), address(4), address(5), address(6), 7, 8
        );
    }
}
