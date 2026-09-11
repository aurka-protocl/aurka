// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "./AurkaPolicyRegistry.sol";
import { AurkaSettlementAuthority } from "./AurkaSettlementAuthority.sol";
import { RiskModeRegistry } from "./RiskModeRegistry.sol";
import { IAqua } from "./interfaces/IAqua.sol";
import { IERC20Minimal } from "./interfaces/IERC20Minimal.sol";
import { ISwapVM } from "./interfaces/ISwapVM.sol";
import { DirectSettlement } from "./libraries/DirectSettlement.sol";
import { OptionSpaceFee } from "./libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "./libraries/PortfolioBounds.sol";
import { PriceProtection } from "./libraries/PriceProtection.sol";

interface IAurkaSepoliaTradeMath {
    function maximumSafeFill(
        PortfolioBounds.AssetState[] calldata assets,
        address inputToken,
        address outputToken,
        uint256 requestedValue,
        uint256 maximumTransactionValue,
        uint256 capacityBaseline,
        uint256 consumedBefore,
        OptionSpaceFee.FeeConfig calldata fee,
        PriceProtection.SettlementInput calldata priceInput,
        DirectSettlement.CapacityEpoch calldata epoch,
        uint64 currentTimestamp
    ) external pure returns (DirectSettlement.FillResult memory);

    function normalizeValue(
        uint256 amount,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 valueDecimals
    ) external pure returns (uint256);

    function isWithinBounds(PortfolioBounds.AssetState[] calldata assets)
        external
        pure
        returns (bool);

    function validateFill(
        uint256 traderInputValue,
        uint256 traderOutputValue,
        uint256 treasuryOutputValue,
        uint256 feeBpsScaled,
        uint256 baseFeeAmount,
        uint256 treasuryBaseFeeAmount,
        uint256 optionSpacePremiumAmount,
        uint256 totalFeeAmount,
        uint256 treasuryAmount,
        uint256 solverAmount,
        uint256 protocolAmount,
        uint256 utilizationBefore,
        uint256 utilizationAfter,
        uint8 bindingConstraint,
        address bindingAsset,
        uint256 consumedBefore,
        uint256 consumedAfter,
        DirectSettlement.FillResult calldata fill
    ) external pure;

    function validateRawOutputAmounts(
        uint256 traderOutputAmount,
        uint256 solverFeeAmount,
        uint256 protocolFeeAmount,
        PriceProtection.SettlementInput calldata priceInput,
        DirectSettlement.FillResult calldata fill
    ) external pure;

    function validateEpoch(
        DirectSettlement.CapacityEpoch calldata epoch,
        bytes32 intentPositionIdHash,
        address intentInputToken,
        address intentOutputToken,
        bytes32 intentBalanceSnapshot,
        bytes32 intentPriceSnapshot,
        uint256 proposalPolicyNonce,
        bytes32 proposalRiskCertificateHash,
        bytes32 proposalAquaStrategyHash,
        bytes32 proposalCapacityEpochId,
        uint256 proposalCapacityBaseline,
        uint256 proposalConsumedBefore
    ) external view;

    function authorityHash(bytes32 policyId, DirectSettlement.CapacityEpoch calldata epoch)
        external
        pure
        returns (bytes32);
}

interface IAurkaSepoliaUpstreamExecutor {
    function swapVM() external view returns (address);

    function aqua() external view returns (address);

    function policyRegistry() external view returns (address);

    function swapVMGuard() external view returns (address);

    function execute(
        address treasury,
        address trader,
        address solver,
        address traderInputToken,
        address traderOutputToken,
        bytes32 policyId,
        bytes32 strategyHash,
        uint256 traderInputAmount,
        uint256 traderOutputAmount,
        uint256 solverFeeAmount,
        uint256 protocolFeeAmount,
        uint256 treasuryOutputAmount,
        uint256 traderInputValue,
        uint8 traderOutputDecimals,
        uint256 traderOutputPrice,
        uint8 traderOutputPriceDecimals,
        uint256 deadline,
        uint256 makerTraits,
        bytes calldata orderData,
        bytes calldata takerTraitsAndData
    ) external returns (bytes32 orderHash, uint256 amountIn, uint256 amountOut);
}

