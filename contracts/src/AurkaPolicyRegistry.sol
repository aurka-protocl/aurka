// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AURKA Policy Registry
/// @notice Stores the immutable authority boundary and mutable hard portfolio limits.
/// @dev This contract does not custody tokens. Settlement and withdrawals belong to a later phase.
contract AurkaPolicyRegistry {
    uint16 public constant BASIS_POINTS = 10_000;
    uint16 public constant MAXIMUM_TOTAL_FEE_BPS = 100;
    uint8 public constant MAX_ASSETS = 32;
    /// @dev Settlement values use whole value units in both language implementations.
    uint8 public constant SETTLEMENT_VALUE_DECIMALS = 0;
    uint64 public constant DEFAULT_PRICE_MAX_AGE_SECONDS = 120;
    uint16 public constant DEFAULT_MAX_PRICE_DEVIATION_BPS = 100;

    struct AssetConfig {
        address token;
        uint8 decimals;
        uint16 minimumWeightBps;
        uint16 maximumWeightBps;
    }

    struct AssetBounds {
        uint8 decimals;
        uint16 minimumWeightBps;
        uint16 maximumWeightBps;
        bool managed;
    }

    struct FeeConfig {
        uint16 baseFeeBps;
        uint16 slopeBps;
        uint16 maximumFeeBps;
        uint16 treasuryBaseFeeBps;
        uint16 solverFeeBps;
        uint16 protocolFeeBps;
        address treasuryFeeRecipient;
        address protocolFeeRecipient;
    }

    struct Policy {
        address treasury;
        address governance;
        address pendingGovernance;
        uint256 maximumTransactionValue;
        uint256 nonce;
        uint64 priceMaxAgeSeconds;
        uint16 maximumPriceDeviationBps;
        bool paused;
        bool exists;
        FeeConfig fee;
    }

    struct SettlementConfiguration {
        bytes32 aquaStrategyHash;
        address priceOracle;
        bool exists;
    }

    error AlreadyExists(bytes32 policyId);
    error DuplicateAsset(address token);
    error InvalidAddress();
    error InvalidAssetCount();
    error InvalidAssetDecimals(uint8 decimals);
    error InvalidAssetWeights(address token, uint16 minimumWeightBps, uint16 maximumWeightBps);
    error InvalidFeeConfiguration();
    error InvalidMaximumTransactionValue(uint256 value);
    error InvalidPortfolioBounds(uint256 minimumTotalBps, uint256 maximumTotalBps);
    error NotGovernance(bytes32 policyId, address caller);
    error NotPendingGovernance(bytes32 policyId, address caller);
    error PolicyNotFound(bytes32 policyId);
    error UnsupportedAsset(bytes32 policyId, address token);
    error InvalidSettlementConfiguration();
    error InvalidPriceProtectionConfiguration();

    event PolicyCreated(
        bytes32 indexed policyId,
        address indexed treasury,
        address indexed governance,
        uint256 nonce
    );
    event AssetAdded(
        bytes32 indexed policyId,
        address indexed token,
        uint16 minimumWeightBps,
        uint16 maximumWeightBps,
        uint256 nonce
    );
    event AssetBoundsUpdated(
        bytes32 indexed policyId,
        address indexed token,
        uint16 minimumWeightBps,
        uint16 maximumWeightBps,
        uint256 nonce
    );
    event MaximumTransactionValueUpdated(
        bytes32 indexed policyId, uint256 maximumTransactionValue, uint256 nonce
    );
    event FeeConfigurationUpdated(bytes32 indexed policyId, uint256 nonce);
    event PauseStatusUpdated(bytes32 indexed policyId, bool paused, uint256 nonce);
    event TreasuryUpdated(
        bytes32 indexed policyId,
        address indexed oldTreasury,
        address indexed newTreasury,
        uint256 nonce
    );
    event GovernanceTransferStarted(
        bytes32 indexed policyId, address indexed governance, address indexed pendingGovernance
    );
    event GovernanceTransferred(
        bytes32 indexed policyId,
        address indexed oldGovernance,
        address indexed newGovernance,
        uint256 nonce
    );
    event SettlementConfigurationUpdated(
        bytes32 indexed policyId,
        bytes32 indexed positionIdHash,
        bytes32 aquaStrategyHash,
        address indexed priceOracle,
        uint256 nonce
    );
    event PriceProtectionConfigurationUpdated(
        bytes32 indexed policyId,
        uint64 priceMaxAgeSeconds,
        uint16 maximumPriceDeviationBps,
        uint256 nonce
    );

    mapping(bytes32 policyId => Policy policy) private _policies;
    mapping(bytes32 policyId => address[] assets) private _assets;
    mapping(bytes32 policyId => mapping(address token => AssetBounds bounds)) private _bounds;
    mapping(bytes32 policyId => mapping(bytes32 positionIdHash => SettlementConfiguration)) private
        _settlementConfigurations;

    modifier onlyGovernance(bytes32 policyId) {
        Policy storage policy = _policy(policyId);
        if (msg.sender != policy.governance) revert NotGovernance(policyId, msg.sender);
        _;
    }

    function createPolicy(
        bytes32 policyId,
        address treasury,
        address governance,
        AssetConfig[] calldata assets_,
        uint256 maximumTransactionValue_,
        FeeConfig calldata fee
    ) external {
        if (_policies[policyId].exists) revert AlreadyExists(policyId);
        if (policyId == bytes32(0) || treasury == address(0) || governance == address(0)) {
            revert InvalidAddress();
        }
        if (msg.sender != governance) revert NotGovernance(policyId, msg.sender);
        if (assets_.length < 2 || assets_.length > MAX_ASSETS) revert InvalidAssetCount();
        if (maximumTransactionValue_ == 0) {
            revert InvalidMaximumTransactionValue(maximumTransactionValue_);
        }
        _validateFee(fee);

        Policy storage policy = _policies[policyId];
        policy.treasury = treasury;
        policy.governance = governance;
        policy.maximumTransactionValue = maximumTransactionValue_;
        policy.nonce = 1;
        policy.priceMaxAgeSeconds = DEFAULT_PRICE_MAX_AGE_SECONDS;
        policy.maximumPriceDeviationBps = DEFAULT_MAX_PRICE_DEVIATION_BPS;
        policy.exists = true;
        policy.fee = fee;

        for (uint256 i; i < assets_.length; ++i) {
            _insertAsset(policyId, assets_[i]);
        }
        _validatePortfolioTotals(policyId);
        emit PolicyCreated(policyId, treasury, governance, 1);
    }

    function updateAssetBounds(
        bytes32 policyId,
        address token,
        uint16 minimumWeightBps,
        uint16 maximumWeightBps
    ) external onlyGovernance(policyId) {
        AssetBounds storage bounds = _bounds[policyId][token];
        if (!bounds.managed) revert UnsupportedAsset(policyId, token);
        _validateWeights(token, minimumWeightBps, maximumWeightBps);
        bounds.minimumWeightBps = minimumWeightBps;
        bounds.maximumWeightBps = maximumWeightBps;
        _validatePortfolioTotals(policyId);
        uint256 nonce = ++_policies[policyId].nonce;
        emit AssetBoundsUpdated(policyId, token, minimumWeightBps, maximumWeightBps, nonce);
    }

    function addAsset(bytes32 policyId, AssetConfig calldata asset)
        external
        onlyGovernance(policyId)
    {
        if (_assets[policyId].length >= MAX_ASSETS) revert InvalidAssetCount();
        _insertAsset(policyId, asset);
        _validatePortfolioTotals(policyId);
        uint256 nonce = ++_policies[policyId].nonce;
        emit AssetAdded(
            policyId, asset.token, asset.minimumWeightBps, asset.maximumWeightBps, nonce
        );
    }

    function setMaximumTransactionValue(bytes32 policyId, uint256 value)
        external
        onlyGovernance(policyId)
    {
        if (value == 0) revert InvalidMaximumTransactionValue(value);
        Policy storage policy = _policies[policyId];
        policy.maximumTransactionValue = value;
        uint256 nonce = ++policy.nonce;
        emit MaximumTransactionValueUpdated(policyId, value, nonce);
    }

    function setFeeConfiguration(bytes32 policyId, FeeConfig calldata fee)
        external
        onlyGovernance(policyId)
    {
        _validateFee(fee);
        Policy storage policy = _policies[policyId];
        policy.fee = fee;
        uint256 nonce = ++policy.nonce;
        emit FeeConfigurationUpdated(policyId, nonce);
    }

    function setPaused(bytes32 policyId, bool paused) external onlyGovernance(policyId) {
        Policy storage policy = _policies[policyId];
        policy.paused = paused;
        uint256 nonce = ++policy.nonce;
        emit PauseStatusUpdated(policyId, paused, nonce);
    }

    function setPriceProtection(
        bytes32 policyId,
        uint64 priceMaxAgeSeconds,
        uint16 maximumPriceDeviationBps
    ) external onlyGovernance(policyId) {
        if (
            priceMaxAgeSeconds == 0 || priceMaxAgeSeconds > 86_400
                || maximumPriceDeviationBps > BASIS_POINTS
        ) revert InvalidPriceProtectionConfiguration();
        Policy storage policy = _policies[policyId];
        policy.priceMaxAgeSeconds = priceMaxAgeSeconds;
        policy.maximumPriceDeviationBps = maximumPriceDeviationBps;
        uint256 nonce = ++policy.nonce;
        emit PriceProtectionConfigurationUpdated(
            policyId, priceMaxAgeSeconds, maximumPriceDeviationBps, nonce
        );
    }

    function setTreasury(bytes32 policyId, address newTreasury) external onlyGovernance(policyId) {
        if (newTreasury == address(0)) revert InvalidAddress();
        Policy storage policy = _policies[policyId];
        address oldTreasury = policy.treasury;
        policy.treasury = newTreasury;
        uint256 nonce = ++policy.nonce;
        emit TreasuryUpdated(policyId, oldTreasury, newTreasury, nonce);
    }

    /// @notice Binds a position to the treasury's Aqua strategy and approved price oracle.
    function setSettlementConfiguration(
        bytes32 policyId,
        bytes32 positionIdHash,
        bytes32 aquaStrategyHash,
        address priceOracle
    ) external onlyGovernance(policyId) {
        if (
            positionIdHash == bytes32(0) || aquaStrategyHash == bytes32(0)
                || priceOracle == address(0)
        ) {
            revert InvalidSettlementConfiguration();
        }
        SettlementConfiguration storage configuration =
            _settlementConfigurations[policyId][positionIdHash];
        configuration.aquaStrategyHash = aquaStrategyHash;
        configuration.priceOracle = priceOracle;
        configuration.exists = true;
        uint256 nonce = ++_policies[policyId].nonce;
        emit SettlementConfigurationUpdated(
            policyId, positionIdHash, aquaStrategyHash, priceOracle, nonce
        );
    }

    function settlementConfiguration(bytes32 policyId, bytes32 positionIdHash)
        external
        view
        returns (SettlementConfiguration memory)
    {
        _policy(policyId);
        SettlementConfiguration memory configuration =
            _settlementConfigurations[policyId][positionIdHash];
        if (!configuration.exists) revert InvalidSettlementConfiguration();
        return configuration;
    }

    function transferGovernance(bytes32 policyId, address pendingGovernance)
        external
        onlyGovernance(policyId)
    {
        if (pendingGovernance == address(0)) revert InvalidAddress();
        Policy storage policy = _policies[policyId];
        policy.pendingGovernance = pendingGovernance;
        emit GovernanceTransferStarted(policyId, policy.governance, pendingGovernance);
    }

    function acceptGovernance(bytes32 policyId) external {
        Policy storage policy = _policy(policyId);
        if (msg.sender != policy.pendingGovernance) {
            revert NotPendingGovernance(policyId, msg.sender);
        }
        address oldGovernance = policy.governance;
        policy.governance = msg.sender;
        policy.pendingGovernance = address(0);
        uint256 nonce = ++policy.nonce;
        emit GovernanceTransferred(policyId, oldGovernance, msg.sender, nonce);
    }

    function getPolicy(bytes32 policyId) external view returns (Policy memory) {
        return _policy(policyId);
    }

    function feeConfiguration(bytes32 policyId) external view returns (FeeConfig memory) {
        return _policy(policyId).fee;
    }

    function governanceOf(bytes32 policyId) external view returns (address) {
        return _policy(policyId).governance;
    }

    function treasuryOf(bytes32 policyId) external view returns (address) {
        return _policy(policyId).treasury;
    }

    function policyNonce(bytes32 policyId) external view returns (uint256) {
        return _policy(policyId).nonce;
    }

    function maximumTransactionValue(bytes32 policyId) external view returns (uint256) {
        return _policy(policyId).maximumTransactionValue;
    }

    function isPaused(bytes32 policyId) external view returns (bool) {
        return _policy(policyId).paused;
    }

    function assetCount(bytes32 policyId) external view returns (uint256) {
        _policy(policyId);
        return _assets[policyId].length;
    }

    function assetAt(bytes32 policyId, uint256 index) external view returns (address) {
        _policy(policyId);
        return _assets[policyId][index];
    }

    function assetBounds(bytes32 policyId, address token)
        external
        view
        returns (AssetBounds memory)
    {
        _policy(policyId);
        AssetBounds memory bounds = _bounds[policyId][token];
        if (!bounds.managed) revert UnsupportedAsset(policyId, token);
        return bounds;
    }

    function assets(bytes32 policyId) external view returns (address[] memory) {
        _policy(policyId);
        return _assets[policyId];
    }

    function _policy(bytes32 policyId) internal view returns (Policy storage policy) {
        policy = _policies[policyId];
        if (!policy.exists) revert PolicyNotFound(policyId);
    }

    function _insertAsset(bytes32 policyId, AssetConfig calldata asset) internal {
        if (asset.token == address(0)) revert InvalidAddress();
        if (asset.decimals > 36) revert InvalidAssetDecimals(asset.decimals);
        if (_bounds[policyId][asset.token].managed) revert DuplicateAsset(asset.token);
        _validateWeights(asset.token, asset.minimumWeightBps, asset.maximumWeightBps);
        _bounds[policyId][asset.token] = AssetBounds({
            decimals: asset.decimals,
            minimumWeightBps: asset.minimumWeightBps,
            maximumWeightBps: asset.maximumWeightBps,
            managed: true
        });
        _assets[policyId].push(asset.token);
    }

    function _validateWeights(address token, uint16 minimumWeightBps, uint16 maximumWeightBps)
        internal
        pure
    {
        if (minimumWeightBps > maximumWeightBps || maximumWeightBps > BASIS_POINTS) {
            revert InvalidAssetWeights(token, minimumWeightBps, maximumWeightBps);
        }
    }

    function _validatePortfolioTotals(bytes32 policyId) internal view {
        uint256 minimumTotal;
        uint256 maximumTotal;
        address[] storage tokens = _assets[policyId];
        for (uint256 i; i < tokens.length; ++i) {
            AssetBounds storage bounds = _bounds[policyId][tokens[i]];
            minimumTotal += bounds.minimumWeightBps;
            maximumTotal += bounds.maximumWeightBps;
        }
        if (minimumTotal > BASIS_POINTS || maximumTotal < BASIS_POINTS) {
            revert InvalidPortfolioBounds(minimumTotal, maximumTotal);
        }
    }

    function _validateFee(FeeConfig calldata fee) internal pure {
        if (
            fee.baseFeeBps > fee.maximumFeeBps
                || uint256(fee.baseFeeBps) + fee.slopeBps > fee.maximumFeeBps
                || fee.maximumFeeBps > MAXIMUM_TOTAL_FEE_BPS
                || uint256(fee.treasuryBaseFeeBps) + fee.solverFeeBps + fee.protocolFeeBps
                    != fee.baseFeeBps || fee.treasuryFeeRecipient == address(0)
                || fee.protocolFeeRecipient == address(0)
        ) revert InvalidFeeConfiguration();
    }
}
