// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import { RiskModeRegistry } from "../src/RiskModeRegistry.sol";
import { TestBase } from "./TestBase.sol";

contract RiskModeRegistryTest is TestBase {
    AurkaPolicyRegistry internal policyRegistry;
    RiskModeRegistry internal riskRegistry;

    bytes32 internal constant POLICY_ID = keccak256("genesis-policy");
    uint256 internal constant WATCHTOWER_KEY = 0xA11CE123;
    address internal watchtower;
    address internal constant GOVERNANCE = address(0xA11CE);
    address internal constant TREASURY = address(0xBEEF);
    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);
    address internal constant LINK = address(0x1003);

    function setUp() public {
        vm.warp(1_800_000_000);
        watchtower = vm.addr(WATCHTOWER_KEY);
        policyRegistry = new AurkaPolicyRegistry();
        riskRegistry = new RiskModeRegistry(policyRegistry);
        vm.prank(GOVERNANCE);
        policyRegistry.createPolicy(POLICY_ID, TREASURY, GOVERNANCE, _assets(), 50_000, _fee());
        vm.prank(GOVERNANCE);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, true);
    }

    function testAppliesSignedTighteningCertificate() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        bytes memory signature = _sign(certificate);
        riskRegistry.submitRiskCertificate(certificate, bounds, signature);

        assertEq(
            uint256(riskRegistry.currentRiskMode(POLICY_ID)),
            uint256(RiskModeRegistry.RiskMode.CAUTIOUS)
        );
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 37_500);
        RiskModeRegistry.ActiveAssetBound memory weth =
            riskRegistry.effectiveAssetBound(POLICY_ID, WETH);
        assertEq(weth.maximumWeightBps, 3_400);
        assertEq(riskRegistry.lastNonce(POLICY_ID), 1);
    }

    function testRiskAgentCannotWidenAssetBounds() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        bounds[0].minimumWeightBps = 5_400;
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        bytes memory signature = _sign(certificate);
        vm.expectRevert(
            abi.encodeWithSelector(RiskModeRegistry.RiskCannotWidenAsset.selector, USDC)
        );
        riskRegistry.submitRiskCertificate(certificate, bounds, signature);
    }

    function testRiskAgentCannotWidenTransactionLimit() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.NORMAL, 50_001, 1, bounds);
        bytes memory signature = _sign(certificate);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskModeRegistry.RiskCannotWidenTransactionLimit.selector, 50_001, 50_000
            )
        );
        riskRegistry.submitRiskCertificate(certificate, bounds, signature);
    }

    function testRejectsReplayAndStaleNonce() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        bytes memory signature = _sign(certificate);
        riskRegistry.submitRiskCertificate(certificate, bounds, signature);
        vm.expectRevert(abi.encodeWithSelector(RiskModeRegistry.InvalidNonce.selector, 2, 1));
        riskRegistry.submitRiskCertificate(certificate, bounds, signature);
    }

    function testRejectsExpiredCertificate() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        certificate.issuedAt = uint64(block.timestamp - 100);
        certificate.expiresAt = uint64(block.timestamp);
        bytes memory signature = _sign(certificate);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskModeRegistry.CertificateExpired.selector, certificate.expiresAt
            )
        );
        riskRegistry.submitRiskCertificate(certificate, bounds, signature);
    }

    function testRejectsSignatureFromUnauthorizedKey() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, riskRegistry.hashTypedData(certificate));
        vm.expectRevert(RiskModeRegistry.InvalidSignature.selector);
        riskRegistry.submitRiskCertificate(certificate, bounds, abi.encodePacked(r, s, v));
    }

    function testOnlyGovernanceCanAuthorizeWatchtower() public {
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(RiskModeRegistry.NotGovernance.selector, POLICY_ID, attacker)
        );
        riskRegistry.setWatchtower(POLICY_ID, address(0xCAFE), true);
    }

    function testPauseCertificateHasNoCapacity() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory invalid =
            _certificate(RiskModeRegistry.RiskMode.PAUSED, 1, 1, bounds);
        bytes memory invalidSignature = _sign(invalid);
        vm.expectRevert(
            abi.encodeWithSelector(RiskModeRegistry.PausedCertificateMustHaveZeroCapacity.selector)
        );
        riskRegistry.submitRiskCertificate(invalid, bounds, invalidSignature);

        RiskModeRegistry.RiskCertificate memory valid =
            _certificate(RiskModeRegistry.RiskMode.PAUSED, 0, 1, bounds);
        riskRegistry.submitRiskCertificate(valid, bounds, _sign(valid));
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 0);
    }

    function testExpiredCertificateFallsBackToHardPolicy() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));
        vm.warp(certificate.expiresAt + 1);
        assertEq(
            uint256(riskRegistry.currentRiskMode(POLICY_ID)),
            uint256(RiskModeRegistry.RiskMode.NORMAL)
        );
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 50_000);
        assertEq(riskRegistry.effectiveAssetBound(POLICY_ID, WETH).maximumWeightBps, 3_500);
    }

    function testLaterHardTighteningDominatesActiveCertificate() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));

        vm.startPrank(GOVERNANCE);
        policyRegistry.updateAssetBounds(POLICY_ID, WETH, 100, 3_300);
        policyRegistry.setMaximumTransactionValue(POLICY_ID, 30_000);
        vm.stopPrank();

        RiskModeRegistry.ActiveAssetBound memory effective =
            riskRegistry.effectiveAssetBound(POLICY_ID, WETH);
        assertEq(effective.minimumWeightBps, 100);
        assertEq(effective.maximumWeightBps, 3_300);
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 30_000);
    }

    function testHardBoundTighteningInvalidatesActiveCertificate() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));
        assertTrue(riskRegistry.isRiskActive(POLICY_ID));

        vm.prank(GOVERNANCE);
        policyRegistry.updateAssetBounds(POLICY_ID, WETH, 3_500, 3_500);

        assertFalse(riskRegistry.isRiskActive(POLICY_ID));
        assertEq(
            uint256(riskRegistry.currentRiskMode(POLICY_ID)),
            uint256(RiskModeRegistry.RiskMode.NORMAL)
        );
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 50_000);
        RiskModeRegistry.ActiveAssetBound memory effective =
            riskRegistry.effectiveAssetBound(POLICY_ID, WETH);
        assertEq(effective.minimumWeightBps, 3_500);
        assertEq(effective.maximumWeightBps, 3_500);
    }

    function testAddingManagedAssetInvalidatesActiveCertificate() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));
        assertTrue(riskRegistry.isRiskActive(POLICY_ID));

        address newAsset = address(0x1004);
        vm.prank(GOVERNANCE);
        policyRegistry.addAsset(
            POLICY_ID,
            AurkaPolicyRegistry.AssetConfig({
                token: newAsset,
                decimals: 18,
                minimumWeightBps: 0,
                maximumWeightBps: 1_000
            })
        );

        assertFalse(riskRegistry.isRiskActive(POLICY_ID));
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 50_000);
        RiskModeRegistry.ActiveAssetBound memory effective =
            riskRegistry.effectiveAssetBound(POLICY_ID, newAsset);
        assertEq(effective.minimumWeightBps, 0);
        assertEq(effective.maximumWeightBps, 1_000);
    }

    function testRevocationInvalidatesActiveCertificate() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));
        vm.prank(GOVERNANCE);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, false);
        assertEq(
            uint256(riskRegistry.currentRiskMode(POLICY_ID)),
            uint256(RiskModeRegistry.RiskMode.NORMAL)
        );
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 50_000);
    }

    function testRevocationCannotBeUndoneByReauthorizingWatchtower() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));

        vm.startPrank(GOVERNANCE);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, false);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, true);
        vm.stopPrank();

        assertEq(riskRegistry.watchtowerAuthorizationEpoch(POLICY_ID, watchtower), 3);
        RiskModeRegistry.ActiveRisk memory raw = riskRegistry.rawActiveRisk(POLICY_ID);
        assertTrue(raw.exists);
        assertEq(raw.nonce, 1);
        assertFalse(riskRegistry.isRiskActive(POLICY_ID));
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 50_000);

        RiskModeRegistry.RiskCertificate memory replacement =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 2, bounds);
        riskRegistry.submitRiskCertificate(replacement, bounds, _sign(replacement));
        assertTrue(riskRegistry.isRiskActive(POLICY_ID));
        assertEq(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 20_000);
    }

    function testPendingCertificateCannotSurviveWatchtowerReauthorization() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory pending =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        bytes memory signature = _sign(pending);

        vm.startPrank(GOVERNANCE);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, false);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, true);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskModeRegistry.CertificateAuthorizationEpochMismatch.selector, 3, 1
            )
        );
        riskRegistry.submitRiskCertificate(pending, bounds, signature);
        assertEq(riskRegistry.lastNonce(POLICY_ID), 0);

        RiskModeRegistry.RiskCertificate memory replacement =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        riskRegistry.submitRiskCertificate(replacement, bounds, _sign(replacement));
        assertTrue(riskRegistry.isRiskActive(POLICY_ID));
        RiskModeRegistry.ActiveRisk memory raw = riskRegistry.rawActiveRisk(POLICY_ID);
        assertEq(raw.watchtowerAuthorizationEpoch, 3);
        assertEq(raw.policyNonce, 1);
    }

    function testPendingCertificateCannotSurvivePolicyMutation() public {
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory pending =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        bytes memory signature = _sign(pending);

        vm.prank(GOVERNANCE);
        policyRegistry.setMaximumTransactionValue(POLICY_ID, 45_000);

        vm.expectRevert(
            abi.encodeWithSelector(RiskModeRegistry.CertificatePolicyNonceMismatch.selector, 2, 1)
        );
        riskRegistry.submitRiskCertificate(pending, bounds, signature);
        assertEq(riskRegistry.lastNonce(POLICY_ID), 0);

        RiskModeRegistry.RiskCertificate memory replacement =
            _certificate(RiskModeRegistry.RiskMode.SHOCK, 20_000, 1, bounds);
        riskRegistry.submitRiskCertificate(replacement, bounds, _sign(replacement));
        assertTrue(riskRegistry.isRiskActive(POLICY_ID));
        RiskModeRegistry.ActiveRisk memory raw = riskRegistry.rawActiveRisk(POLICY_ID);
        assertEq(raw.policyNonce, 2);
        assertEq(raw.watchtowerAuthorizationEpoch, 1);
    }

    function testRejectsCollectivelyImpossibleActiveBounds() public {
        RiskModeRegistry.ActiveAssetBound[] memory tooManyMinimums = _tightBounds();
        tooManyMinimums[1].minimumWeightBps = 3_200;
        tooManyMinimums[2].minimumWeightBps = 1_300;
        RiskModeRegistry.RiskCertificate memory minimumCertificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, tooManyMinimums);
        bytes memory minimumSignature = _sign(minimumCertificate);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskModeRegistry.InvalidActivePortfolioBounds.selector, 10_100, 14_800
            )
        );
        riskRegistry.submitRiskCertificate(minimumCertificate, tooManyMinimums, minimumSignature);

        RiskModeRegistry.ActiveAssetBound[] memory tooManyMaximums = _tightBounds();
        tooManyMaximums[0].maximumWeightBps = 7_000;
        tooManyMaximums[1].maximumWeightBps = 2_000;
        tooManyMaximums[2].maximumWeightBps = 500;
        RiskModeRegistry.RiskCertificate memory maximumCertificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, 37_500, 1, tooManyMaximums);
        bytes memory maximumSignature = _sign(maximumCertificate);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskModeRegistry.InvalidActivePortfolioBounds.selector, 5_600, 9_500
            )
        );
        riskRegistry.submitRiskCertificate(maximumCertificate, tooManyMaximums, maximumSignature);
    }

    function testFuzzRiskMaximumNeverExceedsHardLimit(uint256 proposed) public {
        proposed = bound(proposed, 0, 50_000);
        RiskModeRegistry.ActiveAssetBound[] memory bounds = _tightBounds();
        RiskModeRegistry.RiskCertificate memory certificate =
            _certificate(RiskModeRegistry.RiskMode.CAUTIOUS, proposed, 1, bounds);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(certificate));
        assertLe(riskRegistry.effectiveMaximumTradeValue(POLICY_ID), 50_000);
    }

    function _certificate(
        RiskModeRegistry.RiskMode mode,
        uint256 maximumTradeValue,
        uint256 nonce,
        RiskModeRegistry.ActiveAssetBound[] memory bounds
    ) internal view returns (RiskModeRegistry.RiskCertificate memory) {
        return RiskModeRegistry.RiskCertificate({
            policyId: POLICY_ID,
            riskMode: mode,
            activeBoundsHash: keccak256(abi.encode(bounds)),
            maximumTradeValue: maximumTradeValue,
            sourceDigest: keccak256("graph-observation"),
            reasonCode: keccak256("LIQUIDITY_DECLINE"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours),
            nonce: nonce,
            watchtower: watchtower,
            watchtowerAuthorizationEpoch: riskRegistry.watchtowerAuthorizationEpoch(
                POLICY_ID, watchtower
            ),
            policyNonce: policyRegistry.policyNonce(POLICY_ID)
        });
    }

    function _sign(RiskModeRegistry.RiskCertificate memory certificate)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(WATCHTOWER_KEY, riskRegistry.hashTypedData(certificate));
        return abi.encodePacked(r, s, v);
    }

    function _tightBounds()
        internal
        pure
        returns (RiskModeRegistry.ActiveAssetBound[] memory bounds)
    {
        bounds = new RiskModeRegistry.ActiveAssetBound[](3);
        bounds[0] = RiskModeRegistry.ActiveAssetBound(USDC, 5_600, 10_000, false);
        bounds[1] = RiskModeRegistry.ActiveAssetBound(WETH, 0, 3_400, false);
        bounds[2] = RiskModeRegistry.ActiveAssetBound(LINK, 0, 1_400, false);
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