/// @title AURKA Sepolia upstream SwapVM settlement router
/// @notice The deployable Sepolia variant of the AURKA settlement boundary.
/// @dev This deliberately exposes only the reviewed upstream SwapVM path. The
///      legacy direct path remains in AurkaSwapVMRouter for local regression;
///      removing it here keeps the public deployment below EIP-170 while
///      retaining the policy, risk, oracle, Aqua, and replay checks.
contract AurkaSepoliaSwapVMRouter {
    uint8 public constant FEE_PAYMENT_OUTPUT_TOKEN = 0;
    bytes32 public constant DIRECT_PROGRAM_ID = keccak256("AURKA_DIRECT_PAIR_V1");

    struct Intent {
        bytes32 intentId;
        bytes32 policyId;
        bytes32 positionIdHash;
        address trader;
        address traderInputToken;
        address traderOutputToken;
        uint256 requestedValue;
        uint256 minimumTraderOutputValue;
        bool exactInput;
        bool allowPartialFill;
        uint256 deadline;
        uint256 nonce;
        bytes32 balanceSnapshot;
        bytes32 priceSnapshot;
        bytes32 aquaStrategyHash;
    }

    struct Proposal {
        bytes32 intentHash;
        address solver;
        bytes32 balancesHash;
        bytes32 priceSnapshotHash;
        uint256 policyNonce;
        bytes32 riskCertificateHash;
        address traderInputToken;
        address traderOutputToken;
        uint256 traderInputAmount;
        uint256 traderOutputAmount;
        uint256 solverFeeAmount;
        uint256 protocolFeeAmount;
        uint256 traderInputValue;
        uint256 traderOutputValue;
        uint256 treasuryOutputValue;
        uint256 feeBpsScaled;
        uint256 baseFeeAmount;
        uint256 treasuryBaseFeeAmount;
        uint256 optionSpacePremiumAmount;
        uint256 totalFeeAmount;
        uint256 treasuryAmount;
        uint256 solverAmount;
        uint256 protocolAmount;
        address feeToken;
        uint8 feePaymentMode;
        bytes32 initialPortfolioHash;
        uint256 capacityBaselineValue;
        uint256 consumedBefore;
        uint256 consumedAfter;
        bytes32 capacityEpochId;
        uint256 utilizationBefore;
        uint256 utilizationAfter;
        uint8 bindingConstraint;
        address bindingAsset;
        bytes32 expectedPostStateHash;
        bytes32 aquaStrategyHash;
        bytes32 swapVMCalldataHash;
        uint256 deadline;
    }

    struct CapacityState {
        bytes32 capacityEpochId;
        uint256 capacityBaselineValue;
        uint256 consumedValue;
    }

    struct Validation {
        bytes32 intentHash;
        bytes32 proposalHash;
        AurkaPolicyRegistry.Policy policy;
        DirectSettlement.FillResult fill;
        uint256 treasuryInputValue;
        uint256 treasuryOutputValue;
        address[] tokens;
        uint256[] balancesBefore;
        PortfolioBounds.AssetState[] authoritativeAssets;
        bytes32 portfolioPriceSnapshot;
    }

    AurkaPolicyRegistry public immutable policyRegistry;
    RiskModeRegistry public immutable riskRegistry;
    IAqua public immutable aqua;
    ISwapVM public immutable swapVM;
    IAurkaSepoliaTradeMath public immutable tradeMath;
    IAurkaSepoliaUpstreamExecutor public immutable upstreamExecutor;
    address public immutable aquaApp;
    address public immutable swapVMGuard;
    AurkaSettlementAuthority public immutable settlementAuthority;

    mapping(address trader => mapping(uint256 nonce => bool used)) public usedIntentNonces;
    mapping(bytes32 intentId => bool used) public usedIntentIds;
    mapping(bytes32 proposalHash => bool used) public usedProposals;
    mapping(bytes32 positionAndDirection => CapacityState state) private _capacity;
    mapping(bytes32 positionAndDirection => mapping(address token => uint256 expectedBalance))
        private _epochBalances;
    mapping(bytes32 positionAndDirection => bytes32 authorityHash) private _epochAuthorityHashes;
    uint256 private _lock = 1;

    error AquaBalanceMismatch(address token, uint256 expected, uint256 actual);
    error CapacityEpochNotActive(bytes32 positionIdHash, address input, address output);
    error CapacityEpochStateMismatch();
    error ExactInputNotSatisfied(uint256 requested, uint256 executed);
    error FeeAccountingMismatch();
    error FeePaymentModeUnsupported(uint8 mode);
    error InitialPortfolioMismatch();
    error IntentAlreadyUsed();
    error IntentExpired(uint256 deadline);
    error IntentProposalMismatch();
    error InvalidAddress();
    error InvalidCapacityEpoch();
    error InvalidSignature();
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error MinimumOutputNotSatisfied(uint256 minimum, uint256 actual);
    error PolicyPaused();
    error PolicyStateMismatch();
    error ProposalAlreadyUsed();
    error ProposalExpired(uint256 deadline);
    error ProposalMismatch();
    error Reentrancy();
    error PortfolioPriceSnapshotMismatch();
    error StrategyNotAuthorized();
    error CapacityBaselineMismatch(uint256 expected, uint256 actual);
    error SwapVMExecutionMismatch();
    error SwapVMCalldataMismatch();
    error TokenBalanceMismatch(address token, uint256 expected, uint256 actual);
    error TokenTransferFailed(address token);

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
    event UpstreamSwapVMExecuted(
        bytes32 indexed orderHash,
        bytes32 indexed proposalHash,
        address indexed maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 programHash
    );

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        AurkaPolicyRegistry policyRegistry_,
        RiskModeRegistry riskRegistry_,
        IAqua aqua_,
        ISwapVM swapVM_,
        IAurkaSepoliaTradeMath tradeMath_,
        IAurkaSepoliaUpstreamExecutor upstreamExecutor_
    ) {
        if (address(policyRegistry_) == address(0) || address(riskRegistry_) == address(0)) {
            revert InvalidAddress();
        }
        if (
            address(aqua_) == address(0) || address(swapVM_) == address(0)
                || address(tradeMath_) == address(0)
                || address(upstreamExecutor_) == address(0)
                || upstreamExecutor_.swapVM() != address(swapVM_)
                || upstreamExecutor_.aqua() != address(aqua_)
                || upstreamExecutor_.policyRegistry() != address(policyRegistry_)
        ) {
            revert InvalidAddress();
        }
        policyRegistry = policyRegistry_;
        riskRegistry = riskRegistry_;
        aqua = aqua_;
        swapVM = swapVM_;
        tradeMath = tradeMath_;
        upstreamExecutor = upstreamExecutor_;
        address app = address(this);
        (bool isUpstream, bytes memory marker) =
            address(swapVM_).staticcall(abi.encodeWithSignature("aurkaUpstreamSwapVM()"));
        if (isUpstream && marker.length >= 32 && abi.decode(marker, (bool))) {
            app = address(swapVM_);
        }
        aquaApp = app;
        swapVMGuard = upstreamExecutor_.swapVMGuard();
        settlementAuthority =
            new AurkaSettlementAuthority(policyRegistry_, riskRegistry_, aqua_, address(this), app);
    }

    function domainSeparator() public view returns (bytes32) {
        return settlementAuthority.domainSeparator();
    }

    function hashIntent(Intent calldata intent) public view returns (bytes32) {
        return settlementAuthority.hashIntent(abi.encode(intent));
    }

    function hashProposal(Proposal calldata proposal) public view returns (bytes32) {
        return settlementAuthority.hashProposal(abi.encode(proposal));
    }

    function priceSnapshotHash(PriceProtection.SettlementInput calldata input)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                input.traderInputToken,
                input.traderOutputToken,
                input.traderInputReferencePrice,
                input.traderInputExecutionPrice,
                input.traderOutputReferencePrice,
                input.traderOutputExecutionPrice,
                input.approvedTraderInputSnapshotId,
                input.approvedTraderOutputSnapshotId,
                input.traderInputDecimals,
                input.traderOutputDecimals,
                input.valueDecimals,
                input.maximumPriceAgeSeconds,
                input.maximumPriceDeviationBps
            )
        );
    }

    function capacityState(
        bytes32 positionIdHash,
        address traderInputToken,
        address traderOutputToken
    ) external view returns (CapacityState memory) {
        return _capacity[_directionKey(positionIdHash, traderInputToken, traderOutputToken)];
    }

    /// @notice Governance or treasury opens a fresh directional capacity epoch.
    /// @dev Space creation uses the factory-only entry point below; this entry
    ///      remains for the explicit governance-managed acceptance path.
    function activateCapacityEpoch(
        bytes32 policyId,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput
    ) external {
        AurkaPolicyRegistry.Policy memory policy = policyRegistry.getPolicy(policyId);
        if (msg.sender != policy.governance && msg.sender != policy.treasury) {
            revert PolicyStateMismatch();
        }
        _activateCapacityEpoch(policyId, epoch, priceInput);
    }

    function activateCapacityEpochFromFactory(
        bytes32 policyId,
        DirectSettlement.CapacityEpoch calldata committedEpoch,
        PriceProtection.SettlementInput calldata priceInput
    ) external returns (bytes32 capacityEpochId, uint256 capacityBaseline) {
        if (msg.sender != policyRegistry.initializationFactory()) {
            revert StrategyNotAuthorized();
        }
        if (committedEpoch.capacityBaseline != 0 || committedEpoch.capacityEpochId != bytes32(0)) {
            revert InvalidCapacityEpoch();
        }
        if (committedEpoch.consumedBefore != 0) revert InvalidCapacityEpoch();
        if (
            committedEpoch.chainId != block.chainid
                || committedEpoch.verifyingContract != address(this)
        ) revert InvalidCapacityEpoch();
        if (
            _tokenFromId(committedEpoch.traderInputTokenId) != priceInput.traderInputToken
                || _tokenFromId(committedEpoch.traderOutputTokenId) != priceInput.traderOutputToken
        ) revert InvalidCapacityEpoch();

        (
            address[] memory tokens,
            uint256[] memory balances,
            PortfolioBounds.AssetState[] memory assets,
            bytes32 portfolioPriceSnapshot
        ) = settlementAuthority.authoritativePortfolio(
            policyId, committedEpoch.positionIdHash, committedEpoch.aquaStrategyHash, priceInput
        );
        if (keccak256(abi.encode(tokens, balances)) != committedEpoch.balanceSnapshot) {
            revert PolicyStateMismatch();
        }
        if (
            committedEpoch.priceSnapshot != priceSnapshotHash(priceInput)
                || committedEpoch.portfolioPriceSnapshot != portfolioPriceSnapshot
        ) revert PortfolioPriceSnapshotMismatch();
        capacityBaseline =
            settlementAuthority.deriveCapacityBaseline(policyId, committedEpoch, priceInput, assets);
        if (capacityBaseline == 0) revert CapacityBaselineMismatch(1, 0);
        DirectSettlement.CapacityEpoch memory resolved = committedEpoch;
        resolved.capacityBaseline = capacityBaseline;
        resolved.capacityEpochId = DirectSettlement.capacityEpochId(resolved);
        _activateCapacityEpoch(policyId, resolved, priceInput);
        return (resolved.capacityEpochId, capacityBaseline);
    }

    function _activateCapacityEpoch(
        bytes32 policyId,
        DirectSettlement.CapacityEpoch memory epoch,
        PriceProtection.SettlementInput calldata priceInput
    ) private {
        AurkaPolicyRegistry.Policy memory policy = policyRegistry.getPolicy(policyId);
        if (
            epoch.chainId != block.chainid || epoch.verifyingContract != address(this)
                || epoch.capacityEpochId != DirectSettlement.capacityEpochId(epoch)
        ) revert InvalidCapacityEpoch();
        if (
            _tokenFromId(epoch.traderInputTokenId) != priceInput.traderInputToken
                || _tokenFromId(epoch.traderOutputTokenId) != priceInput.traderOutputToken
        ) revert InvalidCapacityEpoch();
        if (epoch.consumedBefore != 0 || epoch.capacityBaseline == 0) {
            revert InvalidCapacityEpoch();
        }
        AurkaPolicyRegistry.SettlementConfiguration memory configuration =
            policyRegistry.settlementConfiguration(policyId, epoch.positionIdHash);
        if (epoch.aquaStrategyHash != configuration.aquaStrategyHash) {
            revert StrategyNotAuthorized();
        }
        bytes32 riskHash = _effectiveRiskHash(policyId);
        if (epoch.policyNonce != policy.nonce || epoch.riskCertificateHash != riskHash) {
            revert PolicyStateMismatch();
        }
        (
            address[] memory tokens,
            uint256[] memory balances,
            PortfolioBounds.AssetState[] memory assets,
            bytes32 portfolioPriceSnapshot
        ) = settlementAuthority.authoritativePortfolio(
            policyId, epoch.positionIdHash, epoch.aquaStrategyHash, priceInput
        );
        if (tokens.length != balances.length) revert PolicyStateMismatch();
        if (
            epoch.priceSnapshot != priceSnapshotHash(priceInput)
                || epoch.portfolioPriceSnapshot != portfolioPriceSnapshot
        ) revert PortfolioPriceSnapshotMismatch();
        uint256 expectedBaseline =
            settlementAuthority.deriveCapacityBaseline(policyId, epoch, priceInput, assets);
        if (epoch.capacityBaseline != expectedBaseline) {
            revert CapacityBaselineMismatch(expectedBaseline, epoch.capacityBaseline);
        }
        bytes32 key =
            _directionKey(epoch.positionIdHash, _tokenFromId(epoch.traderInputTokenId), _tokenFromId(epoch.traderOutputTokenId));
        CapacityState memory current = _capacity[key];
        bytes32 authorityHash = tradeMath.authorityHash(policyId, epoch);
        if (
            current.capacityEpochId == epoch.capacityEpochId
                || (current.consumedValue != 0 && _epochAuthorityHashes[key] == authorityHash)
        ) revert CapacityEpochStateMismatch();
        _capacity[key] = CapacityState({
            capacityEpochId: epoch.capacityEpochId,
            capacityBaselineValue: epoch.capacityBaseline,
            consumedValue: 0
        });
        _epochAuthorityHashes[key] = authorityHash;
        emit CapacityEpochActivated(
            policyId,
            epoch.positionIdHash,
            _tokenFromId(epoch.traderInputTokenId),
            _tokenFromId(epoch.traderOutputTokenId),
            epoch.capacityEpochId,
            epoch.capacityBaseline,
            epoch.policyNonce,
            epoch.riskCertificateHash,
            epoch.balanceSnapshot,
            epoch.priceSnapshot,
            epoch.portfolioPriceSnapshot,
            epoch.aquaStrategyHash,
            epoch.consumedBefore
        );
    }

    function executeWithSwapVM(
        Intent calldata intent,
        bytes calldata intentSignature,
        Proposal calldata proposal,
        bytes calldata proposalSignature,
        PortfolioBounds.AssetState[] calldata assets,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput,
        bytes calldata directProgram,
        uint256 makerTraits,
        bytes calldata orderData,
        bytes calldata takerTraitsAndData
    ) external nonReentrant returns (bytes32 intentHash, bytes32 proposalHash, uint256 executedValue) {
        if (
            keccak256(abi.encode(directProgram, makerTraits, orderData, takerTraitsAndData))
                != proposal.swapVMCalldataHash
        ) revert SwapVMCalldataMismatch();
        Validation memory validation = _validate(
            intent,
            intentSignature,
            proposal,
            proposalSignature,
            assets,
            epoch,
            priceInput,
            directProgram
        );
        _executeUpstreamSwapVM(
            validation.policy.treasury,
            intent,
            proposal,
            priceInput,
            makerTraits,
            orderData,
            takerTraitsAndData
        );
        return _finalizeExecution(intent, proposal, epoch, priceInput, validation);
    }

    function _finalizeExecution(
        Intent calldata intent,
        Proposal calldata proposal,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput,
        Validation memory validation
    ) private returns (bytes32 intentHash, bytes32 proposalHash, uint256 executedValue) {
        bytes32 key =
            _directionKey(intent.positionIdHash, intent.traderInputToken, intent.traderOutputToken);
        CapacityState storage state = _capacity[key];
        usedIntentNonces[intent.trader][intent.nonce] = true;
        usedIntentIds[intent.intentId] = true;
        usedProposals[validation.proposalHash] = true;
        bool firstFill = state.consumedValue == 0;
        if (firstFill) {
            for (uint256 i; i < validation.tokens.length; ++i) {
                _epochBalances[key][validation.tokens[i]] = validation.balancesBefore[i];
            }
        }
        state.consumedValue = proposal.consumedAfter;
        _assertFinalAquaBalances(
            validation.policy.treasury,
            proposal.aquaStrategyHash,
            validation.tokens,
            validation.balancesBefore,
            intent.traderInputToken,
            intent.traderOutputToken,
            priceInput.traderInputAmount,
            priceInput.traderOutputAmount
        );
        _assertFinalAuthoritativePortfolio(
            intent.policyId,
            intent.positionIdHash,
            proposal.aquaStrategyHash,
            priceInput,
            validation.portfolioPriceSnapshot,
            proposal.expectedPostStateHash
        );
        for (uint256 i; i < validation.tokens.length; ++i) {
            uint256 expected = validation.balancesBefore[i];
            if (validation.tokens[i] == intent.traderInputToken) expected += priceInput.traderInputAmount;
            if (validation.tokens[i] == intent.traderOutputToken) {
                if (expected < priceInput.traderOutputAmount) {
                    revert AquaBalanceMismatch(validation.tokens[i], 0, 0);
                }
                expected -= priceInput.traderOutputAmount;
            }
            _epochBalances[key][validation.tokens[i]] = expected;
        }
        emit FeesRouted(
            validation.proposalHash,
            proposal.feeToken,
            proposal.solver,
            validation.policy.fee.protocolFeeRecipient,
            proposal.solverAmount,
            proposal.protocolAmount,
            proposal.treasuryAmount
        );
        emit TradeExecuted(
            intent.policyId,
            intent.positionIdHash,
            validation.intentHash,
            validation.proposalHash,
            epoch.capacityEpochId,
            intent.trader,
            validation.policy.treasury,
            intent.traderInputToken,
            intent.traderOutputToken,
            proposal.traderInputValue,
            proposal.traderOutputValue,
            proposal.treasuryOutputValue,
            proposal.totalFeeAmount,
            proposal.consumedBefore,
            proposal.consumedAfter,
            proposal.expectedPostStateHash
        );
        return (validation.intentHash, validation.proposalHash, validation.fill.maximumSafeFill);
    }

    function _validate(
        Intent calldata intent,
        bytes calldata intentSignature,
        Proposal calldata proposal,
        bytes calldata proposalSignature,
        PortfolioBounds.AssetState[] calldata assets,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput,
        bytes calldata directProgram
    ) private view returns (Validation memory validation) {
        if (intent.trader == address(0) || intent.intentId == bytes32(0)) revert InvalidAddress();
        if (intent.traderInputToken == intent.traderOutputToken) revert InvalidAddress();
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
        if (block.timestamp > proposal.deadline) revert ProposalExpired(proposal.deadline);
        if (usedIntentNonces[intent.trader][intent.nonce] || usedIntentIds[intent.intentId]) {
            revert IntentAlreadyUsed();
        }
        validation.intentHash = hashIntent(intent);
        validation.proposalHash = hashProposal(proposal);
        if (_recover(validation.intentHash, intentSignature) != intent.trader) revert InvalidSignature();
        if (_recover(validation.proposalHash, proposalSignature) != proposal.solver) revert InvalidSignature();
        if (usedProposals[validation.proposalHash]) revert ProposalAlreadyUsed();
        if (proposal.intentHash != validation.intentHash) revert IntentProposalMismatch();
        if (proposal.solver == address(0)) revert InvalidAddress();
        if (
            proposal.traderInputToken != intent.traderInputToken
                || proposal.traderOutputToken != intent.traderOutputToken
        ) revert ProposalMismatch();
        validation.policy = policyRegistry.getPolicy(intent.policyId);
        if (validation.policy.paused) revert PolicyPaused();
        if (proposal.policyNonce != validation.policy.nonce) revert PolicyStateMismatch();
        if (validation.policy.fee.treasuryFeeRecipient != validation.policy.treasury) {
            revert FeeAccountingMismatch();
        }
        if (proposal.feePaymentMode != FEE_PAYMENT_OUTPUT_TOKEN) {
            revert FeePaymentModeUnsupported(proposal.feePaymentMode);
        }
        if (proposal.feeToken != intent.traderOutputToken) revert FeeAccountingMismatch();
        AurkaPolicyRegistry.SettlementConfiguration memory configuration =
            policyRegistry.settlementConfiguration(intent.policyId, intent.positionIdHash);
        if (
            proposal.aquaStrategyHash != configuration.aquaStrategyHash
                || epoch.aquaStrategyHash != configuration.aquaStrategyHash
                || intent.aquaStrategyHash != configuration.aquaStrategyHash
        ) revert StrategyNotAuthorized();
        bytes32 riskHash = _effectiveRiskHash(intent.policyId);
        if (proposal.riskCertificateHash != riskHash || epoch.riskCertificateHash != riskHash) {
            revert PolicyStateMismatch();
        }
        uint256 maximumTransactionValue = riskRegistry.effectiveMaximumTradeValue(intent.policyId);
        if (maximumTransactionValue == 0) revert PolicyPaused();
        tradeMath.validateEpoch(
            epoch,
            intent.positionIdHash,
            intent.traderInputToken,
            intent.traderOutputToken,
            intent.balanceSnapshot,
            intent.priceSnapshot,
            proposal.policyNonce,
            riskHash,
            proposal.aquaStrategyHash,
            proposal.capacityEpochId,
            proposal.capacityBaselineValue,
            proposal.consumedBefore
        );
        bytes32 capacityKey =
            _directionKey(intent.positionIdHash, intent.traderInputToken, intent.traderOutputToken);
        CapacityState memory state = _capacity[capacityKey];
        if (
            state.capacityEpochId != epoch.capacityEpochId
                || state.capacityBaselineValue != epoch.capacityBaseline
                || state.consumedValue != epoch.consumedBefore
        ) revert CapacityEpochNotActive(intent.positionIdHash, intent.traderInputToken, intent.traderOutputToken);
        (
            validation.tokens,
            validation.balancesBefore,
            validation.authoritativeAssets,
            validation.portfolioPriceSnapshot
        ) = _validateAssetsAndSnapshot(intent, proposal, assets, epoch, priceInput, capacityKey, state);
        if (
            keccak256(abi.encode(assets)) != proposal.initialPortfolioHash
                || keccak256(abi.encode(validation.authoritativeAssets)) != proposal.initialPortfolioHash
        ) revert InitialPortfolioMismatch();
        (validation.treasuryInputValue, validation.treasuryOutputValue) =
            PriceProtection.assertSettlementPricesAt(priceInput, uint64(block.timestamp));
        if (
            priceInput.traderInputAmount != proposal.traderInputAmount
                || priceInput.traderOutputAmount
                    != proposal.traderOutputAmount + proposal.solverFeeAmount + proposal.protocolFeeAmount
        ) revert ProposalMismatch();
        if (
            validation.treasuryInputValue != proposal.traderInputValue
                || validation.treasuryOutputValue != proposal.treasuryOutputValue
        ) revert ProposalMismatch();
        if (
            priceInput.traderInputToken != intent.traderInputToken
                || priceInput.traderOutputToken != intent.traderOutputToken
                || priceSnapshotHash(priceInput) != intent.priceSnapshot
                || proposal.priceSnapshotHash != intent.priceSnapshot
        ) revert PolicyStateMismatch();
        settlementAuthority.validateDirectProgram(
            directProgram,
            keccak256(directProgram),
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
            validation.intentHash
        );
        OptionSpaceFee.FeeConfig memory fee = _feeConfig(validation.policy.fee);
        validation.fill = tradeMath.maximumSafeFill(
            validation.authoritativeAssets,
            intent.traderInputToken,
            intent.traderOutputToken,
            intent.requestedValue,
            maximumTransactionValue,
            epoch.capacityBaseline,
            epoch.consumedBefore,
            fee,
            priceInput,
            epoch,
            uint64(block.timestamp)
        );
        tradeMath.validateFill(
            proposal.traderInputValue,
            proposal.traderOutputValue,
            proposal.treasuryOutputValue,
            proposal.feeBpsScaled,
            proposal.baseFeeAmount,
            proposal.treasuryBaseFeeAmount,
            proposal.optionSpacePremiumAmount,
            proposal.totalFeeAmount,
            proposal.treasuryAmount,
            proposal.solverAmount,
            proposal.protocolAmount,
            proposal.utilizationBefore,
            proposal.utilizationAfter,
            proposal.bindingConstraint,
            proposal.bindingAsset,
            proposal.consumedBefore,
            proposal.consumedAfter,
            validation.fill
        );
        tradeMath.validateRawOutputAmounts(
            proposal.traderOutputAmount,
            proposal.solverFeeAmount,
            proposal.protocolFeeAmount,
            priceInput,
            validation.fill
        );
        if (intent.exactInput && validation.fill.maximumSafeFill != intent.requestedValue) {
            revert ExactInputNotSatisfied(intent.requestedValue, validation.fill.maximumSafeFill);
        }
        if (!intent.allowPartialFill && validation.fill.maximumSafeFill != intent.requestedValue) {
            revert ExactInputNotSatisfied(intent.requestedValue, validation.fill.maximumSafeFill);
        }
        if (validation.fill.traderOutputValue < intent.minimumTraderOutputValue) {
            revert MinimumOutputNotSatisfied(intent.minimumTraderOutputValue, validation.fill.traderOutputValue);
        }
        if (
            validation.fill.maximumSafeFill != validation.treasuryInputValue
                || validation.fill.treasuryOutputValue != validation.treasuryOutputValue
        ) revert ProposalMismatch();
        if (keccak256(abi.encode(validation.fill.postTrade)) != proposal.expectedPostStateHash) {
            revert ProposalMismatch();
        }
    }

    function _validateAssetsAndSnapshot(
        Intent calldata intent,
        Proposal calldata proposal,
        PortfolioBounds.AssetState[] calldata assets,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput,
        bytes32 capacityKey,
        CapacityState memory state
    )
        private
        view
        returns (
            address[] memory tokens,
            uint256[] memory balancesBefore,
            PortfolioBounds.AssetState[] memory authoritativeAssets,
            bytes32 portfolioPriceSnapshot
        )
    {
        (tokens, balancesBefore, authoritativeAssets, portfolioPriceSnapshot) = settlementAuthority
            .authoritativePortfolio(intent.policyId, intent.positionIdHash, proposal.aquaStrategyHash, priceInput);
        if (tokens.length != assets.length || proposal.balancesHash != intent.balanceSnapshot) {
            revert PolicyStateMismatch();
        }
        if (epoch.portfolioPriceSnapshot != portfolioPriceSnapshot) {
            revert PortfolioPriceSnapshotMismatch();
        }
        for (uint256 i; i < tokens.length; ++i) {
            if (
                assets[i].token != authoritativeAssets[i].token
                    || assets[i].minimumWeightBps != authoritativeAssets[i].minimumWeightBps
                    || assets[i].maximumWeightBps != authoritativeAssets[i].maximumWeightBps
            ) revert PolicyStateMismatch();
        }
        bytes32 balanceSnapshot = keccak256(abi.encode(tokens, balancesBefore));
        if (state.consumedValue == 0) {
            if (balanceSnapshot != intent.balanceSnapshot || epoch.balanceSnapshot != balanceSnapshot) {
                revert PolicyStateMismatch();
            }
        } else {
            for (uint256 i; i < tokens.length; ++i) {
                if (_epochBalances[capacityKey][tokens[i]] != balancesBefore[i]) {
                    revert PolicyStateMismatch();
                }
            }
        }
    }

    function portfolioPriceSnapshotHash(bytes32 policyId, bytes32 positionIdHash)
        external
        view
        returns (bytes32)
    {
        return settlementAuthority.portfolioPriceSnapshot(policyId, positionIdHash);
    }

    function _executeUpstreamSwapVM(
        address treasury,
        Intent calldata intent,
        Proposal calldata proposal,
        PriceProtection.SettlementInput calldata priceInput,
        uint256 makerTraits,
        bytes calldata orderData,
        bytes calldata takerTraitsAndData
    ) private {
        if (aquaApp != address(swapVM)) revert SwapVMExecutionMismatch();
        IERC20Minimal inputToken = IERC20Minimal(intent.traderInputToken);
        uint256 executorInputBefore = inputToken.balanceOf(address(upstreamExecutor));
        if (!inputToken.transferFrom(intent.trader, address(upstreamExecutor), proposal.traderInputAmount)) {
            revert TokenTransferFailed(intent.traderInputToken);
        }
        uint256 executorInputAfter = inputToken.balanceOf(address(upstreamExecutor));
        if (executorInputAfter != executorInputBefore + proposal.traderInputAmount) {
            revert TokenBalanceMismatch(
                intent.traderInputToken,
                executorInputBefore + proposal.traderInputAmount,
                executorInputAfter
            );
        }
        (bytes32 orderHash, uint256 amountIn, uint256 amountOut) = upstreamExecutor.execute(
            treasury,
            intent.trader,
            proposal.solver,
            intent.traderInputToken,
            intent.traderOutputToken,
            intent.policyId,
            proposal.aquaStrategyHash,
            proposal.traderInputAmount,
            proposal.traderOutputAmount,
            proposal.solverFeeAmount,
            proposal.protocolFeeAmount,
            priceInput.traderOutputAmount,
            proposal.traderInputValue,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            proposal.deadline,
            makerTraits,
            orderData,
            takerTraitsAndData
        );
        emit UpstreamSwapVMExecuted(
            orderHash,
            hashProposal(proposal),
            treasury,
            intent.traderInputToken,
            intent.traderOutputToken,
            amountIn,
            amountOut,
            keccak256(orderData)
        );
    }

    function _assertFinalAquaBalances(
        address treasury,
        bytes32 strategyHash,
        address[] memory tokens,
        uint256[] memory balancesBefore,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount
    ) private view {
        for (uint256 i; i < tokens.length; ++i) {
            (uint248 actual,) = aqua.rawBalances(treasury, aquaApp, strategyHash, tokens[i]);
            uint256 expected = balancesBefore[i];
            if (tokens[i] == inputToken) expected += inputAmount;
            if (tokens[i] == outputToken) {
                if (expected < outputAmount) revert AquaBalanceMismatch(tokens[i], 0, actual);
                expected -= outputAmount;
            }
            if (actual != expected) revert AquaBalanceMismatch(tokens[i], expected, actual);
        }
    }

    function _assertFinalAuthoritativePortfolio(
        bytes32 policyId,
        bytes32 positionIdHash,
        bytes32 strategyHash,
        PriceProtection.SettlementInput calldata priceInput,
        bytes32 expectedPortfolioPriceSnapshot,
        bytes32 expectedPostStateHash
    ) private view {
        (,, PortfolioBounds.AssetState[] memory assets, bytes32 portfolioPriceSnapshot) =
            settlementAuthority.authoritativePortfolio(policyId, positionIdHash, strategyHash, priceInput);
        if (portfolioPriceSnapshot != expectedPortfolioPriceSnapshot) {
            revert PortfolioPriceSnapshotMismatch();
        }
        if (
            keccak256(abi.encode(assets)) != expectedPostStateHash
                || !tradeMath.isWithinBounds(assets)
        ) revert ProposalMismatch();
    }

    function _effectiveRiskHash(bytes32 policyId) private view returns (bytes32) {
        if (!riskRegistry.isRiskActive(policyId)) return bytes32(0);
        return riskRegistry.rawActiveRisk(policyId).certificateHash;
    }

    function _feeConfig(AurkaPolicyRegistry.FeeConfig memory fee)
        private
        pure
        returns (OptionSpaceFee.FeeConfig memory)
    {
        return OptionSpaceFee.FeeConfig({
            baseFeeBps: fee.baseFeeBps,
            slopeBps: fee.slopeBps,
            maximumFeeBps: fee.maximumFeeBps,
            treasuryBaseFeeBps: fee.treasuryBaseFeeBps,
            solverFeeBps: fee.solverFeeBps,
            protocolFeeBps: fee.protocolFeeBps
        });
    }

    function _recover(bytes32 digest, bytes calldata signature)
        private
        pure
        returns (address signer)
    {
        if (signature.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (
            uint256(s)
                > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
        ) revert InvalidSignatureS();
        if (v != 27 && v != 28) revert InvalidSignatureV();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _tokenFromId(bytes32 tokenId) private pure returns (address) {
        return address(uint160(uint256(tokenId)));
    }

    function _directionKey(bytes32 positionIdHash, address inputToken, address outputToken)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(positionIdHash, inputToken, outputToken));
    }
}
