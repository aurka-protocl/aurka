// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "./AurkaPolicyRegistry.sol";

/// @title AURKA Risk Mode Registry
/// @notice Applies short-lived, signed limits that can only tighten a hard treasury policy.
contract RiskModeRegistry {
    enum RiskMode {
        NORMAL,
        CAUTIOUS,
        SHOCK,
        PAUSED
    }

    struct ActiveAssetBound {
        address token;
        uint16 minimumWeightBps;
        uint16 maximumWeightBps;
        bool paused;
    }

    struct RiskCertificate {
        bytes32 policyId;
        RiskMode riskMode;
        bytes32 activeBoundsHash;
        uint256 maximumTradeValue;
        bytes32 sourceDigest;
        bytes32 reasonCode;
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 nonce;
        address watchtower;
        uint256 watchtowerAuthorizationEpoch;
        uint256 policyNonce;
    }

    struct ActiveRisk {
        RiskMode riskMode;
        uint256 maximumTradeValue;
        bytes32 sourceDigest;
        bytes32 reasonCode;
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 nonce;
        address watchtower;
        uint256 watchtowerAuthorizationEpoch;
        uint256 policyNonce;
        bytes32 certificateHash;
        bool exists;
    }

    bytes32 public constant RISK_CERTIFICATE_TYPEHASH = keccak256(
        "RiskCertificate(bytes32 policyId,uint8 riskMode,bytes32 activeBoundsHash,uint256 maximumTradeValue,bytes32 sourceDigest,bytes32 reasonCode,uint64 issuedAt,uint64 expiresAt,uint256 nonce,address watchtower,uint256 watchtowerAuthorizationEpoch,uint256 policyNonce)"
    );
    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("AURKA RiskModeRegistry");
    // Version 2 binds signatures to the policy and watchtower authorization state.
    bytes32 private constant VERSION_HASH = keccak256("2");
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    AurkaPolicyRegistry public immutable policyRegistry;

    mapping(bytes32 policyId => mapping(address watchtower => bool authorized)) public isWatchtower;
    mapping(bytes32 policyId => mapping(address watchtower => uint256 epoch)) public
        watchtowerAuthorizationEpoch;
    mapping(bytes32 policyId => uint256 nonce) public lastNonce;
    mapping(bytes32 policyId => ActiveRisk risk) private _activeRisk;
    mapping(bytes32 policyId => mapping(address token => ActiveAssetBound bound)) private
        _activeBounds;

    error ActiveBoundsHashMismatch();
    error AssetOrderMismatch(uint256 index, address expected, address actual);
    error CertificateExpired(uint64 expiresAt);
    error CertificateFromFuture(uint64 issuedAt);
    error InvalidNonce(uint256 expected, uint256 actual);
    error InvalidSignature();
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error InvalidActivePortfolioBounds(uint256 minimumTotalBps, uint256 maximumTotalBps);
    error NotGovernance(bytes32 policyId, address caller);
    error NotWatchtower(bytes32 policyId, address caller);
    error RiskCannotWidenAsset(address token);
    error RiskCannotWidenTransactionLimit(uint256 proposed, uint256 hardLimit);
    error WrongAssetCount(uint256 expected, uint256 actual);
    error PausedCertificateMustHaveZeroCapacity();
    error CertificateAuthorizationEpochMismatch(uint256 expected, uint256 actual);
    error CertificatePolicyNonceMismatch(uint256 expected, uint256 actual);

    event WatchtowerAuthorizationChanged(
        bytes32 indexed policyId, address indexed watchtower, bool authorized
    );
    event RiskModeChanged(
        bytes32 indexed policyId,
        RiskMode indexed riskMode,
        uint256 maximumTradeValue,
        uint64 expiresAt,
        uint256 nonce,
        address indexed watchtower,
        bytes32 certificateHash
    );

    constructor(AurkaPolicyRegistry policyRegistry_) {
        policyRegistry = policyRegistry_;
    }

    function setWatchtower(bytes32 policyId, address watchtower, bool authorized) external {
        if (msg.sender != policyRegistry.governanceOf(policyId)) {
            revert NotGovernance(policyId, msg.sender);
        }
        if (isWatchtower[policyId][watchtower] != authorized) {
            ++watchtowerAuthorizationEpoch[policyId][watchtower];
        }
        isWatchtower[policyId][watchtower] = authorized;
        emit WatchtowerAuthorizationChanged(policyId, watchtower, authorized);
    }

    function submitRiskCertificate(
        RiskCertificate calldata certificate,
        ActiveAssetBound[] calldata activeBounds,
        bytes calldata signature
    ) external returns (bytes32 certificateHash) {
        bytes32 policyId = certificate.policyId;
        if (!isWatchtower[policyId][certificate.watchtower]) {
            revert NotWatchtower(policyId, certificate.watchtower);
        }
        uint256 currentAuthorizationEpoch =
            watchtowerAuthorizationEpoch[policyId][certificate.watchtower];
        if (certificate.watchtowerAuthorizationEpoch != currentAuthorizationEpoch) {
            revert CertificateAuthorizationEpochMismatch(
                currentAuthorizationEpoch, certificate.watchtowerAuthorizationEpoch
            );
        }
        uint256 currentPolicyNonce = policyRegistry.policyNonce(policyId);
        if (certificate.policyNonce != currentPolicyNonce) {
            revert CertificatePolicyNonceMismatch(currentPolicyNonce, certificate.policyNonce);
        }
        if (certificate.issuedAt > block.timestamp) {
            revert CertificateFromFuture(certificate.issuedAt);
        }
        if (
            certificate.expiresAt <= block.timestamp
                || certificate.expiresAt <= certificate.issuedAt
        ) {
            revert CertificateExpired(certificate.expiresAt);
        }
        uint256 expectedNonce = lastNonce[policyId] + 1;
        if (certificate.nonce != expectedNonce) {
            revert InvalidNonce(expectedNonce, certificate.nonce);
        }
        if (keccak256(abi.encode(activeBounds)) != certificate.activeBoundsHash) {
            revert ActiveBoundsHashMismatch();
        }

        certificateHash = hashTypedData(certificate);
        if (_recover(certificateHash, signature) != certificate.watchtower) {
            revert InvalidSignature();
        }
        _validateTightening(certificate, activeBounds);

        for (uint256 i; i < activeBounds.length; ++i) {
            _activeBounds[policyId][activeBounds[i].token] = activeBounds[i];
        }
        _activeRisk[policyId] = ActiveRisk({
            riskMode: certificate.riskMode,
            maximumTradeValue: certificate.maximumTradeValue,
            sourceDigest: certificate.sourceDigest,
            reasonCode: certificate.reasonCode,
            issuedAt: certificate.issuedAt,
            expiresAt: certificate.expiresAt,
            nonce: certificate.nonce,
            watchtower: certificate.watchtower,
            watchtowerAuthorizationEpoch: certificate.watchtowerAuthorizationEpoch,
            policyNonce: certificate.policyNonce,
            certificateHash: certificateHash,
            exists: true
        });
        lastNonce[policyId] = certificate.nonce;

        emit RiskModeChanged(
            policyId,
            certificate.riskMode,
            certificate.maximumTradeValue,
            certificate.expiresAt,
            certificate.nonce,
            certificate.watchtower,
            certificateHash
        );
    }

    function hashTypedData(RiskCertificate calldata certificate) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RISK_CERTIFICATE_TYPEHASH,
                certificate.policyId,
                certificate.riskMode,
                certificate.activeBoundsHash,
                certificate.maximumTradeValue,
                certificate.sourceDigest,
                certificate.reasonCode,
                certificate.issuedAt,
                certificate.expiresAt,
                certificate.nonce,
                certificate.watchtower,
                certificate.watchtowerAuthorizationEpoch,
                certificate.policyNonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @notice Returns the stored certificate without applying expiry or authorization state.
    function rawActiveRisk(bytes32 policyId) external view returns (ActiveRisk memory) {
        return _activeRisk[policyId];
    }

    /// @notice Returns whether the stored certificate is currently effective.
    function isRiskActive(bytes32 policyId) external view returns (bool) {
        ActiveRisk storage risk = _activeRisk[policyId];
        return _isActive(policyId, risk);
    }

    function currentRiskMode(bytes32 policyId) public view returns (RiskMode) {
        if (policyRegistry.isPaused(policyId)) return RiskMode.PAUSED;
        ActiveRisk storage risk = _activeRisk[policyId];
        if (!_isActive(policyId, risk)) return RiskMode.NORMAL;
        return risk.riskMode;
    }

    function effectiveMaximumTradeValue(bytes32 policyId) external view returns (uint256) {
        if (currentRiskMode(policyId) == RiskMode.PAUSED) return 0;
        ActiveRisk storage risk = _activeRisk[policyId];
        uint256 hardMaximum = policyRegistry.maximumTransactionValue(policyId);
        if (!_isActive(policyId, risk)) return hardMaximum;
        return risk.maximumTradeValue < hardMaximum ? risk.maximumTradeValue : hardMaximum;
    }

    function effectiveAssetBound(bytes32 policyId, address token)
        external
        view
        returns (ActiveAssetBound memory)
    {
        AurkaPolicyRegistry.AssetBounds memory hard = policyRegistry.assetBounds(policyId, token);
        ActiveRisk storage risk = _activeRisk[policyId];
        ActiveAssetBound memory active = _activeBounds[policyId][token];
        if (!_isActive(policyId, risk) || active.token == address(0)) {
            return ActiveAssetBound({
                token: token,
                minimumWeightBps: hard.minimumWeightBps,
                maximumWeightBps: hard.maximumWeightBps,
                paused: policyRegistry.isPaused(policyId)
            });
        }
        // A later hard-policy tightening always dominates an older certificate.
        if (hard.minimumWeightBps > active.minimumWeightBps) {
            active.minimumWeightBps = hard.minimumWeightBps;
        }
        if (hard.maximumWeightBps < active.maximumWeightBps) {
            active.maximumWeightBps = hard.maximumWeightBps;
        }
        active.paused =
            active.paused || risk.riskMode == RiskMode.PAUSED || policyRegistry.isPaused(policyId);
        return active;
    }

    function _validateTightening(
        RiskCertificate calldata certificate,
        ActiveAssetBound[] calldata activeBounds
    ) internal view {
        uint256 hardMaximumTrade = policyRegistry.maximumTransactionValue(certificate.policyId);
        if (certificate.maximumTradeValue > hardMaximumTrade) {
            revert RiskCannotWidenTransactionLimit(certificate.maximumTradeValue, hardMaximumTrade);
        }
        if (certificate.riskMode == RiskMode.PAUSED && certificate.maximumTradeValue != 0) {
            revert PausedCertificateMustHaveZeroCapacity();
        }
        uint256 count = policyRegistry.assetCount(certificate.policyId);
        if (activeBounds.length != count) revert WrongAssetCount(count, activeBounds.length);
        uint256 minimumTotal;
        uint256 maximumTotal;
        for (uint256 i; i < count; ++i) {
            address expected = policyRegistry.assetAt(certificate.policyId, i);
            ActiveAssetBound calldata active = activeBounds[i];
            if (active.token != expected) revert AssetOrderMismatch(i, expected, active.token);
            AurkaPolicyRegistry.AssetBounds memory hard =
                policyRegistry.assetBounds(certificate.policyId, expected);
            if (
                active.minimumWeightBps < hard.minimumWeightBps
                    || active.maximumWeightBps > hard.maximumWeightBps
                    || active.minimumWeightBps > active.maximumWeightBps
            ) revert RiskCannotWidenAsset(expected);
            minimumTotal += active.minimumWeightBps;
            maximumTotal += active.maximumWeightBps;
        }
        if (
            certificate.riskMode != RiskMode.PAUSED
                && (minimumTotal > 10_000 || maximumTotal < 10_000)
        ) {
            revert InvalidActivePortfolioBounds(minimumTotal, maximumTotal);
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
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
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }

    function _isActive(bytes32 policyId, ActiveRisk storage risk) private view returns (bool) {
        return risk.exists && risk.expiresAt > block.timestamp
            && isWatchtower[policyId][risk.watchtower]
            && risk.watchtowerAuthorizationEpoch
                == watchtowerAuthorizationEpoch[policyId][risk.watchtower]
            && risk.policyNonce == policyRegistry.policyNonce(policyId);
    }
}
