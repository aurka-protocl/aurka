// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "./AurkaPolicyRegistry.sol";
import { RiskModeRegistry } from "./RiskModeRegistry.sol";
import { IAqua } from "./interfaces/IAqua.sol";
import { DirectSettlement } from "./libraries/DirectSettlement.sol";
import { IPriceOracle } from "./libraries/IPriceOracle.sol";
import { OptionSpaceFee } from "./libraries/OptionSpaceFee.sol";
import { PortfolioBounds } from "./libraries/PortfolioBounds.sol";
import { PriceProtection } from "./libraries/PriceProtection.sol";

/// @title AURKA settlement authority
/// @notice Keeps oracle valuation and epoch-baseline derivation outside the
///         execution router while retaining one immutable authority boundary.
/// @dev The router deploys this contract and is its only caller. It reloads
///      policy, risk, Aqua balances, and the governance-bound oracle itself;
///      caller/solver supplied portfolio values are never trusted.
contract AurkaSettlementAuthority {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(bytes32 intentId,bytes32 policyId,bytes32 positionIdHash,address trader,address traderInputToken,address traderOutputToken,uint256 requestedValue,uint256 minimumTraderOutputValue,bool exactInput,bool allowPartialFill,uint256 deadline,uint256 nonce,bytes32 balanceSnapshot,bytes32 priceSnapshot,bytes32 aquaStrategyHash)"
    );
    bytes32 private constant PROPOSAL_TYPEHASH = keccak256(
        "Proposal(bytes32 intentHash,address solver,bytes32 balancesHash,bytes32 priceSnapshotHash,uint256 policyNonce,bytes32 riskCertificateHash,address traderInputToken,address traderOutputToken,uint256 traderInputAmount,uint256 traderOutputAmount,uint256 solverFeeAmount,uint256 protocolFeeAmount,uint256 traderInputValue,uint256 traderOutputValue,uint256 treasuryOutputValue,uint256 feeBpsScaled,uint256 baseFeeAmount,uint256 treasuryBaseFeeAmount,uint256 optionSpacePremiumAmount,uint256 totalFeeAmount,uint256 treasuryAmount,uint256 solverAmount,uint256 protocolAmount,address feeToken,uint8 feePaymentMode,bytes32 initialPortfolioHash,uint256 capacityBaselineValue,uint256 consumedBefore,uint256 consumedAfter,bytes32 capacityEpochId,uint256 utilizationBefore,uint256 utilizationAfter,uint8 bindingConstraint,address bindingAsset,bytes32 expectedPostStateHash,bytes32 aquaStrategyHash,bytes32 swapVMCalldataHash,uint256 deadline)"
    );
    bytes32 private constant NAME_HASH = keccak256("AURKA Direct Settlement");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant DIRECT_PROGRAM_ID = keccak256("AURKA_DIRECT_PAIR_V1");

    struct IntentData {
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

    struct ProposalData {
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

    AurkaPolicyRegistry public immutable policyRegistry;
    RiskModeRegistry public immutable riskRegistry;
    IAqua public immutable aqua;
    address public immutable router;

    error InvalidAddress();
    error PolicyStateMismatch();
    error StrategyNotAuthorized();
    error OracleSnapshotMismatch(address token);
    error SettlementDecimalMismatch();
    error UnauthorizedCaller();
    error DirectProgramMismatch();

    constructor(
        AurkaPolicyRegistry policyRegistry_,
        RiskModeRegistry riskRegistry_,
        IAqua aqua_,
        address router_
    ) {
        if (
            address(policyRegistry_) == address(0) || address(riskRegistry_) == address(0)
                || address(aqua_) == address(0) || router_ == address(0)
        ) revert InvalidAddress();
        policyRegistry = policyRegistry_;
        riskRegistry = riskRegistry_;
        aqua = aqua_;
        router = router_;
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert UnauthorizedCaller();
        _;
    }

    function domainSeparator() external view onlyRouter returns (bytes32) {
        return _domainSeparator();
    }

    function authoritativePortfolio(
        bytes32 policyId,
        bytes32 positionIdHash,
        bytes32 strategyHash,
        PriceProtection.SettlementInput calldata priceInput
    )
        external
        view
        onlyRouter
        returns (
            address[] memory tokens,
            uint256[] memory balancesBefore,
            PortfolioBounds.AssetState[] memory assets,
            bytes32 portfolioPriceSnapshotHash
        )
    {
        AurkaPolicyRegistry.Policy memory policy = policyRegistry.getPolicy(policyId);
        AurkaPolicyRegistry.SettlementConfiguration memory configuration =
            policyRegistry.settlementConfiguration(policyId, positionIdHash);
        if (configuration.aquaStrategyHash != strategyHash) revert StrategyNotAuthorized();
        _assertSettlementDecimals(policyId, priceInput);
        if (
            priceInput.maximumPriceAgeSeconds != policy.priceMaxAgeSeconds
                || priceInput.maximumPriceDeviationBps != policy.maximumPriceDeviationBps
        ) revert PolicyStateMismatch();
        PriceProtection.assertSettlementPricesAt(priceInput, uint64(block.timestamp));
        tokens = policyRegistry.assets(policyId);
        if (tokens.length < 2) revert PolicyStateMismatch();
        balancesBefore = new uint256[](tokens.length);
        assets = new PortfolioBounds.AssetState[](tokens.length);
        PriceProtection.Snapshot[] memory snapshots = new PriceProtection.Snapshot[](tokens.length);
        IPriceOracle oracle = IPriceOracle(configuration.priceOracle);
        for (uint256 i; i < tokens.length; ++i) {
            (uint256 price, uint8 priceDecimals, uint64 observedAt, bytes32 snapshotId) =
                oracle.getPrice(tokens[i]);
            snapshots[i] =
                PriceProtection.Snapshot(tokens[i], snapshotId, price, priceDecimals, observedAt);
            PriceProtection.assertFresh(
                observedAt, uint64(block.timestamp), policy.priceMaxAgeSeconds
            );
            if (tokens[i] == priceInput.traderInputToken) {
                _assertOracleSnapshot(snapshots[i], priceInput.traderInputExecutionPrice);
            }
            if (tokens[i] == priceInput.traderOutputToken) {
                _assertOracleSnapshot(snapshots[i], priceInput.traderOutputExecutionPrice);
            }
            AurkaPolicyRegistry.AssetBounds memory hard =
                policyRegistry.assetBounds(policyId, tokens[i]);
            RiskModeRegistry.ActiveAssetBound memory active =
                riskRegistry.effectiveAssetBound(policyId, tokens[i]);
            if (
                active.paused || hard.decimals > 36
                    || active.minimumWeightBps > active.maximumWeightBps
            ) revert PolicyStateMismatch();
            (uint248 balance, uint8 tokensCount) =
                aqua.rawBalances(policy.treasury, router, strategyHash, tokens[i]);
            if (tokensCount != 1) revert PolicyStateMismatch();
            balancesBefore[i] = balance;
            assets[i] = PortfolioBounds.AssetState({
                token: tokens[i],
                value: PortfolioBounds.normalizeValue(
                    balance, hard.decimals, price, priceDecimals, priceInput.valueDecimals
                ),
                minimumWeightBps: active.minimumWeightBps,
                maximumWeightBps: active.maximumWeightBps
            });
        }
        portfolioPriceSnapshotHash = keccak256(abi.encode(tokens, snapshots));
    }

    function hashIntent(bytes calldata encodedIntent) external view onlyRouter returns (bytes32) {
        IntentData memory intent = abi.decode(encodedIntent, (IntentData));
        return _hashTypedData(
            keccak256(
                abi.encode(
                    INTENT_TYPEHASH,
                    intent.intentId,
                    intent.policyId,
                    intent.positionIdHash,
                    intent.trader,
                    intent.traderInputToken,
                    intent.traderOutputToken,
                    intent.requestedValue,
                    intent.minimumTraderOutputValue,
                    intent.exactInput,
                    intent.allowPartialFill,
                    intent.deadline,
                    intent.nonce,
                    intent.balanceSnapshot,
                    intent.priceSnapshot,
                    intent.aquaStrategyHash
                )
            )
        );
    }

    function hashProposal(bytes calldata encodedProposal)
        external
        view
        onlyRouter
        returns (bytes32)
    {
        ProposalData memory proposal = abi.decode(encodedProposal, (ProposalData));
        return _hashTypedData(
            keccak256(
                abi.encode(
                    PROPOSAL_TYPEHASH,
                    proposal.intentHash,
                    proposal.solver,
                    proposal.balancesHash,
                    proposal.priceSnapshotHash,
                    proposal.policyNonce,
                    proposal.riskCertificateHash,
                    proposal.traderInputToken,
                    proposal.traderOutputToken,
                    proposal.traderInputAmount,
                    proposal.traderOutputAmount,
                    proposal.solverFeeAmount,
                    proposal.protocolFeeAmount,
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
                    proposal.feeToken,
                    proposal.feePaymentMode,
                    proposal.initialPortfolioHash,
                    proposal.capacityBaselineValue,
                    proposal.consumedBefore,
                    proposal.consumedAfter,
                    proposal.capacityEpochId,
                    proposal.utilizationBefore,
                    proposal.utilizationAfter,
                    proposal.bindingConstraint,
                    proposal.bindingAsset,
                    proposal.expectedPostStateHash,
                    proposal.aquaStrategyHash,
                    proposal.swapVMCalldataHash,
                    proposal.deadline
                )
            )
        );
    }

    /// @notice Validates the only direct program accepted by the settlement router.
    /// @dev Kept in the authority contract so router hardening does not consume
    ///      the router's EIP-170 deployment headroom.
    function validateDirectProgram(
        bytes calldata directProgram,
        bytes32 expectedProgramHash,
        bytes32 policyId,
        bytes32 expectedPositionIdHash,
        address expectedTrader,
        address expectedInputToken,
        address expectedOutputToken,
        bytes32 expectedStrategyHash,
        uint256 expectedInputAmount,
        uint256 expectedTraderOutputAmount,
        uint256 expectedSolverFeeAmount,
        uint256 expectedProtocolFeeAmount,
        uint256 expectedInputValue,
        uint256 expectedTraderOutputValue,
        uint256 expectedTreasuryOutputValue,
        bytes32 expectedCapacityEpochId,
        bytes32 intentHash
    ) external view onlyRouter {
        if (keccak256(directProgram) != expectedProgramHash) {
            revert DirectProgramMismatch();
        }
        (
            bytes32 programId,
            bytes32 programPolicyId,
            bytes32 programPositionIdHash,
            address programTrader,
            address programInputToken,
            address programOutputToken,
            bytes32 programStrategyHash,
            uint256 programInputAmount,
            uint256 programTraderOutputAmount,
            uint256 programSolverFeeAmount,
            uint256 programProtocolFeeAmount,
            uint256 programInputValue,
            uint256 programTraderOutputValue,
            uint256 programTreasuryOutputValue,
            bytes32 programCapacityEpochId,
            bytes32 committedIntentHash
        ) = abi.decode(
            directProgram,
            (
                bytes32,
                bytes32,
                bytes32,
                address,
                address,
                address,
                bytes32,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                bytes32,
                bytes32
            )
        );
        if (
            programId != DIRECT_PROGRAM_ID || programPolicyId != policyId
                || programPositionIdHash != expectedPositionIdHash || programTrader != expectedTrader
                || programInputToken != expectedInputToken || programOutputToken != expectedOutputToken
                || programStrategyHash != expectedStrategyHash
                || programInputAmount != expectedInputAmount
                || programTraderOutputAmount != expectedTraderOutputAmount
                || programSolverFeeAmount != expectedSolverFeeAmount
                || programProtocolFeeAmount != expectedProtocolFeeAmount
                || programInputValue != expectedInputValue
                || programTraderOutputValue != expectedTraderOutputValue
                || programTreasuryOutputValue != expectedTreasuryOutputValue
                || programCapacityEpochId != expectedCapacityEpochId
                || committedIntentHash != intentHash
        ) revert DirectProgramMismatch();
    }

    function portfolioPriceSnapshot(bytes32 policyId, bytes32 positionIdHash)
        external
        view
        onlyRouter
        returns (bytes32)
    {
        AurkaPolicyRegistry.SettlementConfiguration memory configuration =
            policyRegistry.settlementConfiguration(policyId, positionIdHash);
        address[] memory tokens = policyRegistry.assets(policyId);
        PriceProtection.Snapshot[] memory snapshots = new PriceProtection.Snapshot[](tokens.length);
        IPriceOracle oracle = IPriceOracle(configuration.priceOracle);
        for (uint256 i; i < tokens.length; ++i) {
            (uint256 price, uint8 priceDecimals, uint64 observedAt, bytes32 snapshotId) =
                oracle.getPrice(tokens[i]);
            snapshots[i] =
                PriceProtection.Snapshot(tokens[i], snapshotId, price, priceDecimals, observedAt);
        }
        return keccak256(abi.encode(tokens, snapshots));
    }

    function deriveCapacityBaseline(
        bytes32 policyId,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput,
        PortfolioBounds.AssetState[] calldata assets
    ) external view onlyRouter returns (uint256) {
        AurkaPolicyRegistry.Policy memory policy = policyRegistry.getPolicy(policyId);
        _assertSettlementDecimals(policyId, priceInput);
        uint256 maximum = policy.maximumTransactionValue;
        uint256 riskMaximum = riskRegistry.effectiveMaximumTradeValue(policyId);
        if (riskMaximum < maximum) maximum = riskMaximum;
        if (maximum == 0) return 0;
        DirectSettlement.CapacityEpoch memory upper = epoch;
        upper.capacityBaseline = maximum;
        upper.consumedBefore = 0;
        upper.capacityEpochId = DirectSettlement.capacityEpochId(upper);
        DirectSettlement.FillResult memory fill = DirectSettlement.maximumSafeFill(
            assets,
            _tokenFromId(epoch.traderInputTokenId),
            _tokenFromId(epoch.traderOutputTokenId),
            type(uint256).max,
            maximum,
            maximum,
            0,
            _feeConfig(policy.fee),
            priceInput,
            upper,
            uint64(block.timestamp)
        );
        return fill.maximumSafeFill;
    }

    function _assertOracleSnapshot(
        PriceProtection.Snapshot memory oracleSnapshot,
        PriceProtection.Snapshot calldata suppliedSnapshot
    ) private pure {
        if (
            oracleSnapshot.token != suppliedSnapshot.token
                || oracleSnapshot.snapshotId != suppliedSnapshot.snapshotId
                || oracleSnapshot.price != suppliedSnapshot.price
                || oracleSnapshot.priceDecimals != suppliedSnapshot.priceDecimals
                || oracleSnapshot.observedAt != suppliedSnapshot.observedAt
        ) revert OracleSnapshotMismatch(oracleSnapshot.token);
    }

    function _assertSettlementDecimals(
        bytes32 policyId,
        PriceProtection.SettlementInput calldata priceInput
    ) private view {
        AurkaPolicyRegistry.AssetBounds memory inputBounds =
            policyRegistry.assetBounds(policyId, priceInput.traderInputToken);
        AurkaPolicyRegistry.AssetBounds memory outputBounds =
            policyRegistry.assetBounds(policyId, priceInput.traderOutputToken);
        if (
            priceInput.traderInputDecimals != inputBounds.decimals
                || priceInput.traderOutputDecimals != outputBounds.decimals
                || priceInput.valueDecimals != policyRegistry.SETTLEMENT_VALUE_DECIMALS()
        ) revert SettlementDecimalMismatch();
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

    function _tokenFromId(bytes32 tokenId) private pure returns (address) {
        return address(uint160(uint256(tokenId)));
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _domainSeparator() private view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, router));
    }
}
