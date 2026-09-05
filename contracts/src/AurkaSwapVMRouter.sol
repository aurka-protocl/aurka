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

/// @title AURKA direct Aqua settlement router
/// @notice Atomic, single-route settlement for one signed trader intent.
/// @dev The router delegates the allowlisted direct program to the configured
///      ISwapVM boundary before performing the exact Aqua accounting legs.
contract AurkaSwapVMRouter {
    uint8 public constant FEE_PAYMENT_OUTPUT_TOKEN = 0;
    bytes32 public constant DIRECT_PROGRAM_ID = keccak256("AURKA_DIRECT_PAIR_V1");
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

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
    error DirectProgramMismatch();
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
    error PriceTimeMismatch(uint64 committedTime, uint256 blockTime);
    error ProposalAlreadyUsed();
    error ProposalExpired(uint256 deadline);
    error ProposalMismatch();
    error Reentrancy();
    error TokenBalanceMismatch(address token, uint256 expected, uint256 actual);
    error TokenTransferFailed(address token);
    error UnsupportedAsset(address token);
    error OracleSnapshotMismatch(address token);
    error PortfolioPriceSnapshotMismatch();
    error StrategyNotAuthorized();
    error CapacityBaselineMismatch(uint256 expected, uint256 actual);
    error SwapVMExecutionMismatch();

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
    /// @dev Recipient amounts use normalized settlement-value units. Raw
    ///      output-token transfer amounts remain committed in the proposal.
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
        ISwapVM swapVM_
    ) {
        if (address(policyRegistry_) == address(0) || address(riskRegistry_) == address(0)) {
            revert InvalidAddress();
        }
        if (address(aqua_) == address(0)) revert InvalidAddress();
        if (address(swapVM_) == address(0)) revert InvalidAddress();
        policyRegistry = policyRegistry_;
        riskRegistry = riskRegistry_;
        aqua = aqua_;
        swapVM = swapVM_;
        settlementAuthority =
            new AurkaSettlementAuthority(policyRegistry_, riskRegistry_, aqua_, address(this));
    }

    /// @notice EIP-712 domain used by both signed object types.
    function domainSeparator() public view returns (bytes32) {
        return settlementAuthority.domainSeparator();
    }

    function hashIntent(Intent calldata intent) public view returns (bytes32) {
        return settlementAuthority.hashIntent(abi.encode(intent));
    }

    function hashProposal(Proposal calldata proposal) public view returns (bytes32) {
        return settlementAuthority.hashProposal(abi.encode(proposal));
    }

    /// @notice Hashes only stable price commitments, not fill-specific amounts.
    /// @dev This lets a split fill reuse one approved price epoch while each
    ///      proposal carries its own raw input/output amounts.
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

    /// @notice Governance or the treasury explicitly opens a fresh directional epoch.
    /// @dev A new snapshot is the only way to replace an old epoch; the same epoch
    ///      ID can never be reset to lower utilization.
    function activateCapacityEpoch(
        bytes32 policyId,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput
    ) external {
        AurkaPolicyRegistry.Policy memory policy = policyRegistry.getPolicy(policyId);
        if (msg.sender != policy.governance && msg.sender != policy.treasury) {
            revert PolicyStateMismatch();
        }
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
        bytes32 key = _directionKey(
            epoch.positionIdHash,
            _tokenFromId(epoch.traderInputTokenId),
            _tokenFromId(epoch.traderOutputTokenId)
        );
        CapacityState memory current = _capacity[key];
        bytes32 authorityHash = _authorityHash(policyId, epoch);
        if (
            current.capacityEpochId == epoch.capacityEpochId
                || (current.consumedValue != 0 && _epochAuthorityHashes[key] == authorityHash)
        ) {
            revert CapacityEpochStateMismatch();
        }
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

    /// @notice Executes one allowlisted direct pair route atomically.
    function execute(
        Intent calldata intent,
        bytes calldata intentSignature,
        Proposal calldata proposal,
        bytes calldata proposalSignature,
        PortfolioBounds.AssetState[] calldata assets,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput,
        bytes calldata directProgram
    )
        external
        nonReentrant
        returns (bytes32 intentHash, bytes32 proposalHash, uint256 executedValue)
    {
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
        _executeSwapVM(
            validation.policy.treasury,
            proposal,
            directProgram,
            priceInput.traderInputAmount,
            priceInput.traderOutputAmount
        );

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

        _settleTokens(intent, proposal, validation.policy.treasury);
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
            if (validation.tokens[i] == intent.traderInputToken) {
                expected += priceInput.traderInputAmount;
            }
            if (validation.tokens[i] == intent.traderOutputToken) {
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
        if (_recover(validation.intentHash, intentSignature) != intent.trader) {
            revert InvalidSignature();
        }
        if (_recover(validation.proposalHash, proposalSignature) != proposal.solver) {
            revert InvalidSignature();
        }
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

        _validateEpoch(intent, proposal, epoch, riskHash);
        bytes32 capacityKey =
            _directionKey(intent.positionIdHash, intent.traderInputToken, intent.traderOutputToken);
        CapacityState memory state = _capacity[capacityKey];
        if (
            state.capacityEpochId != epoch.capacityEpochId
                || state.capacityBaselineValue != epoch.capacityBaseline
                || state.consumedValue != epoch.consumedBefore
        ) {
            revert CapacityEpochNotActive(
                intent.positionIdHash, intent.traderInputToken, intent.traderOutputToken
            );
        }
        (
            validation.tokens,
            validation.balancesBefore,
            validation.authoritativeAssets,
            validation.portfolioPriceSnapshot
        ) = _validateAssetsAndSnapshot(
            intent, proposal, assets, epoch, priceInput, capacityKey, state
        );
        if (
            keccak256(abi.encode(assets)) != proposal.initialPortfolioHash
                || keccak256(abi.encode(validation.authoritativeAssets))
                    != proposal.initialPortfolioHash
        ) {
            revert InitialPortfolioMismatch();
        }

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
            proposal.swapVMCalldataHash,
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
        validation.fill = DirectSettlement.maximumSafeFill(
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
        _compareFill(proposal, validation.fill);
        _compareRawOutputAmounts(priceInput, proposal, validation.fill);
        if (intent.exactInput && validation.fill.maximumSafeFill != intent.requestedValue) {
            revert ExactInputNotSatisfied(intent.requestedValue, validation.fill.maximumSafeFill);
        }
        if (!intent.allowPartialFill && validation.fill.maximumSafeFill != intent.requestedValue) {
            revert ExactInputNotSatisfied(intent.requestedValue, validation.fill.maximumSafeFill);
        }
        if (validation.fill.traderOutputValue < intent.minimumTraderOutputValue) {
            revert MinimumOutputNotSatisfied(
                intent.minimumTraderOutputValue, validation.fill.traderOutputValue
            );
        }
        if (
            validation.fill.maximumSafeFill != validation.treasuryInputValue
                || validation.fill.treasuryOutputValue != validation.treasuryOutputValue
        ) revert ProposalMismatch();
        if (keccak256(abi.encode(validation.fill.postTrade)) != proposal.expectedPostStateHash) {
            revert ProposalMismatch();
        }
    }

    function _validateEpoch(
        Intent calldata intent,
        Proposal calldata proposal,
        DirectSettlement.CapacityEpoch calldata epoch,
        bytes32 riskHash
    ) private view {
        if (
            epoch.positionIdHash != intent.positionIdHash
                || epoch.traderInputTokenId != _tokenId(intent.traderInputToken)
                || epoch.traderOutputTokenId != _tokenId(intent.traderOutputToken)
                || epoch.balanceSnapshot != intent.balanceSnapshot
                || epoch.priceSnapshot != intent.priceSnapshot
                || epoch.portfolioPriceSnapshot == bytes32(0)
                || epoch.policyNonce != proposal.policyNonce || epoch.riskCertificateHash != riskHash
                || epoch.aquaStrategyHash != proposal.aquaStrategyHash || epoch.chainId != block.chainid
                || epoch.verifyingContract != address(this)
                || epoch.capacityEpochId != DirectSettlement.capacityEpochId(epoch)
                || proposal.capacityEpochId != epoch.capacityEpochId
                || proposal.capacityBaselineValue != epoch.capacityBaseline
                || proposal.consumedBefore != epoch.consumedBefore
        ) revert InvalidCapacityEpoch();
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
            .authoritativePortfolio(
            intent.policyId, intent.positionIdHash, proposal.aquaStrategyHash, priceInput
        );
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
            if (
                balanceSnapshot != intent.balanceSnapshot
                    || epoch.balanceSnapshot != balanceSnapshot
            ) {
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

    /// @notice Returns the committed price set for every managed portfolio asset.
    function portfolioPriceSnapshotHash(bytes32 policyId, bytes32 positionIdHash)
        external
        view
        returns (bytes32)
    {
        return settlementAuthority.portfolioPriceSnapshot(policyId, positionIdHash);
    }

    function _authorityHash(bytes32 policyId, DirectSettlement.CapacityEpoch calldata epoch)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                policyId,
                epoch.positionIdHash,
                epoch.traderInputTokenId,
                epoch.traderOutputTokenId,
                epoch.balanceSnapshot,
                epoch.priceSnapshot,
                epoch.portfolioPriceSnapshot,
                epoch.policyNonce,
                epoch.riskCertificateHash,
                epoch.aquaStrategyHash
            )
        );
    }

    function _compareFill(Proposal calldata proposal, DirectSettlement.FillResult memory fill)
        private
        pure
    {
        if (
            proposal.traderInputValue != fill.maximumSafeFill
                || proposal.traderOutputValue != fill.traderOutputValue
                || proposal.treasuryOutputValue != fill.treasuryOutputValue
                || proposal.feeBpsScaled != fill.fees.feeBpsScaled
                || proposal.baseFeeAmount != fill.fees.baseFeeAmount
                || proposal.treasuryBaseFeeAmount != fill.fees.treasuryBaseFeeAmount
                || proposal.optionSpacePremiumAmount != fill.fees.premiumAmount
                || proposal.totalFeeAmount != fill.fees.totalFeeAmount
                || proposal.treasuryAmount != fill.fees.treasuryAmount
                || proposal.solverAmount != fill.fees.solverAmount
                || proposal.protocolAmount != fill.fees.protocolAmount
                || proposal.utilizationBefore != fill.utilizationBefore
                || proposal.utilizationAfter != fill.utilizationAfter
                || proposal.bindingConstraint != uint8(fill.bindingConstraint)
                || proposal.bindingAsset != fill.bindingAsset
                || proposal.consumedAfter != proposal.consumedBefore + fill.maximumSafeFill
        ) revert ProposalMismatch();
    }

    function _compareRawOutputAmounts(
        PriceProtection.SettlementInput calldata priceInput,
        Proposal calldata proposal,
        DirectSettlement.FillResult memory fill
    ) private pure {
        uint256 traderOutputValue = PortfolioBounds.normalizeValue(
            proposal.traderOutputAmount,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            priceInput.valueDecimals
        );
        uint256 solverValue = PortfolioBounds.normalizeValue(
            proposal.solverFeeAmount,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            priceInput.valueDecimals
        );
        uint256 protocolValue = PortfolioBounds.normalizeValue(
            proposal.protocolFeeAmount,
            priceInput.traderOutputDecimals,
            priceInput.traderOutputExecutionPrice.price,
            priceInput.traderOutputExecutionPrice.priceDecimals,
            priceInput.valueDecimals
        );
        if (
            traderOutputValue != fill.traderOutputValue || solverValue != fill.fees.solverAmount
                || protocolValue != fill.fees.protocolAmount
                || traderOutputValue + solverValue + protocolValue != fill.treasuryOutputValue
        ) revert FeeAccountingMismatch();
    }

    function _executeSwapVM(
        address treasury,
        Proposal calldata proposal,
        bytes calldata directProgram,
        uint256 inputAmount,
        uint256 outputAmount
    ) private {
        ISwapVM.Order memory order = ISwapVM.Order({
            maker: treasury,
            traits: uint256(proposal.capacityEpochId),
            data: directProgram
        });
        bytes32 expectedOrderHash = swapVM.hash(order);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) =
            swapVM.swap(order, inputAmount, bytes(""));
        if (
            orderHash != expectedOrderHash || amountIn != inputAmount || amountOut != outputAmount
                || order.maker != treasury
        ) revert SwapVMExecutionMismatch();
    }

    function _settleTokens(Intent calldata intent, Proposal calldata proposal, address treasury)
        private
    {
        IERC20Minimal inputToken = IERC20Minimal(intent.traderInputToken);
        uint256 routerBefore = inputToken.balanceOf(address(this));
        _transferFrom(inputToken, intent.trader, address(this), proposal.traderInputAmount);
        uint256 routerAfter = inputToken.balanceOf(address(this));
        if (routerAfter != routerBefore + proposal.traderInputAmount) {
            revert TokenBalanceMismatch(
                intent.traderInputToken, routerBefore + proposal.traderInputAmount, routerAfter
            );
        }
        _approve(inputToken, address(aqua), proposal.traderInputAmount);
        aqua.push(
            treasury,
            address(this),
            proposal.aquaStrategyHash,
            intent.traderInputToken,
            proposal.traderInputAmount
        );
        _approve(inputToken, address(aqua), 0);
        if (inputToken.balanceOf(address(this)) != routerBefore) {
            revert TokenBalanceMismatch(
                intent.traderInputToken, routerBefore, inputToken.balanceOf(address(this))
            );
        }

        _pullExact(
            treasury,
            proposal.aquaStrategyHash,
            intent.traderOutputToken,
            proposal.traderOutputAmount,
            intent.trader
        );
        _pullExact(
            treasury,
            proposal.aquaStrategyHash,
            intent.traderOutputToken,
            proposal.solverFeeAmount,
            proposal.solver
        );
        _pullExact(
            treasury,
            proposal.aquaStrategyHash,
            intent.traderOutputToken,
            proposal.protocolFeeAmount,
            policyRegistry.feeConfiguration(intent.policyId).protocolFeeRecipient
        );
        // The final Aqua check below also proves that no fee share was omitted.
    }

    function _pullExact(
        address maker,
        bytes32 strategyHash,
        address token,
        uint256 amount,
        address to
    ) private {
        IERC20Minimal asset = IERC20Minimal(token);
        uint256 beforeBalance = asset.balanceOf(to);
        aqua.pull(maker, strategyHash, token, amount, to);
        uint256 afterBalance = asset.balanceOf(to);
        if (afterBalance != beforeBalance + amount) {
            revert TokenBalanceMismatch(token, beforeBalance + amount, afterBalance);
        }
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
            (uint248 actual,) = aqua.rawBalances(treasury, address(this), strategyHash, tokens[i]);
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
        settlementAuthority.authoritativePortfolio(
            policyId, positionIdHash, strategyHash, priceInput
        );
        if (portfolioPriceSnapshot != expectedPortfolioPriceSnapshot) {
            revert PortfolioPriceSnapshotMismatch();
        }
        if (
            keccak256(abi.encode(assets)) != expectedPostStateHash
                || !PortfolioBounds.isWithinBounds(assets)
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

    function _copyAssets(PortfolioBounds.AssetState[] calldata assets)
        private
        pure
        returns (PortfolioBounds.AssetState[] memory copy)
    {
        copy = new PortfolioBounds.AssetState[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            copy[i] = assets[i];
        }
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
        if (uint256(s) > SECP256K1_HALF_ORDER) revert InvalidSignatureS();
        if (v != 27 && v != 28) revert InvalidSignatureV();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _transferFrom(IERC20Minimal token, address from, address to, uint256 amount) private {
        if (!token.transferFrom(from, to, amount)) revert TokenTransferFailed(address(token));
    }

    function _approve(IERC20Minimal token, address spender, uint256 amount) private {
        if (!token.approve(spender, amount)) revert TokenTransferFailed(address(token));
    }

    function _tokenId(address token) private pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
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
