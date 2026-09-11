// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaSepoliaOrderValidator } from "../src/AurkaSepoliaOrderValidator.sol";
import {
    AurkaSepoliaSwapVMRouter,
    IAurkaSepoliaTradeMath,
    IAurkaSepoliaUpstreamExecutor
} from "../src/AurkaSepoliaSwapVMRouter.sol";
import { AurkaSepoliaTradeMath } from "../src/AurkaSepoliaTradeMath.sol";
import {
    AurkaSepoliaUpstreamExecutor,
    IAurkaSepoliaOrderValidatorExecutor
} from "../src/AurkaSepoliaUpstreamExecutor.sol";
import { AurkaDirectSwapVM } from "../src/AurkaDirectSwapVM.sol";
import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import { RiskModeRegistry } from "../src/RiskModeRegistry.sol";
import { MockAqua } from "./mocks/MockAqua.sol";
import { TestBase } from "./TestBase.sol";

contract AurkaSepoliaRouterSizeTest is TestBase {
    uint256 internal constant EIP170_RUNTIME_LIMIT = 24_576;
    uint256 internal constant EIP3860_INITCODE_LIMIT = 49_152;

    function testSepoliaRouterFitsEthereumContractLimits() public {
        assertLe(type(AurkaSepoliaSwapVMRouter).creationCode.length, EIP3860_INITCODE_LIMIT);
        assertLe(type(AurkaSepoliaOrderValidator).runtimeCode.length, EIP170_RUNTIME_LIMIT);
        assertLe(type(AurkaSepoliaTradeMath).runtimeCode.length, EIP170_RUNTIME_LIMIT);
        assertLe(type(AurkaSepoliaUpstreamExecutor).creationCode.length, EIP3860_INITCODE_LIMIT);
    }

    function testSepoliaRouterExecutorWiringCanBeInitializedOnce() public {
        AurkaPolicyRegistry policyRegistry = new AurkaPolicyRegistry();
        RiskModeRegistry riskRegistry = new RiskModeRegistry(policyRegistry);
        MockAqua aqua = new MockAqua();
        AurkaDirectSwapVM swapVM = new AurkaDirectSwapVM();
        AurkaSepoliaOrderValidator orderValidator = new AurkaSepoliaOrderValidator();
        AurkaSepoliaTradeMath tradeMath = new AurkaSepoliaTradeMath();
        AurkaSepoliaUpstreamExecutor executor = new AurkaSepoliaUpstreamExecutor(
            swapVM,
            aqua,
            policyRegistry,
            IAurkaSepoliaOrderValidatorExecutor(address(orderValidator))
        );
        AurkaSepoliaSwapVMRouter router = new AurkaSepoliaSwapVMRouter(
            policyRegistry,
            riskRegistry,
            aqua,
            swapVM,
            IAurkaSepoliaTradeMath(address(tradeMath)),
            IAurkaSepoliaUpstreamExecutor(address(executor))
        );
        executor.initializeRouter(address(router));
        assertEq(router.swapVMGuard(), executor.swapVMGuard());
        assertEq(executor.router(), address(router));
    }
}
