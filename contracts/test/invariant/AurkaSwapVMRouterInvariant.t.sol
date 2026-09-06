// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../../src/AurkaPolicyRegistry.sol";
import { AurkaSwapVMRouter } from "../../src/AurkaSwapVMRouter.sol";
import { RiskModeRegistry } from "../../src/RiskModeRegistry.sol";
import { DirectSettlement } from "../../src/libraries/DirectSettlement.sol";
import { OptionSpaceFee } from "../../src/libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "../../src/libraries/PortfolioBounds.sol";
import { PriceProtection } from "../../src/libraries/PriceProtection.sol";
import { TestBase } from "../TestBase.sol";
import { MockAqua } from "../mocks/MockAqua.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";
import { MockPriceOracle } from "../mocks/MockPriceOracle.sol";
import { AurkaDirectSwapVM } from "../../src/AurkaDirectSwapVM.sol";

contract RouterSettlementHandler is TestBase {
    bytes32 public constant POLICY_ID = keccak256("policy:router-invariant");
    bytes32 public constant POSITION_ID = keccak256("position:router-invariant");
    bytes32 public constant STRATEGY = keccak256("strategy:router-invariant");
    uint256 public constant TRADER_KEY = 0xA11CE;
    uint256 public constant SOLVER_KEY = 0xB0B;
    address public constant TREASURY = address(0xBEEF);
    address public constant PROTOCOL = address(0xD00D);

    MockERC20 public usdc;
    MockERC20 public weth;
    MockERC20 public link;
    MockAqua public aqua;
    MockPriceOracle public oracle;
    AurkaPolicyRegistry public policyRegistry;
    RiskModeRegistry public riskRegistry;
    AurkaSwapVMRouter public router;
    address public trader;
    address public solver;

    uint256 public expectedAquaUsdc = 600_000;
    uint256 public expectedAquaWeth = 300_000;
    uint256 public expectedTraderUsdc;
    uint256 public expectedSolverUsdc;
    uint256 public expectedProtocolUsdc;
    uint256 public expectedConsumed;
    uint256 public successfulFills;

    bytes32 private _balanceSnapshot;
    bytes32 private _priceSnapshot;
    DirectSettlement.CapacityEpoch private _baseEpoch;
    PriceProtection.SettlementInput private _basePriceInput;

    constructor(
        MockERC20 usdc_,
        MockERC20 weth_,
        MockERC20 link_,
        MockAqua aqua_,
        MockPriceOracle oracle_
    ) {
        usdc = usdc_;
        weth = weth_;
        link = link_;
        aqua = aqua_;
        oracle = oracle_;
    }

    function configure(
        AurkaPolicyRegistry policyRegistry_,
        RiskModeRegistry riskRegistry_,
        AurkaSwapVMRouter router_,
        address trader_,
        address solver_
    ) external {
        policyRegistry = policyRegistry_;
        riskRegistry = riskRegistry_;
        router = router_;
        trader = trader_;
        solver = solver_;
        _basePriceInput = _priceInput(50_000, 50_000);
        _balanceSnapshot = _balanceSnapshotValue();
        _priceSnapshot = router.priceSnapshotHash(_basePriceInput);
        _baseEpoch = DirectSettlement.CapacityEpoch({
            positionIdHash: POSITION_ID,
            traderInputTokenId: _tokenId(address(weth)),
            traderOutputTokenId: _tokenId(address(usdc)),
            balanceSnapshot: _balanceSnapshot,
            priceSnapshot: _priceSnapshot,
            portfolioPriceSnapshot: router.portfolioPriceSnapshotHash(POLICY_ID, POSITION_ID),
            policyNonce: 2,
            riskCertificateHash: bytes32(0),
            aquaStrategyHash: STRATEGY,
            capacityBaseline: 50_000,
            consumedBefore: 0,
            chainId: block.chainid,
            verifyingContract: address(router),
            capacityEpochId: bytes32(0)
        });
        _baseEpoch.capacityEpochId = DirectSettlement.capacityEpochId(_baseEpoch);
        vm.prank(TREASURY);
        router.activateCapacityEpoch(POLICY_ID, _baseEpoch, _basePriceInput);
    }

    function step(uint256 seed) external {
        uint256 remaining = 50_000 - expectedConsumed;
        if (remaining < 1_000) return;
        uint256 requested = bound(seed, 1_000, remaining);
        PortfolioBounds.AssetState[] memory assets = _portfolio();
        DirectSettlement.CapacityEpoch memory epoch = _baseEpoch;
        epoch.consumedBefore = expectedConsumed;
        PriceProtection.SettlementInput memory priceInput = _priceInput(requested, requested);
        DirectSettlement.FillResult memory fill = DirectSettlement.maximumSafeFill(
            assets,
            address(weth),
            address(usdc),
            requested,
            50_000,
            50_000,
            expectedConsumed,
            _feeConfig(),
            priceInput,
            epoch,
            uint64(block.timestamp)
        );
        priceInput.traderInputAmount = fill.maximumSafeFill;
        priceInput.traderOutputAmount = fill.treasuryOutputValue;
        fill = DirectSettlement.maximumSafeFill(
            assets,
            address(weth),
            address(usdc),
            requested,
            50_000,
            50_000,
            expectedConsumed,
            _feeConfig(),
            priceInput,
            epoch,
            uint64(block.timestamp)
        );
        bytes32 intentHash;
        AurkaSwapVMRouter.Intent memory intent = AurkaSwapVMRouter.Intent({
            intentId: keccak256(abi.encode("intent", seed, expectedConsumed)),
            policyId: POLICY_ID,
            positionIdHash: POSITION_ID,
            trader: trader,
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            requestedValue: requested,
            minimumTraderOutputValue: 1,
            exactInput: false,
            allowPartialFill: true,
            deadline: block.timestamp + 500,
            nonce: expectedConsumed + 1,
            balanceSnapshot: _balanceSnapshot,
            priceSnapshot: _priceSnapshot,
            aquaStrategyHash: STRATEGY
        });
        intentHash = router.hashIntent(intent);
        AurkaSwapVMRouter.Proposal memory proposal =
            _proposal(intentHash, fill, epoch, assets, priceInput);
        bytes memory program = _program(intent, proposal, intentHash);
        proposal.swapVMCalldataHash = keccak256(program);
        bytes memory intentSignature = _sign(TRADER_KEY, intentHash);
        bytes memory proposalSignature = _sign(SOLVER_KEY, router.hashProposal(proposal));
        router.execute(
            intent, intentSignature, proposal, proposalSignature, assets, epoch, priceInput, program
        );

        expectedConsumed += fill.maximumSafeFill;
        expectedAquaUsdc -= fill.treasuryOutputValue;
        expectedAquaWeth += fill.maximumSafeFill;
        expectedTraderUsdc += fill.traderOutputValue;
        expectedSolverUsdc += fill.fees.solverAmount;
        expectedProtocolUsdc += fill.fees.protocolAmount;
        ++successfulFills;
    }

    function actualAquaUsdc() external view returns (uint256 balance) {
        (uint248 value,) = aqua.rawBalances(TREASURY, address(router), STRATEGY, address(usdc));
        return value;
    }

    function actualAquaWeth() external view returns (uint256 balance) {
        (uint248 value,) = aqua.rawBalances(TREASURY, address(router), STRATEGY, address(weth));
        return value;
    }

    function actualCapacity() external view returns (uint256) {
        return router.capacityState(POSITION_ID, address(weth), address(usdc)).consumedValue;
    }

    function actualTraderWeth() external view returns (uint256) {
        return weth.balanceOf(trader);
    }

    function _proposal(
        bytes32 intentHash,
        DirectSettlement.FillResult memory fill,
        DirectSettlement.CapacityEpoch memory epoch,
        PortfolioBounds.AssetState[] memory assets,
        PriceProtection.SettlementInput memory priceInput
    ) private view returns (AurkaSwapVMRouter.Proposal memory proposal) {
        proposal = AurkaSwapVMRouter.Proposal({
            intentHash: intentHash,
            solver: solver,
            balancesHash: _balanceSnapshot,
            priceSnapshotHash: _priceSnapshot,
            policyNonce: 2,
            riskCertificateHash: bytes32(0),
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
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
            feeToken: address(usdc),
            feePaymentMode: 0,
            initialPortfolioHash: keccak256(abi.encode(assets)),
            capacityBaselineValue: 50_000,
            consumedBefore: expectedConsumed,
            consumedAfter: expectedConsumed + fill.maximumSafeFill,
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
    ) private view returns (bytes memory) {
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

    function _portfolio() private view returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](3);
        assets[0] = PortfolioBounds.AssetState(address(usdc), expectedAquaUsdc, 5_500, 10_000);
        assets[1] = PortfolioBounds.AssetState(address(weth), expectedAquaWeth, 0, 3_500);
        assets[2] = PortfolioBounds.AssetState(address(link), 100_000, 0, 1_500);
    }

    function _priceInput(uint256 inputAmount, uint256 outputAmount)
        private
        view
        returns (PriceProtection.SettlementInput memory input)
    {
        input = PriceProtection.SettlementInput({
            traderInputToken: address(weth),
            traderOutputToken: address(usdc),
            traderInputReferencePrice: PriceProtection.Snapshot(
                address(weth), bytes32(uint256(1)), 1, 0, 990
            ),
            traderInputExecutionPrice: PriceProtection.Snapshot(
                address(weth), bytes32(uint256(1)), 1, 0, 990
            ),
            traderOutputReferencePrice: PriceProtection.Snapshot(
                address(usdc), bytes32(uint256(2)), 1, 0, 990
            ),
            traderOutputExecutionPrice: PriceProtection.Snapshot(
                address(usdc), bytes32(uint256(2)), 1, 0, 990
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

    function _balanceSnapshotValue() private view returns (bytes32) {
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

    function _feeConfig() private pure returns (OptionSpaceFee.FeeConfig memory) {
        return OptionSpaceFee.FeeConfig({
            baseFeeBps: 20,
            slopeBps: 80,
            maximumFeeBps: 100,
            treasuryBaseFeeBps: 10,
            solverFeeBps: 5,
            protocolFeeBps: 5
        });
    }

    function _sign(uint256 privateKey, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _tokenId(address token) private pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }
}

contract AurkaSwapVMRouterInvariantTest is TestBase {
    bytes32 internal constant POLICY_ID = keccak256("policy:router-invariant");
    bytes32 internal constant POSITION_ID = keccak256("position:router-invariant");
    bytes32 internal constant STRATEGY = keccak256("strategy:router-invariant");
    uint256 internal constant TRADER_KEY = 0xA11CE;
    uint256 internal constant SOLVER_KEY = 0xB0B;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant PROTOCOL = address(0xD00D);
    RouterSettlementHandler internal handler;

    function setUp() public {
        vm.warp(1_000);
        address trader = vm.addr(TRADER_KEY);
        MockERC20 usdc = new MockERC20("USDC", 0);
        MockERC20 weth = new MockERC20("WETH", 0);
        MockERC20 link = new MockERC20("LINK", 0);
        MockAqua aqua = new MockAqua();
        MockPriceOracle oracle = new MockPriceOracle();
        AurkaPolicyRegistry policyRegistry = new AurkaPolicyRegistry();
        RiskModeRegistry riskRegistry = new RiskModeRegistry(policyRegistry);
        AurkaSwapVMRouter router =
            new AurkaSwapVMRouter(policyRegistry, riskRegistry, aqua, new AurkaDirectSwapVM());

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
        policyRegistry.setSettlementConfiguration(POLICY_ID, POSITION_ID, STRATEGY, address(oracle));
        oracle.setPrice(address(usdc), 1, 0, 990, bytes32(uint256(2)));
        oracle.setPrice(address(weth), 1, 0, 990, bytes32(uint256(1)));
        oracle.setPrice(address(link), 1, 0, 990, bytes32(uint256(3)));
        usdc.mint(TREASURY, 1_000_000);
        weth.mint(trader, 1_000_000);
        vm.prank(TREASURY);
        usdc.approve(address(aqua), type(uint256).max);
        aqua.seed(TREASURY, address(router), STRATEGY, address(usdc), 600_000);
        aqua.seed(TREASURY, address(router), STRATEGY, address(weth), 300_000);
        aqua.seed(TREASURY, address(router), STRATEGY, address(link), 100_000);
        vm.prank(trader);
        weth.approve(address(router), type(uint256).max);

        handler = new RouterSettlementHandler(usdc, weth, link, aqua, oracle);
        handler.configure(policyRegistry, riskRegistry, router, trader, vm.addr(SOLVER_KEY));
        handler.step(1_000);
    }

    /// @dev The pinned Foundry version discovers invariant targets through
    /// this hook rather than the newer targetContract cheatcode. Restricting
    /// fuzz actions to the handler excludes unsolicited token/Aqua mutations.
    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// @dev The pinned Foundry version does not expose targetContract(). The
    /// forwarding action keeps the router handler in the invariant target ABI.
    function step(uint256 seed) external {
        handler.step(seed);
    }

    function invariantRouterAquaAndTokenDeltasReconcile() public view {
        assertGe(handler.successfulFills(), 1);
        assertEq(handler.actualAquaUsdc(), handler.expectedAquaUsdc());
        assertEq(handler.actualAquaWeth(), handler.expectedAquaWeth());
        assertEq(handler.actualCapacity(), handler.expectedConsumed());
        assertLe(handler.expectedConsumed(), 50_000);
        assertEq(handler.actualTraderWeth(), 1_000_000 - handler.expectedConsumed());
        assertEq(handler.usdc().balanceOf(handler.trader()), handler.expectedTraderUsdc());
        assertEq(handler.usdc().balanceOf(handler.solver()), handler.expectedSolverUsdc());
        assertEq(handler.usdc().balanceOf(address(0xD00D)), handler.expectedProtocolUsdc());
    }
}
