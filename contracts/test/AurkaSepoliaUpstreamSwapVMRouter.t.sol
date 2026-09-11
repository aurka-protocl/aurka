// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import {
    AurkaSepoliaSwapVMRouter,
    IAurkaSepoliaTradeMath,
    IAurkaSepoliaUpstreamExecutor
} from "../src/AurkaSepoliaSwapVMRouter.sol";
import { AurkaSepoliaOrderValidator } from "../src/AurkaSepoliaOrderValidator.sol";
import { AurkaSepoliaTradeMath } from "../src/AurkaSepoliaTradeMath.sol";
import {
    AurkaSepoliaUpstreamExecutor,
    IAurkaSepoliaOrderValidatorExecutor
} from "../src/AurkaSepoliaUpstreamExecutor.sol";
import { RiskModeRegistry } from "../src/RiskModeRegistry.sol";
import { IAqua } from "../src/interfaces/IAqua.sol";
import { ISwapVM } from "../src/interfaces/ISwapVM.sol";
import { DirectSettlement } from "../src/libraries/DirectSettlement.sol";
import { OptionSpaceFee } from "../src/libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "../src/libraries/PortfolioBounds.sol";
import { PriceProtection } from "../src/libraries/PriceProtection.sol";
import { TestBase } from "./TestBase.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPriceOracle } from "./mocks/MockPriceOracle.sol";

interface SepoliaArtifactVm {
    function getCode(string calldata artifactPath) external returns (bytes memory);
}

