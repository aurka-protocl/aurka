// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import { AurkaSpaceVault } from "../src/AurkaSpaceVault.sol";
import { AurkaSpaceVaultFactory } from "../src/AurkaSpaceVaultFactory.sol";
import { AurkaSwapVMRouter } from "../src/AurkaSwapVMRouter.sol";
import { AurkaDirectSwapVM } from "../src/AurkaDirectSwapVM.sol";
import { RiskModeRegistry } from "../src/RiskModeRegistry.sol";
import { DirectSettlement } from "../src/libraries/DirectSettlement.sol";
import { PriceProtection } from "../src/libraries/PriceProtection.sol";
import { TestBase } from "./TestBase.sol";
import { MockAqua } from "./mocks/MockAqua.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPriceOracle } from "./mocks/MockPriceOracle.sol";

contract AurkaSpaceCreationTest is TestBase {
    bytes32 internal constant SPACE_ID = keccak256("space:atomic");
    bytes32 internal constant POLICY_ID = keccak256("policy:atomic");
    bytes32 internal constant STRATEGY = keccak256("strategy:atomic");
    address internal constant PROTOCOL = address(0xCAFE);

    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockAqua internal aqua;
    MockPriceOracle internal oracle;
    AurkaPolicyRegistry internal registry;
    AurkaSwapVMRouter internal router;
    AurkaSpaceVaultFactory internal factory;
    AurkaPolicyRegistry.AssetConfig[] internal assets;
    AurkaSpaceVaultFactory.SpaceInitialization internal params;

    function setUp() public {
        vm.warp(1_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        aqua = new MockAqua();
        oracle = new MockPriceOracle();
        registry = new AurkaPolicyRegistry();
        RiskModeRegistry risk = new RiskModeRegistry(registry);
        AurkaDirectSwapVM swapVM = new AurkaDirectSwapVM();
        router = new AurkaSwapVMRouter(registry, risk, aqua, swapVM);
        factory = new AurkaSpaceVaultFactory(
            address(registry), address(router), address(aqua), address(usdc), address(weth)
        );
        registry.setInitializationFactory(address(factory));

        usdc.mint(address(this), 35_000e6);
        weth.mint(address(this), 5e18);
        usdc.approve(address(factory), 35_000e6);
        weth.approve(address(factory), 5e18);

        oracle.setPrice(address(usdc), 1e6, 6, uint64(block.timestamp - 1), bytes32(uint256(11)));
        oracle.setPrice(
            address(weth), 3200e18, 18, uint64(block.timestamp - 1), bytes32(uint256(22))
        );

        assets.push(AurkaPolicyRegistry.AssetConfig(address(usdc), 6, 5_500, 10_000));
        assets.push(AurkaPolicyRegistry.AssetConfig(address(weth), 18, 0, 3_500));
        params = _buildParams();
    }

    function _buildParams()
        internal
        view
        returns (AurkaSpaceVaultFactory.SpaceInitialization memory p)
    {
        p.spaceId = SPACE_ID;
        p.policyId = POLICY_ID;
        p.strategyHash = STRATEGY;
        p.owner = address(this);
        p.assets = assets;
        p.maximumTransactionValue = 5_000;
        p.fee = AurkaPolicyRegistry.FeeConfig({
            baseFeeBps: 20,
            slopeBps: 80,
            maximumFeeBps: 100,
            treasuryBaseFeeBps: 10,
            solverFeeBps: 5,
            protocolFeeBps: 5,
            treasuryFeeRecipient: factory.vaultAddress(address(this), SPACE_ID),
            protocolFeeRecipient: PROTOCOL
        });
        p.priceOracle = address(oracle);
        p.priceMaxAgeSeconds = 86_400;
        p.maximumPriceDeviationBps = 100;
        p.capacityEpoch = _epoch();
        p.priceInput = _priceInput();
    }

    function _priceInput() internal view returns (PriceProtection.SettlementInput memory input) {
        PriceProtection.Snapshot memory usdcPrice = PriceProtection.Snapshot({
            token: address(usdc),
            snapshotId: bytes32(uint256(11)),
            price: 1e6,
            priceDecimals: 6,
            observedAt: uint64(block.timestamp - 1)
        });
        PriceProtection.Snapshot memory wethPrice = PriceProtection.Snapshot({
            token: address(weth),
            snapshotId: bytes32(uint256(22)),
            price: 3200e18,
            priceDecimals: 18,
            observedAt: uint64(block.timestamp - 1)
        });
        input = PriceProtection.SettlementInput({
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            traderInputReferencePrice: wethPrice,
            traderInputExecutionPrice: wethPrice,
            traderOutputReferencePrice: usdcPrice,
            traderOutputExecutionPrice: usdcPrice,
            approvedTraderInputSnapshotId: wethPrice.snapshotId,
            approvedTraderOutputSnapshotId: usdcPrice.snapshotId,
            traderInputAmount: (uint256(50_000) * 10 ** 18 + 3200 - 1) / 3200,
            traderOutputAmount: 50_000e6,
            traderInputDecimals: 18,
            traderOutputDecimals: 6,
            valueDecimals: 0,
            currentTime: uint64(block.timestamp),
            maximumPriceAgeSeconds: 86_400,
            maximumPriceDeviationBps: 100
        });
    }

    function _epoch() internal view returns (DirectSettlement.CapacityEpoch memory epoch) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        uint256[] memory balances = new uint256[](2);
        balances[0] = 35_000e6;
        balances[1] = 5e18;
        PriceProtection.Snapshot[] memory prices = new PriceProtection.Snapshot[](2);
        prices[0] = PriceProtection.Snapshot(
            address(usdc), bytes32(uint256(11)), 1e6, 6, uint64(block.timestamp - 1)
        );
        prices[1] = PriceProtection.Snapshot(
            address(weth), bytes32(uint256(22)), 3200e18, 18, uint64(block.timestamp - 1)
        );
        PriceProtection.SettlementInput memory input = _priceInput();
        epoch = DirectSettlement.CapacityEpoch({
            positionIdHash: SPACE_ID,
            traderInputTokenId: bytes32(uint256(uint160(address(weth)))),
            traderOutputTokenId: bytes32(uint256(uint160(address(usdc)))),
            balanceSnapshot: keccak256(abi.encode(tokens, balances)),
            priceSnapshot: router.priceSnapshotHash(input),
            portfolioPriceSnapshot: keccak256(abi.encode(tokens, prices)),
            policyNonce: 3,
            riskCertificateHash: bytes32(0),
            aquaStrategyHash: STRATEGY,
            capacityBaseline: 0,
            consumedBefore: 0,
            chainId: block.chainid,
            verifyingContract: address(router),
            capacityEpochId: bytes32(0)
        });
    }

    function testOwnerCreatesFundedConfiguredAndAuthorizedSpaceInOneCall() public {
        address expectedVault = factory.vaultAddress(address(this), SPACE_ID);
        (address vault, bytes32 epochId, uint256 baseline) =
            factory.createAndInitializeSpace(params);
        assertEq(vault, expectedVault);
        assertTrue(epochId != bytes32(0));
        assertTrue(baseline != 0);
        assertEq(usdc.balanceOf(vault), 35_000e6);
        assertEq(weth.balanceOf(vault), 5e18);
        assertEq(usdc.allowance(vault, address(aqua)), 35_000e6);
        assertEq(weth.allowance(vault, address(aqua)), 5e18);
        (uint248 usdcBalance,) = aqua.rawBalances(vault, address(router), STRATEGY, address(usdc));
        (uint248 wethBalance,) = aqua.rawBalances(vault, address(router), STRATEGY, address(weth));
        assertEq(usdcBalance, 35_000e6);
        assertEq(wethBalance, 5e18);
        AurkaSwapVMRouter.CapacityState memory state =
            router.capacityState(SPACE_ID, address(weth), address(usdc));
        assertEq(state.capacityEpochId, epochId);
        assertEq(state.capacityBaselineValue, baseline);
        assertTrue(AurkaSpaceVault(vault).initializationFinalized());
        assertEq(AurkaSpaceVault(vault).owner(), address(this));
        assertEq(registry.governanceOf(POLICY_ID), address(this));
        assertEq(registry.treasuryOf(POLICY_ID), vault);
    }

    function testWrongOwnerCannotUseAggregateEntryPoint() public {
        params.owner = address(0xBEEF);
        vm.expectRevert(AurkaSpaceVaultFactory.UnauthorizedInitialization.selector);
        factory.createAndInitializeSpace(params);
    }

    function testAnyFundingFailureRollsBackVaultAndPolicy() public {
        weth.setTransferFromReturnsFalse(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaSpaceVaultFactory.TokenTransferFailed.selector, address(weth)
            )
        );
        factory.createAndInitializeSpace(params);
        assertEq(factory.vaultAddress(address(this), SPACE_ID).code.length, 0);
        vm.expectRevert(
            abi.encodeWithSelector(AurkaPolicyRegistry.PolicyNotFound.selector, POLICY_ID)
        );
        registry.getPolicy(POLICY_ID);
        assertEq(usdc.balanceOf(address(this)), 35_000e6);
    }

    function testInvalidLimitOrAlteredCommitmentCannotLeavePartialState() public {
        params.maximumTransactionValue = 0;
        vm.expectRevert();
        factory.createAndInitializeSpace(params);
        assertEq(factory.vaultAddress(address(this), SPACE_ID).code.length, 0);
        assertEq(usdc.balanceOf(address(this)), 35_000e6);

        params = _buildParams();
        params.capacityEpoch.balanceSnapshot = bytes32(uint256(1));
        vm.expectRevert();
        factory.createAndInitializeSpace(params);
        assertEq(factory.vaultAddress(address(this), SPACE_ID).code.length, 0);
        assertEq(usdc.balanceOf(address(this)), 35_000e6);
    }

    function testReentrantTokenCallbackIsBlockedDuringInitialization() public {
        usdc.configureCallback(
            address(factory),
            abi.encodeWithSelector(factory.createAndInitializeSpace.selector, params)
        );
        factory.createAndInitializeSpace(params);
        assertTrue(usdc.callbackAttempted());
        assertTrue(usdc.callbackBlocked());
    }

    function testInitializationAuthorityCannotBeReplaced() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(AurkaPolicyRegistry.UnauthorizedInitialization.selector);
        registry.setInitializationFactory(address(0xCAFE));
    }
}
