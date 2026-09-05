// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import { AurkaSwapVMRouter } from "../src/AurkaSwapVMRouter.sol";
import { RiskModeRegistry } from "../src/RiskModeRegistry.sol";
import { DirectSettlement } from "../src/libraries/DirectSettlement.sol";
import { OptionSpaceFee } from "../src/libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "../src/libraries/PortfolioBounds.sol";
import { PriceProtection } from "../src/libraries/PriceProtection.sol";
import { TestBase } from "./TestBase.sol";
import { MockAqua } from "./mocks/MockAqua.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPriceOracle } from "./mocks/MockPriceOracle.sol";
import { AurkaDirectSwapVM } from "../src/AurkaDirectSwapVM.sol";

contract RouterMathHarness {
    function solve(
        PortfolioBounds.AssetState[] memory assets,
        address inputToken,
        address outputToken,
        uint256 requestedValue,
        PriceProtection.SettlementInput memory priceInput,
        DirectSettlement.CapacityEpoch memory epoch
    ) external view returns (DirectSettlement.FillResult memory) {
        return DirectSettlement.maximumSafeFill(
            assets,
            inputToken,
            outputToken,
            requestedValue,
            50_000,
            epoch.capacityBaseline,
            epoch.consumedBefore,
            OptionSpaceFee.FeeConfig({
                baseFeeBps: 20,
                slopeBps: 80,
                maximumFeeBps: 100,
                treasuryBaseFeeBps: 10,
                solverFeeBps: 5,
                protocolFeeBps: 5
            }),
            priceInput,
            epoch,
            uint64(block.timestamp)
        );
    }
}

