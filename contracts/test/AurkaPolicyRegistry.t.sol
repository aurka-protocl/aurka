// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import { TestBase } from "./TestBase.sol";

contract AurkaPolicyRegistryTest is TestBase {
    AurkaPolicyRegistry internal registry;

    bytes32 internal constant POLICY_ID = keccak256("genesis-policy");
    address internal constant GOVERNANCE = address(0xA11CE);
    address internal constant TREASURY = address(0xBEEF);
    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);
    address internal constant LINK = address(0x1003);

    function setUp() public {
        registry = new AurkaPolicyRegistry();
        AurkaPolicyRegistry.AssetConfig[] memory assets = _assets();
        vm.prank(GOVERNANCE);
        registry.createPolicy(POLICY_ID, TREASURY, GOVERNANCE, assets, 50_000, _fee());
    }

    function testCreatesThreeAssetPolicy() public view {
        AurkaPolicyRegistry.Policy memory policy = registry.getPolicy(POLICY_ID);
        assertEq(policy.treasury, TREASURY);
        assertEq(policy.governance, GOVERNANCE);
        assertEq(policy.maximumTransactionValue, 50_000);
        assertEq(policy.nonce, 1);
        assertEq(registry.assetCount(POLICY_ID), 3);
        AurkaPolicyRegistry.AssetBounds memory usdc = registry.assetBounds(POLICY_ID, USDC);
        assertEq(usdc.minimumWeightBps, 5_500);
        assertEq(usdc.maximumWeightBps, 10_000);
    }

    function testOnlyGovernanceCanChangePolicy() public {
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(AurkaPolicyRegistry.NotGovernance.selector, POLICY_ID, attacker)
        );
        registry.setMaximumTransactionValue(POLICY_ID, 60_000);
    }

    function testRejectsZeroMaximumTransactionValueOnCreateAndUpdate() public {
        vm.prank(GOVERNANCE);
        vm.expectRevert(
            abi.encodeWithSelector(AurkaPolicyRegistry.InvalidMaximumTransactionValue.selector, 0)
        );
        registry.setMaximumTransactionValue(POLICY_ID, 0);

        AurkaPolicyRegistry freshRegistry = new AurkaPolicyRegistry();
        vm.prank(GOVERNANCE);
        vm.expectRevert(
            abi.encodeWithSelector(AurkaPolicyRegistry.InvalidMaximumTransactionValue.selector, 0)
        );
        freshRegistry.createPolicy(
            keccak256("zero-limit-policy"), TREASURY, GOVERNANCE, _assets(), 0, _fee()
        );
    }

    function testPolicyLifecycleIncrementsNonce() public {
        vm.startPrank(GOVERNANCE);
        registry.updateAssetBounds(POLICY_ID, WETH, 0, 3_400);
        registry.setMaximumTransactionValue(POLICY_ID, 40_000);
        registry.setPaused(POLICY_ID, true);
        registry.setFeeConfiguration(POLICY_ID, _fee());
        vm.stopPrank();

        assertEq(registry.policyNonce(POLICY_ID), 5);
        assertEq(registry.maximumTransactionValue(POLICY_ID), 40_000);
        assertTrue(registry.isPaused(POLICY_ID));
    }

    function testGovernanceCanAddAssetAndWidenBounds() public {
        AurkaPolicyRegistry.AssetConfig memory asset = AurkaPolicyRegistry.AssetConfig({
            token: address(0x1004),
            decimals: 18,
            minimumWeightBps: 0,
            maximumWeightBps: 1_000
        });
        vm.startPrank(GOVERNANCE);
        registry.addAsset(POLICY_ID, asset);
        registry.updateAssetBounds(POLICY_ID, LINK, 0, 2_000);
        vm.stopPrank();
        assertEq(registry.assetCount(POLICY_ID), 4);
        assertEq(registry.assetBounds(POLICY_ID, LINK).maximumWeightBps, 2_000);
    }

    function testRejectsDuplicateAndUnsupportedAssets() public {
        AurkaPolicyRegistry.AssetConfig memory duplicate = AurkaPolicyRegistry.AssetConfig({
            token: USDC,
            decimals: 6,
            minimumWeightBps: 0,
            maximumWeightBps: 1_000
        });
        vm.prank(GOVERNANCE);
        vm.expectRevert(abi.encodeWithSelector(AurkaPolicyRegistry.DuplicateAsset.selector, USDC));
        registry.addAsset(POLICY_ID, duplicate);

        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaPolicyRegistry.UnsupportedAsset.selector, POLICY_ID, address(0x9999)
            )
        );
        registry.assetBounds(POLICY_ID, address(0x9999));
    }

    function testRejectsImpossiblePortfolioBounds() public {
        vm.prank(GOVERNANCE);
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaPolicyRegistry.InvalidPortfolioBounds.selector, 10_500, 16_500
            )
        );
        registry.updateAssetBounds(POLICY_ID, WETH, 5_000, 5_000);
    }

    function testRejectsInvalidFeeDistribution() public {
        AurkaPolicyRegistry.FeeConfig memory fee = _fee();
        fee.solverFeeBps = 6;
        vm.prank(GOVERNANCE);
        vm.expectRevert(AurkaPolicyRegistry.InvalidFeeConfiguration.selector);
        registry.setFeeConfiguration(POLICY_ID, fee);
    }

    function testRejectsFeeCapAboveBoundedMaximum() public {
        AurkaPolicyRegistry.FeeConfig memory fee = _fee();
        fee.maximumFeeBps = 101;
        vm.prank(GOVERNANCE);
        vm.expectRevert(AurkaPolicyRegistry.InvalidFeeConfiguration.selector);
        registry.setFeeConfiguration(POLICY_ID, fee);
    }

    function testTwoStepGovernanceTransfer() public {
        address nextGovernance = address(0xCAFE);
        vm.prank(GOVERNANCE);
        registry.transferGovernance(POLICY_ID, nextGovernance);
        vm.prank(nextGovernance);
        registry.acceptGovernance(POLICY_ID);
        assertEq(registry.governanceOf(POLICY_ID), nextGovernance);
        assertEq(registry.policyNonce(POLICY_ID), 2);
    }

    function testFuzzValidBoundsRemainConfigurable(uint16 newMaximum) public {
        newMaximum = uint16(bound(newMaximum, 3_500, 10_000));
        vm.prank(GOVERNANCE);
        registry.updateAssetBounds(POLICY_ID, WETH, 0, newMaximum);
        assertEq(registry.assetBounds(POLICY_ID, WETH).maximumWeightBps, newMaximum);
    }

    function _assets() internal pure returns (AurkaPolicyRegistry.AssetConfig[] memory assets) {
        assets = new AurkaPolicyRegistry.AssetConfig[](3);
        assets[0] = AurkaPolicyRegistry.AssetConfig(USDC, 6, 5_500, 10_000);
        assets[1] = AurkaPolicyRegistry.AssetConfig(WETH, 18, 0, 3_500);
        assets[2] = AurkaPolicyRegistry.AssetConfig(LINK, 18, 0, 1_500);
    }

    function _fee() internal pure returns (AurkaPolicyRegistry.FeeConfig memory) {
        return AurkaPolicyRegistry.FeeConfig({
            baseFeeBps: 20,
            slopeBps: 80,
            maximumFeeBps: 100,
            treasuryBaseFeeBps: 10,
            solverFeeBps: 5,
            protocolFeeBps: 5,
            treasuryFeeRecipient: TREASURY,
            protocolFeeRecipient: address(0xFEE)
        });
    }
}