/// @notice Proves that the reduced public-chain router still executes the real
/// pinned Aqua/SwapVM path after the AURKA validation and capacity checks.
contract AurkaSepoliaUpstreamSwapVMRouterTest is TestBase {
    SepoliaArtifactVm internal constant artifactVm =
        SepoliaArtifactVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant UPSTREAM_AQUA_ARTIFACT = "contracts/out-upstream/Aqua.sol/Aqua.json";
    string internal constant UPSTREAM_SWAPVM_ARTIFACT =
        "contracts/out-upstream/AurkaUpstreamAquaSwapVMRouter.sol/AurkaUpstreamAquaSwapVMRouter.json";
    bytes32 internal constant POLICY_ID = keccak256("policy:sepolia-reduced-router");
    bytes32 internal constant POSITION_ID = keccak256("position:sepolia-reduced-router");
    uint256 internal constant TRADER_KEY = 0xA11CE;
    uint256 internal constant SOLVER_KEY = 0xB0B;
    uint256 internal constant MAKER_KEY = 0xC0FFEE;
    uint256 internal constant MAX_TRADE_VALUE = 50_000;

    MockERC20 internal usdc;
    MockERC20 internal weth;
    IAqua internal aqua;
    MockPriceOracle internal oracle;
    AurkaPolicyRegistry internal policyRegistry;
    RiskModeRegistry internal riskRegistry;
    ISwapVM internal swapVM;
    AurkaSepoliaOrderValidator internal orderValidator;
    AurkaSepoliaTradeMath internal tradeMath;
    AurkaSepoliaUpstreamExecutor internal executor;
    AurkaSepoliaSwapVMRouter internal router;
    address internal trader;
    address internal solver;
    address internal maker;
    bytes32 internal strategyHash;
    bytes internal orderData;

    struct TradeCase {
        AurkaSepoliaSwapVMRouter.Intent intent;
        AurkaSepoliaSwapVMRouter.Proposal proposal;
        PortfolioBounds.AssetState[] assets;
        DirectSettlement.CapacityEpoch epoch;
        PriceProtection.SettlementInput priceInput;
        bytes directProgram;
        bytes intentSignature;
        bytes proposalSignature;
        uint256 makerTraits;
        bytes upstreamOrderData;
        bytes takerTraitsAndData;
    }

    function setUp() public {
        vm.warp(1_000);
        trader = vm.addr(TRADER_KEY);
        solver = vm.addr(SOLVER_KEY);
        maker = vm.addr(MAKER_KEY);

        usdc = new MockERC20("USDC", 0);
        weth = new MockERC20("WETH", 0);
        aqua = IAqua(_deployArtifact(UPSTREAM_AQUA_ARTIFACT, bytes("")));
        oracle = new MockPriceOracle();
        policyRegistry = new AurkaPolicyRegistry();
        riskRegistry = new RiskModeRegistry(policyRegistry);
        swapVM = ISwapVM(
            _deployArtifact(
                UPSTREAM_SWAPVM_ARTIFACT, abi.encode(address(aqua), address(weth), address(this))
            )
        );

        AurkaPolicyRegistry.AssetConfig[] memory assets = new AurkaPolicyRegistry.AssetConfig[](2);
        assets[0] = AurkaPolicyRegistry.AssetConfig(address(usdc), 0, 5_500, 10_000);
        assets[1] = AurkaPolicyRegistry.AssetConfig(address(weth), 0, 0, 4_500);
        policyRegistry.createPolicy(
            POLICY_ID,
            maker,
            address(this),
            assets,
            MAX_TRADE_VALUE,
            AurkaPolicyRegistry.FeeConfig({
                baseFeeBps: 20,
                slopeBps: 80,
                maximumFeeBps: 100,
                treasuryBaseFeeBps: 10,
                solverFeeBps: 5,
                protocolFeeBps: 5,
                treasuryFeeRecipient: maker,
                protocolFeeRecipient: address(this)
            })
        );

        orderValidator = new AurkaSepoliaOrderValidator();
        tradeMath = new AurkaSepoliaTradeMath();
        executor = new AurkaSepoliaUpstreamExecutor(
            swapVM,
            aqua,
            policyRegistry,
            IAurkaSepoliaOrderValidatorExecutor(address(orderValidator))
        );
        router = new AurkaSepoliaSwapVMRouter(
            policyRegistry,
            riskRegistry,
            aqua,
            swapVM,
            IAurkaSepoliaTradeMath(address(tradeMath)),
            IAurkaSepoliaUpstreamExecutor(address(executor))
        );
        executor.initializeRouter(address(router));

        _shipPinnedStrategy();
        policyRegistry.setSettlementConfiguration(
            POLICY_ID, POSITION_ID, strategyHash, address(oracle)
        );
        oracle.setPrice(address(usdc), 1, 0, uint64(block.timestamp - 10), bytes32(uint256(2)));
        oracle.setPrice(address(weth), 1, 0, uint64(block.timestamp - 10), bytes32(uint256(1)));
        weth.mint(trader, 1_000_000);
    }

    function testReducedRouterExecutesPinnedAquaSwapVMTransfer() public {
        TradeCase memory c = _buildCase(MAX_TRADE_VALUE, 1);
        _activate(c.epoch, c.priceInput);

        (uint248 usdcBefore,) = aqua.rawBalances(maker, address(swapVM), strategyHash, address(usdc));
        (uint248 wethBefore,) = aqua.rawBalances(maker, address(swapVM), strategyHash, address(weth));
        uint256 traderUsdcBefore = usdc.balanceOf(trader);
        uint256 traderWethBefore = weth.balanceOf(trader);
        uint256 solverUsdcBefore = usdc.balanceOf(solver);
        uint256 protocolUsdcBefore = usdc.balanceOf(address(this));

        vm.prank(trader);
        weth.approve(address(router), c.proposal.traderInputAmount);
        router.executeWithSwapVM(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram,
            c.makerTraits,
            c.upstreamOrderData,
            c.takerTraitsAndData
        );

        (uint248 usdcAfter,) = aqua.rawBalances(maker, address(swapVM), strategyHash, address(usdc));
        (uint248 wethAfter,) = aqua.rawBalances(maker, address(swapVM), strategyHash, address(weth));
        assertEq(usdcAfter, usdcBefore - c.priceInput.traderOutputAmount);
        assertEq(wethAfter, wethBefore + c.priceInput.traderInputAmount);
        assertEq(usdc.balanceOf(trader), traderUsdcBefore + c.proposal.traderOutputAmount);
        assertEq(weth.balanceOf(trader), traderWethBefore - c.proposal.traderInputAmount);
        assertEq(usdc.balanceOf(solver), solverUsdcBefore + c.proposal.solverFeeAmount);
        assertEq(usdc.balanceOf(address(this)), protocolUsdcBefore + c.proposal.protocolFeeAmount);
        assertEq(router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, MAX_TRADE_VALUE);
        assertTrue(router.usedIntentNonces(trader, c.intent.nonce));
        assertTrue(router.usedIntentIds(c.intent.intentId));
    }

    function _shipPinnedStrategy() internal {
        address tokenA = address(usdc) < address(weth) ? address(usdc) : address(weth);
        address tokenB = address(usdc) < address(weth) ? address(weth) : address(usdc);
        uint256 outputBalance = 1_000_001;
        uint256 inputBalance = 1_000_000;
        bytes memory program = abi.encodePacked(
            bytes1(0x90),
            bytes1(0x40),
            uint256(tokenA == address(usdc) ? outputBalance : inputBalance),
            uint256(tokenB == address(usdc) ? outputBalance : inputBalance),
            bytes1(0x53),
            bytes1(0x01),
            bytes1(address(weth) == tokenA ? 0x80 : 0x00)
        );
        orderData = abi.encodePacked(tokenA, tokenB, address(router.swapVMGuard()), program);
        ISwapVM.Order memory order =
            ISwapVM.Order({ maker: maker, traits: _makerTraits(), data: orderData });
        strategyHash = keccak256(abi.encode(order));

        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        amounts[0] = 600_000;
        amounts[1] = 300_000;
        usdc.mint(maker, 1_000_000);
        weth.mint(maker, 1_000_000);
        vm.prank(maker);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(maker);
        weth.approve(address(aqua), type(uint256).max);
        vm.prank(maker);
        aqua.ship(address(swapVM), abi.encode(order), tokens, amounts);
    }

    function _buildCase(uint256 requestedValue, uint256 nonce)
        internal
        returns (TradeCase memory c)
    {
        c.assets = _portfolio();
        c.priceInput = _priceInput(requestedValue, requestedValue);
        bytes32 balanceSnapshot = _balanceSnapshot();
        bytes32 priceSnapshot = router.priceSnapshotHash(c.priceInput);
        c.intent = AurkaSepoliaSwapVMRouter.Intent({
            intentId: keccak256(abi.encode("intent", requestedValue, nonce)),
            policyId: POLICY_ID,
            positionIdHash: POSITION_ID,
            trader: trader,
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            requestedValue: requestedValue,
            minimumTraderOutputValue: 1,
            exactInput: true,
            allowPartialFill: false,
            deadline: block.timestamp + 500,
            nonce: nonce,
            balanceSnapshot: balanceSnapshot,
            priceSnapshot: priceSnapshot,
            aquaStrategyHash: strategyHash
        });
        c.epoch = _epoch(balanceSnapshot, priceSnapshot, 0);
        DirectSettlement.FillResult memory fill = tradeMath.maximumSafeFill(
            c.assets,
            address(weth),
            address(usdc),
            requestedValue,
            MAX_TRADE_VALUE,
            c.epoch.capacityBaseline,
            c.epoch.consumedBefore,
            _feeConfig(),
            c.priceInput,
            c.epoch,
            uint64(block.timestamp)
        );
        c.priceInput.traderInputAmount = fill.maximumSafeFill;
        c.priceInput.traderOutputAmount = fill.treasuryOutputValue;
        fill = tradeMath.maximumSafeFill(
            c.assets,
            address(weth),
            address(usdc),
            requestedValue,
            MAX_TRADE_VALUE,
            c.epoch.capacityBaseline,
            c.epoch.consumedBefore,
            _feeConfig(),
            c.priceInput,
            c.epoch,
            uint64(block.timestamp)
        );

        bytes32 intentHash = router.hashIntent(c.intent);
        c.proposal = _proposal(intentHash, fill, priceSnapshot, c.epoch, c.assets, c.priceInput);
        c.directProgram = _program(c.intent, c.proposal, intentHash);
        c.makerTraits = _makerTraits();
        c.upstreamOrderData = orderData;
        c.takerTraitsAndData = _takerTraits(c.proposal.traderInputValue, c.proposal.deadline);
        c.proposal.swapVMCalldataHash = keccak256(
            abi.encode(c.directProgram, c.makerTraits, c.upstreamOrderData, c.takerTraitsAndData)
        );
        c.intentSignature = _sign(TRADER_KEY, intentHash);
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
    }

    function _proposal(
        bytes32 intentHash,
        DirectSettlement.FillResult memory fill,
        bytes32 priceSnapshot,
        DirectSettlement.CapacityEpoch memory epoch,
        PortfolioBounds.AssetState[] memory assets,
        PriceProtection.SettlementInput memory priceInput
    ) internal view returns (AurkaSepoliaSwapVMRouter.Proposal memory proposal) {
        proposal = AurkaSepoliaSwapVMRouter.Proposal({
            intentHash: intentHash,
            solver: solver,
            balancesHash: _balanceSnapshot(),
            priceSnapshotHash: priceSnapshot,
            policyNonce: policyRegistry.policyNonce(POLICY_ID),
            riskCertificateHash: bytes32(0),
            traderInputToken: priceInput.traderInputToken,
            traderOutputToken: priceInput.traderOutputToken,
            traderInputAmount: priceInput.traderInputAmount,
            traderOutputAmount: priceInput.traderOutputAmount - fill.fees.solverAmount
                - fill.fees.protocolAmount,
            solverFeeAmount: fill.fees.solverAmount,
            protocolFeeAmount: fill.fees.protocolAmount,
            traderInputValue: fill.maximumSafeFill,
            traderOutputValue: fill.traderOutputValue,
            treasuryOutputValue: fill.treasuryOutputValue,
            feeBpsScaled: fill.fees.feeBpsScaled,
            baseFeeAmount: fill.fees.baseFeeAmount,
            treasuryBaseFeeAmount: fill.fees.treasuryBaseFeeAmount,
            optionSpacePremiumAmount: fill.fees.premiumAmount,
            totalFeeAmount: fill.fees.totalFeeAmount,
            treasuryAmount: fill.fees.treasuryAmount,
            solverAmount: fill.fees.solverAmount,
            protocolAmount: fill.fees.protocolAmount,
            feeToken: priceInput.traderOutputToken,
            feePaymentMode: 0,
            initialPortfolioHash: keccak256(abi.encode(assets)),
            capacityBaselineValue: epoch.capacityBaseline,
            consumedBefore: epoch.consumedBefore,
            consumedAfter: epoch.consumedBefore + fill.maximumSafeFill,
            capacityEpochId: epoch.capacityEpochId,
            utilizationBefore: fill.utilizationBefore,
            utilizationAfter: fill.utilizationAfter,
            bindingConstraint: uint8(fill.bindingConstraint),
            bindingAsset: fill.bindingAsset,
            expectedPostStateHash: keccak256(abi.encode(fill.postTrade)),
            aquaStrategyHash: strategyHash,
            swapVMCalldataHash: bytes32(0),
            deadline: block.timestamp + 500
        });
    }

    function _program(
        AurkaSepoliaSwapVMRouter.Intent memory intent,
        AurkaSepoliaSwapVMRouter.Proposal memory proposal,
        bytes32 intentHash
    ) internal pure returns (bytes memory) {
        return abi.encode(
            keccak256("AURKA_DIRECT_PAIR_V1"),
            intent.policyId,
            intent.positionIdHash,
            intent.trader,
            intent.traderInputToken,
            intent.traderOutputToken,
            proposal.aquaStrategyHash,
            proposal.traderInputAmount,
            proposal.traderOutputAmount,
            proposal.solverFeeAmount,
            proposal.protocolFeeAmount,
            proposal.traderInputValue,
            proposal.traderOutputValue,
            proposal.treasuryOutputValue,
            proposal.capacityEpochId,
            intentHash
        );
    }

    function _takerTraits(uint256 threshold, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint16(37),
            uint16(37),
            uint16(37),
            uint16(37),
            uint16(37),
            uint16(37),
            uint16(37),
            uint16(37),
            uint16(32),
            uint16(32),
            uint16(0x0051 | (address(weth) < address(usdc) ? 0x0080 : 0)),
            uint256(threshold),
            uint40(deadline)
        );
    }

    function _activate(
        DirectSettlement.CapacityEpoch memory epoch,
        PriceProtection.SettlementInput memory priceInput
    ) internal {
        router.activateCapacityEpoch(POLICY_ID, epoch, priceInput);
    }

    function _epoch(bytes32 balanceSnapshot, bytes32 priceSnapshot, uint256 consumedBefore)
        internal
        view
        returns (DirectSettlement.CapacityEpoch memory epoch)
    {
        epoch = DirectSettlement.CapacityEpoch({
            positionIdHash: POSITION_ID,
            traderInputTokenId: bytes32(uint256(uint160(address(weth)))),
            traderOutputTokenId: bytes32(uint256(uint160(address(usdc)))),
            balanceSnapshot: balanceSnapshot,
            priceSnapshot: priceSnapshot,
            portfolioPriceSnapshot: router.portfolioPriceSnapshotHash(POLICY_ID, POSITION_ID),
            policyNonce: policyRegistry.policyNonce(POLICY_ID),
            riskCertificateHash: bytes32(0),
            aquaStrategyHash: strategyHash,
            capacityBaseline: MAX_TRADE_VALUE,
            consumedBefore: consumedBefore,
            chainId: block.chainid,
            verifyingContract: address(router),
            capacityEpochId: bytes32(0)
        });
        epoch.capacityEpochId = DirectSettlement.capacityEpochId(epoch);
    }

    function _portfolio() internal view returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](2);
        RiskModeRegistry.ActiveAssetBound memory usdcBound =
            riskRegistry.effectiveAssetBound(POLICY_ID, address(usdc));
        RiskModeRegistry.ActiveAssetBound memory wethBound =
            riskRegistry.effectiveAssetBound(POLICY_ID, address(weth));
        assets[0] = PortfolioBounds.AssetState(
            address(usdc), 600_000, usdcBound.minimumWeightBps, usdcBound.maximumWeightBps
        );
        assets[1] = PortfolioBounds.AssetState(
            address(weth), 300_000, wethBound.minimumWeightBps, wethBound.maximumWeightBps
        );
    }

    function _balanceSnapshot() internal view returns (bytes32) {
        address[] memory tokens = new address[](2);
        uint256[] memory balances = new uint256[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        balances[0] = 600_000;
        balances[1] = 300_000;
        return keccak256(abi.encode(tokens, balances));
    }

    function _priceInput(uint256 inputAmount, uint256 outputAmount)
        internal
        view
        returns (PriceProtection.SettlementInput memory input)
    {
        uint64 observedAt = uint64(block.timestamp - 10);
        input = PriceProtection.SettlementInput({
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            traderInputReferencePrice: PriceProtection.Snapshot(
                address(weth), bytes32(uint256(1)), 1, 0, observedAt
            ),
            traderInputExecutionPrice: PriceProtection.Snapshot(
                address(weth), bytes32(uint256(1)), 1, 0, observedAt
            ),
            traderOutputReferencePrice: PriceProtection.Snapshot(
                address(usdc), bytes32(uint256(2)), 1, 0, observedAt
            ),
            traderOutputExecutionPrice: PriceProtection.Snapshot(
                address(usdc), bytes32(uint256(2)), 1, 0, observedAt
            ),
            approvedTraderInputSnapshotId: bytes32(uint256(1)),
            approvedTraderOutputSnapshotId: bytes32(uint256(2)),
            traderInputAmount: inputAmount,
            traderOutputAmount: outputAmount,
            traderInputDecimals: 0,
            traderOutputDecimals: 0,
            valueDecimals: 0,
            currentTime: uint64(block.timestamp),
            maximumPriceAgeSeconds: 120,
            maximumPriceDeviationBps: 100
        });
    }

    function _feeConfig() internal pure returns (OptionSpaceFee.FeeConfig memory) {
        return OptionSpaceFee.FeeConfig({
            baseFeeBps: 20,
            slopeBps: 80,
            maximumFeeBps: 100,
            treasuryBaseFeeBps: 10,
            solverFeeBps: 5,
            protocolFeeBps: 5
        });
    }

    function _makerTraits() internal pure returns (uint256) {
        return (1 << 254) | (1 << 250) | (1 << 246) | (uint256(60) << 208) | (uint256(60) << 192)
            | (uint256(40) << 176) | (uint256(40) << 160);
    }

    function _sign(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deployArtifact(string memory artifactPath, bytes memory constructorArgs)
        internal
        returns (address deployed)
    {
        bytes memory creationCode = abi.encodePacked(artifactVm.getCode(artifactPath), constructorArgs);
        assembly ("memory-safe") {
            deployed := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        if (deployed == address(0)) revert AssertionFailed("upstream artifact deployment failed");
    }
}