contract AurkaSwapVMRouterTest is TestBase {
    bytes32 internal constant POLICY_ID = keccak256("policy:router-test");
    bytes32 internal constant POSITION_ID = keccak256("position:router-test");
    bytes32 internal constant STRATEGY = keccak256("strategy:router-test");
    uint256 internal constant TRADER_KEY = 0xA11CE;
    uint256 internal constant SOLVER_KEY = 0xB0B;
    uint256 internal constant WATCHTOWER_KEY = 0xC0FFEE;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant PROTOCOL = address(0xD00D);

    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockERC20 internal link;
    MockAqua internal aqua;
    MockPriceOracle internal priceOracle;
    AurkaDirectSwapVM internal swapVM;
    AurkaPolicyRegistry internal policyRegistry;
    RiskModeRegistry internal riskRegistry;
    AurkaSwapVMRouter internal router;
    RouterMathHarness internal math;
    address internal trader;
    address internal solver;
    address internal watchtower;

    struct TradeCase {
        AurkaSwapVMRouter.Intent intent;
        AurkaSwapVMRouter.Proposal proposal;
        PortfolioBounds.AssetState[] assets;
        DirectSettlement.CapacityEpoch epoch;
        PriceProtection.SettlementInput priceInput;
        bytes directProgram;
        bytes intentSignature;
        bytes proposalSignature;
    }

    event CapacityEpochActivated(
        bytes32 indexed policyId,
        bytes32 indexed positionIdHash,
        address indexed traderInputToken,
        address traderOutputToken,
        bytes32 capacityEpochId,
        uint256 capacityBaselineValue,
        uint256 policyNonce,
        bytes32 riskCertificateHash,
        bytes32 balanceSnapshot,
        bytes32 priceSnapshot,
        bytes32 portfolioPriceSnapshot,
        bytes32 aquaStrategyHash,
        uint256 consumedBefore
    );

    event FeesRouted(
        bytes32 indexed proposalHash,
        address indexed feeToken,
        address indexed solver,
        address protocolRecipient,
        uint256 solverAmount,
        uint256 protocolAmount,
        uint256 treasuryAmount
    );

    event TradeExecuted(
        bytes32 indexed policyId,
        bytes32 indexed positionIdHash,
        bytes32 indexed intentHash,
        bytes32 proposalHash,
        bytes32 capacityEpochId,
        address trader,
        address treasury,
        address traderInputToken,
        address traderOutputToken,
        uint256 traderInputValue,
        uint256 traderOutputValue,
        uint256 treasuryOutputValue,
        uint256 totalFeeAmount,
        uint256 consumedBefore,
        uint256 consumedAfter,
        bytes32 expectedPostStateHash
    );

    function setUp() public {
        vm.warp(1_000);
        trader = vm.addr(TRADER_KEY);
        solver = vm.addr(SOLVER_KEY);
        watchtower = vm.addr(WATCHTOWER_KEY);
        usdc = new MockERC20("USDC", 0);
        weth = new MockERC20("WETH", 0);
        link = new MockERC20("LINK", 0);
        aqua = new MockAqua();
        priceOracle = new MockPriceOracle();
        swapVM = new AurkaDirectSwapVM();
        policyRegistry = new AurkaPolicyRegistry();
        riskRegistry = new RiskModeRegistry(policyRegistry);
        router = new AurkaSwapVMRouter(policyRegistry, riskRegistry, aqua, swapVM);
        math = new RouterMathHarness();

        AurkaPolicyRegistry.AssetConfig[] memory assets = new AurkaPolicyRegistry.AssetConfig[](3);
        assets[0] = AurkaPolicyRegistry.AssetConfig(address(usdc), 0, 5_500, 10_000);
        assets[1] = AurkaPolicyRegistry.AssetConfig(address(weth), 0, 0, 3_500);
        assets[2] = AurkaPolicyRegistry.AssetConfig(address(link), 0, 0, 1_500);
        policyRegistry.createPolicy(
            POLICY_ID,
            TREASURY,
            address(this),
            assets,
            50_000,
            AurkaPolicyRegistry.FeeConfig({
                baseFeeBps: 20,
                slopeBps: 80,
                maximumFeeBps: 100,
                treasuryBaseFeeBps: 10,
                solverFeeBps: 5,
                protocolFeeBps: 5,
                treasuryFeeRecipient: TREASURY,
                protocolFeeRecipient: PROTOCOL
            })
        );
        policyRegistry.setSettlementConfiguration(
            POLICY_ID, POSITION_ID, STRATEGY, address(priceOracle)
        );

        priceOracle.setPrice(address(usdc), 1, 0, uint64(block.timestamp - 10), bytes32(uint256(2)));
        priceOracle.setPrice(address(weth), 1, 0, uint64(block.timestamp - 10), bytes32(uint256(1)));
        priceOracle.setPrice(address(link), 1, 0, uint64(block.timestamp - 10), bytes32(uint256(3)));

        usdc.mint(TREASURY, 1_000_000);
        weth.mint(trader, 1_000_000);
        vm.prank(TREASURY);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(TREASURY);
        weth.approve(address(aqua), type(uint256).max);
        aqua.seed(TREASURY, address(router), STRATEGY, address(usdc), 600_000);
        aqua.seed(TREASURY, address(router), STRATEGY, address(weth), 300_000);
        aqua.seed(TREASURY, address(router), STRATEGY, address(link), 100_000);
    }

    function testCanonicalRequestSettlesEveryBalanceAndFee() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 50_000);

        uint256 traderUsdcBefore = usdc.balanceOf(trader);
        uint256 traderWethBefore = weth.balanceOf(trader);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );

        assertEq(executed, 50_000);
        assertEq(usdc.balanceOf(trader) - traderUsdcBefore, 49_766);
        assertEq(traderWethBefore - weth.balanceOf(trader), 50_000);
        assertEq(usdc.balanceOf(solver), 25);
        assertEq(usdc.balanceOf(PROTOCOL), 25);
        (uint248 usdcBalance,) =
            aqua.rawBalances(TREASURY, address(router), STRATEGY, address(usdc));
        (uint248 wethBalance,) =
            aqua.rawBalances(TREASURY, address(router), STRATEGY, address(weth));
        assertEq(usdcBalance, 550_184);
        assertEq(wethBalance, 350_000);
        AurkaSwapVMRouter.CapacityState memory state =
            router.capacityState(POSITION_ID, address(weth), address(usdc));
        assertEq(state.consumedValue, 50_000);
    }

    function testSuccessfulSettlementEventsMatchFullAccounting() public {
        TradeCase memory c = _buildCase(50_000, false);
        _activate(c.epoch, c.priceInput);
        bytes32 proposalHash = router.hashProposal(c.proposal);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);

        vm.expectEmit(true, true, true, true);
        emit FeesRouted(
            proposalHash,
            c.proposal.feeToken,
            c.proposal.solver,
            PROTOCOL,
            c.proposal.solverAmount,
            c.proposal.protocolAmount,
            c.proposal.treasuryAmount
        );
        vm.expectEmit(true, true, true, true);
        emit TradeExecuted(
            c.intent.policyId,
            c.intent.positionIdHash,
            router.hashIntent(c.intent),
            proposalHash,
            c.epoch.capacityEpochId,
            c.intent.trader,
            TREASURY,
            c.intent.traderInputToken,
            c.intent.traderOutputToken,
            c.proposal.traderInputValue,
            c.proposal.traderOutputValue,
            c.proposal.treasuryOutputValue,
            c.proposal.totalFeeAmount,
            c.proposal.consumedBefore,
            c.proposal.consumedAfter,
            c.proposal.expectedPostStateHash
        );

        _execute(c);
    }

    function testFuzzRouterFillRespectsCapacity(uint256 requestedValue) public {
        requestedValue = bound(requestedValue, 1_000, 200_000);
        TradeCase memory c = _buildCase(requestedValue, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(executed, c.proposal.traderInputValue);
        assertLe(executed, c.epoch.capacityBaseline);
        assertEq(
            router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, executed
        );
    }

    function testBoundaryMinusOneSettlesThroughTheRouter() public {
        TradeCase memory c = _buildCase(49_999, false);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 49_999);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(executed, 49_999);
        assertEq(
            router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 49_999
        );
    }

    function testBoundaryExactSettlesThroughTheRouter() public {
        TradeCase memory c = _buildCase(50_000, false);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(executed, 50_000);
        assertEq(
            router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 50_000
        );
    }

    function testBoundaryPlusOneClampsWhenPartialIsAllowed() public {
        TradeCase memory c = _buildCase(50_001, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(executed, 50_000);
    }

    function testBoundaryPlusOneRevertsWhenPartialIsDisallowed() public {
        TradeCase memory c = _buildCase(50_001, false);
        _activate(c.epoch, c.priceInput);
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaSwapVMRouter.ExactInputNotSatisfied.selector, uint256(50_001), uint256(50_000)
            )
        );
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertFalse(router.usedIntentIds(c.intent.intentId));
    }

    function testCapacityEventMatchesTheSharedProjectionABI() public {
        TradeCase memory c = _buildCase(200_000, true);
        vm.expectEmit(true, true, true, true);
        emit CapacityEpochActivated(
            POLICY_ID,
            POSITION_ID,
            address(weth),
            address(usdc),
            c.epoch.capacityEpochId,
            c.epoch.capacityBaseline,
            c.epoch.policyNonce,
            c.epoch.riskCertificateHash,
            c.epoch.balanceSnapshot,
            c.epoch.priceSnapshot,
            c.epoch.portfolioPriceSnapshot,
            c.epoch.aquaStrategyHash,
            c.epoch.consumedBefore
        );
        _activate(c.epoch, c.priceInput);
    }

    function testSixtyTwoThousandRequestIsClampedOnlyWhenIntentAllowsPartial() public {
        TradeCase memory c = _buildCase(62_000, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 50_000);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(executed, 50_000);
    }

    function testSixtyTwoThousandRequestRevertsWhenPartialNotAllowed() public {
        TradeCase memory c = _buildCase(62_000, false);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 50_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaSwapVMRouter.ExactInputNotSatisfied.selector, uint256(62_000), uint256(50_000)
            )
        );
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertFalse(router.usedIntentIds(c.intent.intentId));
    }

    function testReplayRevertsWithoutChangingCapacity() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 50_000);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        vm.expectRevert(AurkaSwapVMRouter.IntentAlreadyUsed.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(
            router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 50_000
        );
    }

    function testSplitFillsKeepTheEpochAndAdvanceTheStoredBalanceCheckpoint() public {
        TradeCase memory first = _buildCase(25_000, true);
        _activate(first.epoch, first.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 50_000);
        router.execute(
            first.intent,
            first.intentSignature,
            first.proposal,
            first.proposalSignature,
            first.assets,
            first.epoch,
            first.priceInput,
            first.directProgram
        );

        DirectSettlement.FillResult memory firstFill = math.solve(
            first.assets, address(weth), address(usdc), 25_000, first.priceInput, first.epoch
        );
        TradeCase memory second;
        second.assets = firstFill.postTrade;
        second.priceInput = first.priceInput;
        second.priceInput.traderInputAmount = 25_000;
        second.priceInput.traderOutputAmount = 25_000;
        second.epoch = first.epoch;
        second.epoch.consumedBefore = 25_000;
        DirectSettlement.FillResult memory secondFill = math.solve(
            second.assets, address(weth), address(usdc), 25_000, second.priceInput, second.epoch
        );
        second.priceInput.traderOutputAmount = secondFill.treasuryOutputValue;
        second.intent = first.intent;
        second.intent.intentId = keccak256("intent:second-split");
        second.intent.nonce = first.intent.nonce + 1;
        bytes32 secondIntentHash = router.hashIntent(second.intent);
        second.proposal = _proposal(
            secondIntentHash,
            secondFill,
            first.intent.priceSnapshot,
            second.epoch,
            second.assets,
            second.priceInput
        );
        second.directProgram = _program(second.intent, second.proposal, secondIntentHash);
        second.proposal.swapVMCalldataHash = keccak256(second.directProgram);
        second.directProgram = _program(second.intent, second.proposal, secondIntentHash);
        second.proposal.swapVMCalldataHash = keccak256(second.directProgram);
        second.intentSignature = _sign(TRADER_KEY, secondIntentHash);
        second.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(second.proposal));
        router.execute(
            second.intent,
            second.intentSignature,
            second.proposal,
            second.proposalSignature,
            second.assets,
            second.epoch,
            second.priceInput,
            second.directProgram
        );

        assertEq(
            router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 50_000
        );
        (uint248 usdcBalance,) =
            aqua.rawBalances(TREASURY, address(router), STRATEGY, address(usdc));
        (uint248 wethBalance,) =
            aqua.rawBalances(TREASURY, address(router), STRATEGY, address(weth));
        assertGe(usdcBalance, 550_184);
        assertLe(usdcBalance, 550_186);
        assertEq(wethBalance, 350_000);
        assertEq(first.proposal.totalFeeAmount + second.proposal.totalFeeAmount, 234);
    }

    function testTamperedProgramRevertsAtomically() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 50_000);
        c.directProgram[0] = bytes1(uint8(c.directProgram[0]) ^ 1);
        vm.expectRevert(AurkaSwapVMRouter.DirectProgramMismatch.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(weth.balanceOf(trader), 1_000_000);
        assertEq(router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 0);
    }

    function testReverseTradeUsesAnIndependentDirectionalEpoch() public {
        usdc.mint(trader, 100_000);
        weth.mint(TREASURY, 1_000_000);
        vm.prank(TREASURY);
        weth.approve(address(aqua), type(uint256).max);

        TradeCase memory c;
        c.assets = _portfolio();
        c.priceInput = _priceInputPair(address(usdc), address(weth), 50_000, 49_816);
        bytes32 balanceSnapshot = _balanceSnapshot();
        bytes32 priceSnapshot = router.priceSnapshotHash(c.priceInput);
        c.intent = AurkaSwapVMRouter.Intent({
            intentId: keccak256("intent:reverse"),
            policyId: POLICY_ID,
            positionIdHash: POSITION_ID,
            trader: trader,
            traderInputToken: address(usdc),
            traderOutputToken: address(weth),
            requestedValue: 50_000,
            minimumTraderOutputValue: 1,
            exactInput: true,
            allowPartialFill: false,
            deadline: block.timestamp + 500,
            nonce: 9001,
            balanceSnapshot: balanceSnapshot,
            priceSnapshot: priceSnapshot,
            aquaStrategyHash: STRATEGY
        });
        c.epoch = _epochFor(address(usdc), address(weth), balanceSnapshot, priceSnapshot, 0);
        DirectSettlement.FillResult memory fill =
            math.solve(c.assets, address(usdc), address(weth), 50_000, c.priceInput, c.epoch);
        bytes32 intentHash = router.hashIntent(c.intent);
        c.proposal = _proposal(intentHash, fill, priceSnapshot, c.epoch, c.assets, c.priceInput);
        c.directProgram = _program(c.intent, c.proposal, intentHash);
        c.proposal.swapVMCalldataHash = keccak256(c.directProgram);
        c.intentSignature = _sign(TRADER_KEY, intentHash);
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        usdc.approve(address(router), 50_000);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );

        assertEq(
            router.capacityState(POSITION_ID, address(usdc), address(weth)).consumedValue, 50_000
        );
        assertEq(router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 0);
    }

    function testPolicyChangeRejectsOldSignedEpoch() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        policyRegistry.setMaximumTransactionValue(POLICY_ID, 40_000);
        vm.prank(trader);
        weth.approve(address(router), 50_000);
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertFalse(router.usedIntentIds(c.intent.intentId));
    }

    function testStalePriceIsRejectedBeforeAnyTransfer() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.traderInputReferencePrice.observedAt = 1;
        c.priceInput.traderInputExecutionPrice.observedAt = 1;
        c.priceInput.traderOutputReferencePrice.observedAt = 1;
        c.priceInput.traderOutputExecutionPrice.observedAt = 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceIsStale.selector, uint64(1), uint64(1_000), uint64(120)
            )
        );
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertEq(weth.balanceOf(trader), 1_000_000);
    }

    function testCallerClockCannotMakeAnOldOracleSnapshotFresh() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        // The oracle snapshot was observed at block 990. The caller attempts
        // to replay it with a matching historical clock after it is stale.
        c.priceInput.currentTime = 990;
        vm.warp(1_120);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceIsStale.selector, uint64(990), uint64(1_120), uint64(120)
            )
        );
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function testSolverSuppliedPortfolioValuesAreNotAuthoritative() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.assets[0].value = 1;
        vm.expectRevert(AurkaSwapVMRouter.InitialPortfolioMismatch.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function testUntradedOracleChangeInvalidatesThePriceEpoch() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        priceOracle.setPrice(address(link), 2, 0, uint64(block.timestamp - 10), bytes32(uint256(3)));
        vm.expectRevert(AurkaSwapVMRouter.PortfolioPriceSnapshotMismatch.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function testCallerCannotRelaxTheGovernancePriceProtectionLimits() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.maximumPriceAgeSeconds = 121;
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function testAquaDepositOrWithdrawalInvalidatesTheBalanceEpoch() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        aqua.seed(TREASURY, address(router), STRATEGY, address(usdc), 600_001);
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function testCapacityBaselineMustMatchTheAuthoritativeSafeFill() public {
        TradeCase memory c = _buildCase(200_000, true);
        c.epoch.capacityBaseline = 49_999;
        c.epoch.capacityEpochId = DirectSettlement.capacityEpochId(c.epoch);
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaSwapVMRouter.CapacityBaselineMismatch.selector,
                uint256(50_000),
                uint256(49_999)
            )
        );
        _activate(c.epoch, c.priceInput);
    }

    function testConsumedEpochCannotBeReactivatedToResetUtilization() public {
        TradeCase memory c = _buildCase(25_000, true);
        _activate(c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), 25_000);
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        // The post-trade authoritative portfolio derives a different safe
        // baseline; the old claimed baseline cannot reset the epoch.
        vm.expectRevert();
        _activate(c.epoch, c.priceInput);
    }

    function testExcessiveExecutionPriceDeviationIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.traderOutputExecutionPrice.price = 2;
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceDeviationTooHigh.selector, uint256(1), uint256(2)
            )
        );
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        assertFalse(router.usedIntentIds(c.intent.intentId));
    }

    function testEIP712DomainBindsTheRouterContract() public {
        TradeCase memory c = _buildCase(200_000, true);
        AurkaSwapVMRouter other = new AurkaSwapVMRouter(policyRegistry, riskRegistry, aqua, swapVM);
        vm.expectRevert(AurkaSwapVMRouter.InvalidSignature.selector);
        other.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function testInvalidTraderSignatureIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        c.intentSignature[0] = bytes1(uint8(c.intentSignature[0]) ^ 1);
        vm.expectRevert(AurkaSwapVMRouter.InvalidSignature.selector);
        _execute(c);
    }

    function testInvalidSolverSignatureIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        c.proposalSignature[0] = bytes1(uint8(c.proposalSignature[0]) ^ 1);
        vm.expectRevert(AurkaSwapVMRouter.InvalidSignature.selector);
        _execute(c);
    }

    function testExpiredIntentIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        c.intent.deadline = block.timestamp - 1;
        vm.expectRevert(
            abi.encodeWithSelector(AurkaSwapVMRouter.IntentExpired.selector, c.intent.deadline)
        );
        _execute(c);
    }

    function testExpiredProposalIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        c.proposal.deadline = block.timestamp - 1;
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
        vm.expectRevert(
            abi.encodeWithSelector(AurkaSwapVMRouter.ProposalExpired.selector, c.proposal.deadline)
        );
        _execute(c);
    }

    function testCrossChainDomainRejectsSignedObjects() public {
        TradeCase memory c = _buildCase(200_000, true);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(AurkaSwapVMRouter.InvalidSignature.selector);
        _execute(c);
    }

    function testRiskActivationBetweenEpochAndExecutionIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        _activateRisk(20_000, 1);
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testRiskExpiryBetweenEpochAndExecutionIsRejected() public {
        _activateRisk(20_000, 1);
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        RiskModeRegistry.ActiveRisk memory risk = riskRegistry.rawActiveRisk(POLICY_ID);
        vm.warp(risk.expiresAt + 1);
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testRiskRevocationBetweenEpochAndExecutionIsRejected() public {
        _activateRisk(20_000, 1);
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        riskRegistry.setWatchtower(POLICY_ID, watchtower, false);
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testRiskReplacementBetweenEpochAndExecutionIsRejected() public {
        _activateRisk(20_000, 1);
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        _activateRisk(15_000, 2);
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testRiskHashMismatchIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.proposal.riskCertificateHash = bytes32(uint256(1));
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testBalanceHashMismatchIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.proposal.balancesHash = bytes32(uint256(1));
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testPriceHashMismatchIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.proposal.priceSnapshotHash = bytes32(uint256(1));
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
        vm.expectRevert(AurkaSwapVMRouter.PolicyStateMismatch.selector);
        _execute(c);
    }

    function testCommittedPostStateHashMismatchIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.proposal.expectedPostStateHash = bytes32(uint256(1));
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
        vm.expectRevert(AurkaSwapVMRouter.ProposalMismatch.selector);
        _execute(c);
    }

    function testFutureOracleExecutionPriceIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.traderInputReferencePrice.observedAt = uint64(block.timestamp + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceFromFuture.selector,
                uint64(block.timestamp + 1),
                uint64(block.timestamp)
            )
        );
        _execute(c);
    }

    function testZeroOracleExecutionPriceIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.traderOutputExecutionPrice.price = 0;
        vm.expectRevert(PriceProtection.PriceIsZero.selector);
        _execute(c);
    }

    function testUnapprovedOracleSnapshotIsRejected() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.approvedTraderOutputSnapshotId = bytes32(uint256(99));
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.PriceSnapshotNotApproved.selector,
                bytes32(uint256(99)),
                bytes32(uint256(2))
            )
        );
        _execute(c);
    }

    function testMinimumTreasuryExchangeValueIsEnforcedThroughTheRouter() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        c.priceInput.traderInputAmount = 49_000;
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceProtection.TreasuryExchangeValueTooLow.selector,
                uint256(49_000),
                uint256(49_318)
            )
        );
        _execute(c);
    }

    function testUnsupportedInputTokenIsRejectedAtTheRouterBoundary() public {
        TradeCase memory c = _buildCase(200_000, true);
        address unsupported = address(0xBAD);
        c.epoch.traderInputTokenId = bytes32(uint256(uint160(unsupported)));
        c.epoch.capacityEpochId = DirectSettlement.capacityEpochId(c.epoch);
        c.priceInput.traderInputToken = unsupported;
        c.priceInput.traderInputReferencePrice.token = unsupported;
        c.priceInput.traderInputExecutionPrice.token = unsupported;
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaPolicyRegistry.UnsupportedAsset.selector, POLICY_ID, unsupported
            )
        );
        _activate(c.epoch, c.priceInput);
    }

    function testFalseReturningTokenTransferIsRejectedAtomically() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        weth.setTransferFromReturnsFalse(true);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        vm.expectRevert(
            abi.encodeWithSelector(AurkaSwapVMRouter.TokenTransferFailed.selector, address(weth))
        );
        _execute(c);
        assertEq(weth.balanceOf(trader), 1_000_000);
        assertEq(router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue, 0);
    }

    function testRevertingTokenTransferIsRejectedAtomically() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        weth.setTransferFromReverts(true);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        vm.expectRevert();
        _execute(c);
        assertEq(weth.balanceOf(trader), 1_000_000);
    }

    function testFeeOnTransferTokenIsRejectedAtomically() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        weth.setTransferFeeBps(1);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        vm.expectRevert(
            abi.encodeWithSelector(
                AurkaSwapVMRouter.TokenBalanceMismatch.selector,
                address(weth),
                c.priceInput.traderInputAmount,
                c.priceInput.traderInputAmount - 5
            )
        );
        _execute(c);
    }

    function testMaliciousTokenCallbackIsBlocked() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        bytes memory callback = abi.encodeWithSelector(
            router.execute.selector,
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        weth.configureCallback(address(router), callback);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        _execute(c);
        assertTrue(weth.callbackAttempted());
        assertTrue(weth.callbackBlocked());
    }

    function testMaliciousAquaCallbackIsBlocked() public {
        TradeCase memory c = _buildCase(200_000, true);
        _activate(c.epoch, c.priceInput);
        bytes memory callback = abi.encodeWithSelector(
            router.execute.selector,
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
        aqua.configureCallback(address(router), callback);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);
        _execute(c);
        assertTrue(aqua.callbackAttempted());
        assertTrue(aqua.callbackBlocked());
    }

    function _execute(TradeCase memory c) internal {
        router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );
    }

    function _activateRisk(uint256 maximumTradeValue, uint256 nonce) internal {
        if (!riskRegistry.isWatchtower(POLICY_ID, watchtower)) {
            riskRegistry.setWatchtower(POLICY_ID, watchtower, true);
        }
        RiskModeRegistry.ActiveAssetBound[] memory bounds =
            new RiskModeRegistry.ActiveAssetBound[](3);
        bounds[0] = RiskModeRegistry.ActiveAssetBound(address(usdc), 5_500, 10_000, false);
        bounds[1] = RiskModeRegistry.ActiveAssetBound(address(weth), 0, 3_500, false);
        bounds[2] = RiskModeRegistry.ActiveAssetBound(address(link), 0, 1_500, false);
        RiskModeRegistry.RiskCertificate memory certificate = RiskModeRegistry.RiskCertificate({
            policyId: POLICY_ID,
            riskMode: RiskModeRegistry.RiskMode.CAUTIOUS,
            activeBoundsHash: keccak256(abi.encode(bounds)),
            maximumTradeValue: maximumTradeValue,
            sourceDigest: keccak256(abi.encode("source", nonce)),
            reasonCode: keccak256(abi.encode("reason", nonce)),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 100),
            nonce: nonce,
            watchtower: watchtower,
            watchtowerAuthorizationEpoch: riskRegistry.watchtowerAuthorizationEpoch(
                POLICY_ID, watchtower
            ),
            policyNonce: policyRegistry.policyNonce(POLICY_ID)
        });
        bytes32 digest = riskRegistry.hashTypedData(certificate);
        riskRegistry.submitRiskCertificate(certificate, bounds, _sign(WATCHTOWER_KEY, digest));
    }

    function _buildCase(uint256 requestedValue, bool allowPartial)
        internal
        returns (TradeCase memory c)
    {
        c.assets = _portfolio();
        uint256 maximumTradeValue = riskRegistry.effectiveMaximumTradeValue(POLICY_ID);
        uint256 provisionalInput =
            requestedValue < maximumTradeValue ? requestedValue : maximumTradeValue;
        c.priceInput = _priceInputFor(provisionalInput, provisionalInput);
        bytes32 balanceSnapshot = _balanceSnapshot();
        bytes32 priceSnapshot = router.priceSnapshotHash(c.priceInput);
        c.intent = AurkaSwapVMRouter.Intent({
            intentId: keccak256(abi.encode("intent", requestedValue, allowPartial)),
            policyId: POLICY_ID,
            positionIdHash: POSITION_ID,
            trader: trader,
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            requestedValue: requestedValue,
            minimumTraderOutputValue: 1,
            exactInput: false,
            allowPartialFill: allowPartial,
            deadline: block.timestamp + 500,
            nonce: requestedValue + (allowPartial ? 1 : 2),
            balanceSnapshot: balanceSnapshot,
            priceSnapshot: priceSnapshot,
            aquaStrategyHash: STRATEGY
        });
        c.epoch = _epoch(balanceSnapshot, priceSnapshot, 0);
        DirectSettlement.FillResult memory fill = math.solve(
            c.assets, address(weth), address(usdc), requestedValue, c.priceInput, c.epoch
        );
        c.priceInput.traderInputAmount = fill.maximumSafeFill;
        c.priceInput.traderOutputAmount = fill.treasuryOutputValue;
        priceSnapshot = router.priceSnapshotHash(c.priceInput);
        c.intent.priceSnapshot = priceSnapshot;
        c.epoch = _epoch(balanceSnapshot, priceSnapshot, 0);
        fill = math.solve(
            c.assets, address(weth), address(usdc), requestedValue, c.priceInput, c.epoch
        );
        bytes32 intentHash = router.hashIntent(c.intent);
        c.proposal = _proposal(intentHash, fill, priceSnapshot, c.epoch, c.assets, c.priceInput);
        c.directProgram = _program(c.intent, c.proposal, intentHash);
        c.proposal.swapVMCalldataHash = keccak256(c.directProgram);
        c.directProgram = _program(c.intent, c.proposal, intentHash);
        c.proposal.swapVMCalldataHash = keccak256(c.directProgram);
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
    ) internal view returns (AurkaSwapVMRouter.Proposal memory proposal) {
        proposal = AurkaSwapVMRouter.Proposal({
            intentHash: intentHash,
            solver: solver,
            balancesHash: _balanceSnapshot(),
            priceSnapshotHash: priceSnapshot,
            policyNonce: policyRegistry.policyNonce(POLICY_ID),
            riskCertificateHash: _currentRiskHash(),
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
            aquaStrategyHash: STRATEGY,
            swapVMCalldataHash: bytes32(0),
            deadline: block.timestamp + 500
        });
    }

    function _program(
        AurkaSwapVMRouter.Intent memory intent,
        AurkaSwapVMRouter.Proposal memory proposal,
        bytes32 intentHash
    ) internal view returns (bytes memory) {
        return abi.encode(
            router.DIRECT_PROGRAM_ID(),
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

    function _activate(
        DirectSettlement.CapacityEpoch memory epoch,
        PriceProtection.SettlementInput memory priceInput
    ) internal {
        router.activateCapacityEpoch(POLICY_ID, epoch, priceInput);
    }

    function _sign(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _balanceSnapshot() internal view returns (bytes32) {
        address[] memory tokens = new address[](3);
        uint256[] memory balances = new uint256[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        tokens[2] = address(link);
        balances[0] = 600_000;
        balances[1] = 300_000;
        balances[2] = 100_000;
        return keccak256(abi.encode(tokens, balances));
    }

    function _portfolio() internal view returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](3);
        RiskModeRegistry.ActiveAssetBound memory usdcBound =
            riskRegistry.effectiveAssetBound(POLICY_ID, address(usdc));
        RiskModeRegistry.ActiveAssetBound memory wethBound =
            riskRegistry.effectiveAssetBound(POLICY_ID, address(weth));
        RiskModeRegistry.ActiveAssetBound memory linkBound =
            riskRegistry.effectiveAssetBound(POLICY_ID, address(link));
        assets[0] = PortfolioBounds.AssetState(
            address(usdc), 600_000, usdcBound.minimumWeightBps, usdcBound.maximumWeightBps
        );
        assets[1] = PortfolioBounds.AssetState(
            address(weth), 300_000, wethBound.minimumWeightBps, wethBound.maximumWeightBps
        );
        assets[2] = PortfolioBounds.AssetState(
            address(link), 100_000, linkBound.minimumWeightBps, linkBound.maximumWeightBps
        );
    }

    function _priceInputPair(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount
    ) internal view returns (PriceProtection.SettlementInput memory input) {
        uint64 observedAt = uint64(block.timestamp - 10);
        bytes32 inputSnapshotId =
            inputToken == address(usdc) ? bytes32(uint256(2)) : bytes32(uint256(1));
        bytes32 outputSnapshotId =
            outputToken == address(usdc) ? bytes32(uint256(2)) : bytes32(uint256(1));
        input = PriceProtection.SettlementInput({
            traderInputToken: inputToken,
            traderOutputToken: outputToken,
            traderInputReferencePrice: PriceProtection.Snapshot(
                inputToken, inputSnapshotId, 1, 0, observedAt
            ),
            traderInputExecutionPrice: PriceProtection.Snapshot(
                inputToken, inputSnapshotId, 1, 0, observedAt
            ),
            traderOutputReferencePrice: PriceProtection.Snapshot(
                outputToken, outputSnapshotId, 1, 0, observedAt
            ),
            traderOutputExecutionPrice: PriceProtection.Snapshot(
                outputToken, outputSnapshotId, 1, 0, observedAt
            ),
            approvedTraderInputSnapshotId: inputSnapshotId,
            approvedTraderOutputSnapshotId: outputSnapshotId,
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

    function _priceInputFor(uint256 inputAmount, uint256 outputAmount)
        internal
        view
        returns (PriceProtection.SettlementInput memory input)
    {
        return _priceInputPair(address(weth), address(usdc), inputAmount, outputAmount);
    }

    function _epoch(bytes32 balanceSnapshot, bytes32 priceSnapshot, uint256 consumedBefore)
        internal
        view
        returns (DirectSettlement.CapacityEpoch memory epoch)
    {
        return
            _epochFor(address(weth), address(usdc), balanceSnapshot, priceSnapshot, consumedBefore);
    }

    function _epochFor(
        address inputToken,
        address outputToken,
        bytes32 balanceSnapshot,
        bytes32 priceSnapshot,
        uint256 consumedBefore
    ) internal view returns (DirectSettlement.CapacityEpoch memory epoch) {
        epoch = DirectSettlement.CapacityEpoch({
            positionIdHash: POSITION_ID,
            traderInputTokenId: bytes32(uint256(uint160(inputToken))),
            traderOutputTokenId: bytes32(uint256(uint160(outputToken))),
            balanceSnapshot: balanceSnapshot,
            priceSnapshot: priceSnapshot,
            portfolioPriceSnapshot: router.portfolioPriceSnapshotHash(POLICY_ID, POSITION_ID),
            policyNonce: policyRegistry.policyNonce(POLICY_ID),
            riskCertificateHash: _currentRiskHash(),
            aquaStrategyHash: STRATEGY,
            capacityBaseline: riskRegistry.effectiveMaximumTradeValue(POLICY_ID),
            consumedBefore: consumedBefore,
            chainId: block.chainid,
            verifyingContract: address(router),
            capacityEpochId: bytes32(0)
        });
        epoch.capacityEpochId = DirectSettlement.capacityEpochId(epoch);
    }

    function _currentRiskHash() internal view returns (bytes32) {
        if (!riskRegistry.isRiskActive(POLICY_ID)) return bytes32(0);
        return riskRegistry.rawActiveRisk(POLICY_ID).certificateHash;
    }
}

contract AurkaSwapVMRouterDecimalAuthorityTest is TestBase {
    bytes32 internal constant POLICY_ID = keccak256("policy:decimal-test");
    bytes32 internal constant POSITION_ID = keccak256("position:decimal-test");
    bytes32 internal constant STRATEGY = keccak256("strategy:decimal-test");
    address internal constant TREASURY = address(0xDADA);
    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);

    MockAqua internal aqua;
    MockPriceOracle internal oracle;
    AurkaDirectSwapVM internal swapVM;
    AurkaPolicyRegistry internal policyRegistry;
    RiskModeRegistry internal riskRegistry;
    AurkaSwapVMRouter internal router;

    function setUp() public {
        vm.warp(1_000);
        aqua = new MockAqua();
        oracle = new MockPriceOracle();
        swapVM = new AurkaDirectSwapVM();
        policyRegistry = new AurkaPolicyRegistry();
        riskRegistry = new RiskModeRegistry(policyRegistry);
        router = new AurkaSwapVMRouter(policyRegistry, riskRegistry, aqua, swapVM);

        AurkaPolicyRegistry.AssetConfig[] memory assets = new AurkaPolicyRegistry.AssetConfig[](2);
        assets[0] = AurkaPolicyRegistry.AssetConfig(USDC, 6, 5_500, 10_000);
        assets[1] = AurkaPolicyRegistry.AssetConfig(WETH, 18, 0, 10_000);
        policyRegistry.createPolicy(
            POLICY_ID,
            TREASURY,
            address(this),
            assets,
            50_000,
            AurkaPolicyRegistry.FeeConfig({
                baseFeeBps: 20,
                slopeBps: 80,
                maximumFeeBps: 100,
                treasuryBaseFeeBps: 10,
                solverFeeBps: 5,
                protocolFeeBps: 5,
                treasuryFeeRecipient: TREASURY,
                protocolFeeRecipient: TREASURY
            })
        );
        policyRegistry.setSettlementConfiguration(POLICY_ID, POSITION_ID, STRATEGY, address(oracle));
        oracle.setPrice(USDC, 1_000_000, 6, 990, bytes32(uint256(1)));
        oracle.setPrice(WETH, 1e18, 18, 990, bytes32(uint256(2)));
        aqua.seed(TREASURY, address(router), STRATEGY, USDC, 600_000 * 1e6);
        aqua.seed(TREASURY, address(router), STRATEGY, WETH, 300_000 * 1e18);
    }

    function testAlteredDecimalScalesRevertBeforeEpochActivation() public {
        DirectSettlement.CapacityEpoch memory epoch = _epoch();
        PriceProtection.SettlementInput memory input = _priceInput();

        input.traderInputDecimals = 0;
        vm.expectRevert(bytes4(keccak256("SettlementDecimalMismatch()")));
        router.activateCapacityEpoch(POLICY_ID, epoch, input);
        _assertNoCapacity();

        input = _priceInput();
        input.traderOutputDecimals = 0;
        vm.expectRevert(bytes4(keccak256("SettlementDecimalMismatch()")));
        router.activateCapacityEpoch(POLICY_ID, epoch, input);
        _assertNoCapacity();

        input = _priceInput();
        input.valueDecimals = 6;
        vm.expectRevert(bytes4(keccak256("SettlementDecimalMismatch()")));
        router.activateCapacityEpoch(POLICY_ID, epoch, input);
        _assertNoCapacity();
    }

    function _assertNoCapacity() internal view {
        AurkaSwapVMRouter.CapacityState memory state = router.capacityState(POSITION_ID, WETH, USDC);
        assertEq(state.capacityEpochId, bytes32(0));
        assertEq(state.capacityBaselineValue, 0);
        assertEq(state.consumedValue, 0);
    }

    function _priceInput() internal pure returns (PriceProtection.SettlementInput memory input) {
        input = PriceProtection.SettlementInput({
            traderInputToken: WETH,
            traderOutputToken: USDC,
            traderInputReferencePrice: PriceProtection.Snapshot(
                WETH, bytes32(uint256(2)), 1e18, 18, 990
            ),
            traderInputExecutionPrice: PriceProtection.Snapshot(
                WETH, bytes32(uint256(2)), 1e18, 18, 990
            ),
            traderOutputReferencePrice: PriceProtection.Snapshot(USDC, bytes32(uint256(1)), 1e6, 6, 990),
            traderOutputExecutionPrice: PriceProtection.Snapshot(USDC, bytes32(uint256(1)), 1e6, 6, 990),
            approvedTraderInputSnapshotId: bytes32(uint256(2)),
            approvedTraderOutputSnapshotId: bytes32(uint256(1)),
            traderInputAmount: 50_000 * 1e18,
            traderOutputAmount: 49_816 * 1e6,
            traderInputDecimals: 18,
            traderOutputDecimals: 6,
            valueDecimals: 0,
            currentTime: 1_000,
            maximumPriceAgeSeconds: 120,
            maximumPriceDeviationBps: 100
        });
    }

    function _epoch() internal view returns (DirectSettlement.CapacityEpoch memory epoch) {
        epoch = DirectSettlement.CapacityEpoch({
            positionIdHash: POSITION_ID,
            traderInputTokenId: bytes32(uint256(uint160(WETH))),
            traderOutputTokenId: bytes32(uint256(uint160(USDC))),
            balanceSnapshot: bytes32(uint256(3)),
            priceSnapshot: bytes32(uint256(4)),
            portfolioPriceSnapshot: bytes32(uint256(5)),
            policyNonce: 2,
            riskCertificateHash: bytes32(0),
            aquaStrategyHash: STRATEGY,
            capacityBaseline: 50_000,
            consumedBefore: 0,
            chainId: block.chainid,
            verifyingContract: address(router),
            capacityEpochId: bytes32(0)
        });
        epoch.capacityEpochId = DirectSettlement.capacityEpochId(epoch);
    }
}

contract AurkaSwapVMRouterMixedDecimalTest is TestBase {
    bytes32 internal constant POLICY_ID = keccak256("policy:mixed-decimal-test");
    bytes32 internal constant POSITION_ID = keccak256("position:mixed-decimal-test");
    bytes32 internal constant STRATEGY = keccak256("strategy:mixed-decimal-test");
    uint256 internal constant TRADER_KEY = 0xA11CE;
    uint256 internal constant SOLVER_KEY = 0xB0B;
    address internal constant TREASURY = address(0xDADA);
    address internal constant PROTOCOL = address(0xD00D);

    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockAqua internal aqua;
    MockPriceOracle internal oracle;
    AurkaDirectSwapVM internal swapVM;
    AurkaPolicyRegistry internal policyRegistry;
    RiskModeRegistry internal riskRegistry;
    AurkaSwapVMRouter internal router;
    RouterMathHarness internal math;
    address internal trader;
    address internal solver;

    struct TradeCase {
        AurkaSwapVMRouter.Intent intent;
        AurkaSwapVMRouter.Proposal proposal;
        PortfolioBounds.AssetState[] assets;
        DirectSettlement.CapacityEpoch epoch;
        PriceProtection.SettlementInput priceInput;
        bytes directProgram;
        bytes intentSignature;
        bytes proposalSignature;
    }

    event FeesRouted(
        bytes32 indexed proposalHash,
        address indexed feeToken,
        address indexed solver,
        address protocolRecipient,
        uint256 solverAmount,
        uint256 protocolAmount,
        uint256 treasuryAmount
    );

    function setUp() public {
        vm.warp(1_000);
        trader = vm.addr(TRADER_KEY);
        solver = vm.addr(SOLVER_KEY);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        aqua = new MockAqua();
        oracle = new MockPriceOracle();
        swapVM = new AurkaDirectSwapVM();
        policyRegistry = new AurkaPolicyRegistry();
        riskRegistry = new RiskModeRegistry(policyRegistry);
        router = new AurkaSwapVMRouter(policyRegistry, riskRegistry, aqua, swapVM);
        math = new RouterMathHarness();

        AurkaPolicyRegistry.AssetConfig[] memory assets = new AurkaPolicyRegistry.AssetConfig[](2);
        assets[0] = AurkaPolicyRegistry.AssetConfig(address(usdc), 6, 5_500, 10_000);
        assets[1] = AurkaPolicyRegistry.AssetConfig(address(weth), 18, 0, 10_000);
        policyRegistry.createPolicy(
            POLICY_ID,
            TREASURY,
            address(this),
            assets,
            50_000,
            AurkaPolicyRegistry.FeeConfig({
                baseFeeBps: 20,
                slopeBps: 80,
                maximumFeeBps: 100,
                treasuryBaseFeeBps: 10,
                solverFeeBps: 5,
                protocolFeeBps: 5,
                treasuryFeeRecipient: TREASURY,
                protocolFeeRecipient: PROTOCOL
            })
        );
        policyRegistry.setSettlementConfiguration(POLICY_ID, POSITION_ID, STRATEGY, address(oracle));

        oracle.setPrice(address(usdc), 1e6, 6, 990, bytes32(uint256(1)));
        oracle.setPrice(address(weth), 1e18, 18, 990, bytes32(uint256(2)));

        usdc.mint(TREASURY, 1_000_000 * 1e6);
        weth.mint(TREASURY, 1_000_000 * 1e18);
        weth.mint(trader, 1_000_000 * 1e18);
        vm.prank(TREASURY);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(TREASURY);
        weth.approve(address(aqua), type(uint256).max);
        aqua.seed(TREASURY, address(router), STRATEGY, address(usdc), 600_000 * 1e6);
        aqua.seed(TREASURY, address(router), STRATEGY, address(weth), 300_000 * 1e18);
    }

    function testValidMixedDecimalSettlementReloadsAuthoritativeBalances() public {
        TradeCase memory c = _buildCase();
        router.activateCapacityEpoch(POLICY_ID, c.epoch, c.priceInput);
        vm.prank(trader);
        weth.approve(address(router), c.priceInput.traderInputAmount);

        assertEq(c.proposal.solverFeeAmount, 25 * 1e6);
        assertEq(c.proposal.protocolFeeAmount, 25 * 1e6);
        assertEq(c.proposal.solverAmount, 25);
        assertEq(c.proposal.protocolAmount, 25);
        assertEq(
            c.proposal.treasuryAmount + c.proposal.solverAmount + c.proposal.protocolAmount,
            c.proposal.totalFeeAmount
        );
        vm.expectEmit(true, true, true, true);
        emit FeesRouted(
            router.hashProposal(c.proposal),
            c.proposal.feeToken,
            c.proposal.solver,
            PROTOCOL,
            c.proposal.solverAmount,
            c.proposal.protocolAmount,
            c.proposal.treasuryAmount
        );

        uint256 traderUsdcBefore = usdc.balanceOf(trader);
        uint256 traderWethBefore = weth.balanceOf(trader);
        (,, uint256 executed) = router.execute(
            c.intent,
            c.intentSignature,
            c.proposal,
            c.proposalSignature,
            c.assets,
            c.epoch,
            c.priceInput,
            c.directProgram
        );

        assertEq(executed, 50_000);
        assertEq(usdc.balanceOf(trader) - traderUsdcBefore, 49_766 * 1e6);
        assertEq(traderWethBefore - weth.balanceOf(trader), 50_000 * 1e18);
        (uint248 usdcBalance,) =
            aqua.rawBalances(TREASURY, address(router), STRATEGY, address(usdc));
        (uint248 wethBalance,) =
            aqua.rawBalances(TREASURY, address(router), STRATEGY, address(weth));
        assertEq(usdcBalance, 550_184 * 1e6);
        assertEq(wethBalance, 350_000 * 1e18);
    }

    function _buildCase() internal returns (TradeCase memory c) {
        c.assets = _assets();
        c.priceInput = _priceInput();
        bytes32 balanceSnapshot = _balanceSnapshot();
        bytes32 priceSnapshot = router.priceSnapshotHash(c.priceInput);
        c.intent = AurkaSwapVMRouter.Intent({
            intentId: keccak256("intent:mixed-decimal"),
            policyId: POLICY_ID,
            positionIdHash: POSITION_ID,
            trader: trader,
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            requestedValue: 50_000,
            minimumTraderOutputValue: 49_766,
            exactInput: true,
            allowPartialFill: false,
            deadline: block.timestamp + 500,
            nonce: 1,
            balanceSnapshot: balanceSnapshot,
            priceSnapshot: priceSnapshot,
            aquaStrategyHash: STRATEGY
        });
        c.epoch = _epoch(balanceSnapshot, priceSnapshot);
        DirectSettlement.FillResult memory fill =
            math.solve(c.assets, address(weth), address(usdc), 50_000, c.priceInput, c.epoch);
        c.priceInput.traderInputAmount = fill.maximumSafeFill * 1e18;
        c.priceInput.traderOutputAmount = fill.treasuryOutputValue * 1e6;
        bytes32 intentHash = router.hashIntent(c.intent);
        c.proposal = _proposal(intentHash, fill, priceSnapshot, c.epoch, c.assets);
        c.directProgram = abi.encode(
            router.DIRECT_PROGRAM_ID(),
            c.intent.policyId,
            c.intent.positionIdHash,
            c.intent.trader,
            c.intent.traderInputToken,
            c.intent.traderOutputToken,
            c.proposal.aquaStrategyHash,
            c.proposal.traderInputAmount,
            c.proposal.traderOutputAmount,
            c.proposal.solverFeeAmount,
            c.proposal.protocolFeeAmount,
            c.proposal.traderInputValue,
            c.proposal.traderOutputValue,
            c.proposal.treasuryOutputValue,
            c.proposal.capacityEpochId,
            intentHash
        );
        c.proposal.swapVMCalldataHash = keccak256(c.directProgram);
        c.intentSignature = _sign(TRADER_KEY, intentHash);
        c.proposalSignature = _sign(SOLVER_KEY, router.hashProposal(c.proposal));
    }

    function _proposal(
        bytes32 intentHash,
        DirectSettlement.FillResult memory fill,
        bytes32 priceSnapshot,
        DirectSettlement.CapacityEpoch memory epoch,
        PortfolioBounds.AssetState[] memory assets
    ) internal view returns (AurkaSwapVMRouter.Proposal memory proposal) {
        proposal = AurkaSwapVMRouter.Proposal({
            intentHash: intentHash,
            solver: solver,
            balancesHash: _balanceSnapshot(),
            priceSnapshotHash: priceSnapshot,
            policyNonce: policyRegistry.policyNonce(POLICY_ID),
            riskCertificateHash: bytes32(0),
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            traderInputAmount: fill.maximumSafeFill * 1e18,
            traderOutputAmount: fill.traderOutputValue * 1e6,
            solverFeeAmount: fill.fees.solverAmount * 1e6,
            protocolFeeAmount: fill.fees.protocolAmount * 1e6,
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
            feeToken: address(usdc),
            feePaymentMode: 0,
            initialPortfolioHash: keccak256(abi.encode(assets)),
            capacityBaselineValue: epoch.capacityBaseline,
            consumedBefore: 0,
            consumedAfter: fill.maximumSafeFill,
            capacityEpochId: epoch.capacityEpochId,
            utilizationBefore: fill.utilizationBefore,
            utilizationAfter: fill.utilizationAfter,
            bindingConstraint: uint8(fill.bindingConstraint),
            bindingAsset: fill.bindingAsset,
            expectedPostStateHash: keccak256(abi.encode(fill.postTrade)),
            aquaStrategyHash: STRATEGY,
            swapVMCalldataHash: bytes32(0),
            deadline: block.timestamp + 500
        });
    }

    function _assets() internal view returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](2);
        assets[0] = PortfolioBounds.AssetState(address(usdc), 600_000, 5_500, 10_000);
        assets[1] = PortfolioBounds.AssetState(address(weth), 300_000, 0, 10_000);
    }

    function _priceInput() internal view returns (PriceProtection.SettlementInput memory input) {
        input = PriceProtection.SettlementInput({
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            traderInputReferencePrice: PriceProtection.Snapshot(
                address(weth), bytes32(uint256(2)), 1e18, 18, 990
            ),
            traderInputExecutionPrice: PriceProtection.Snapshot(
                address(weth), bytes32(uint256(2)), 1e18, 18, 990
            ),
            traderOutputReferencePrice: PriceProtection.Snapshot(
                address(usdc), bytes32(uint256(1)), 1e6, 6, 990
            ),
            traderOutputExecutionPrice: PriceProtection.Snapshot(
                address(usdc), bytes32(uint256(1)), 1e6, 6, 990
            ),
            approvedTraderInputSnapshotId: bytes32(uint256(2)),
            approvedTraderOutputSnapshotId: bytes32(uint256(1)),
            traderInputAmount: 50_000 * 1e18,
            traderOutputAmount: 49_816 * 1e6,
            traderInputDecimals: 18,
            traderOutputDecimals: 6,
            valueDecimals: 0,
            currentTime: 1_000,
            maximumPriceAgeSeconds: 120,
            maximumPriceDeviationBps: 100
        });
    }

    function _balanceSnapshot() internal view returns (bytes32) {
        address[] memory tokens = new address[](2);
        uint256[] memory balances = new uint256[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        balances[0] = 600_000 * 1e6;
        balances[1] = 300_000 * 1e18;
        return keccak256(abi.encode(tokens, balances));
    }

    function _epoch(bytes32 balanceSnapshot, bytes32 priceSnapshot)
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
            aquaStrategyHash: STRATEGY,
            capacityBaseline: 50_000,
            consumedBefore: 0,
            chainId: block.chainid,
            verifyingContract: address(router),
            capacityEpochId: bytes32(0)
        });
        epoch.capacityEpochId = DirectSettlement.capacityEpochId(epoch);
    }

    function _sign(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
