// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "./AurkaPolicyRegistry.sol";
import { AurkaSpaceVault } from "./AurkaSpaceVault.sol";
import { IERC20Minimal } from "./interfaces/IERC20Minimal.sol";
import { DirectSettlement } from "./libraries/DirectSettlement.sol";
import { PriceProtection } from "./libraries/PriceProtection.sol";

interface ISpaceCapacityInitializer {
    function activateCapacityEpochFromFactory(
        bytes32 policyId,
        DirectSettlement.CapacityEpoch calldata epoch,
        PriceProtection.SettlementInput calldata priceInput
    ) external returns (bytes32 capacityEpochId, uint256 capacityBaseline);
}

/// @notice Single owner entry point for the owner-managed Space lifecycle.
/// @dev Funding and Aqua registration are performed through the isolated vault
///      so Aqua records the vault as maker rather than the factory.
contract AurkaSpaceVaultFactory {
    uint256 public constant INITIAL_USDC_AMOUNT = 35_000e6;
    uint256 public constant INITIAL_WETH_AMOUNT = 5e18;

    address public immutable policyRegistry;
    address public immutable router;
    address public immutable aqua;
    address public immutable usdc;
    address public immutable weth;
    uint256 private _lock = 1;

    struct SpaceInitialization {
        bytes32 spaceId;
        bytes32 policyId;
        bytes32 strategyHash;
        bytes strategy;
        address owner;
        AurkaPolicyRegistry.AssetConfig[] assets;
        uint256 maximumTransactionValue;
        AurkaPolicyRegistry.FeeConfig fee;
        address priceOracle;
        uint64 priceMaxAgeSeconds;
        uint16 maximumPriceDeviationBps;
        DirectSettlement.CapacityEpoch capacityEpoch;
        PriceProtection.SettlementInput priceInput;
    }

    event VaultCreated(address indexed owner, bytes32 indexed spaceId, address vault);
    event SpaceInitialized(
        bytes32 indexed spaceId,
        bytes32 indexed policyId,
        address indexed owner,
        address vault,
        uint256 usdcAmount,
        uint256 wethAmount,
        bytes32 capacityEpochId,
        uint256 capacityBaseline
    );

    error InvalidAddress();
    error InvalidInitialization();
    error SpaceAlreadyInitialized(address vault);
    error TokenTransferFailed(address token);
    error FundingAmountMismatch(address token, uint256 expected, uint256 actual);
    error UnauthorizedInitialization();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        address policyRegistry_,
        address router_,
        address aqua_,
        address usdc_,
        address weth_
    ) {
        if (
            policyRegistry_ == address(0) || router_ == address(0) || aqua_ == address(0)
                || usdc_ == address(0) || weth_ == address(0)
        ) revert InvalidAddress();
        policyRegistry = policyRegistry_;
        router = router_;
        aqua = aqua_;
        usdc = usdc_;
        weth = weth_;
    }

    function vaultAddress(address owner, bytes32 spaceId) public view returns (address) {
        bytes32 salt = keccak256(abi.encode(owner, spaceId));
        bytes32 initHash = keccak256(
            abi.encodePacked(type(AurkaSpaceVault).creationCode, abi.encode(owner, address(this)))
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))
            )
        );
    }

    function createVault(bytes32 spaceId) external returns (address vault) {
        vault = _createVault(msg.sender, spaceId);
    }

    /// @notice Pulls the disclosed funding, creates policy state, ships the
    /// immutable Aqua strategy, and activates capacity in one transaction.
    function createAndInitializeSpace(SpaceInitialization calldata params)
        external
        nonReentrant
        returns (address vault, bytes32 capacityEpochId, uint256 capacityBaseline)
    {
        if (params.owner != msg.sender || params.owner == address(0)) {
            revert UnauthorizedInitialization();
        }
        if (
            params.spaceId == bytes32(0) || params.policyId == bytes32(0)
                || params.strategyHash == bytes32(0) || params.strategy.length == 0
                || keccak256(params.strategy) != params.strategyHash || params.priceOracle == address(0)
                || params.assets.length != 2
        ) revert InvalidInitialization();
        if (AurkaPolicyRegistry(policyRegistry).initializationFactory() != address(this)) {
            revert UnauthorizedInitialization();
        }

        vault = vaultAddress(params.owner, params.spaceId);
        if (vault.code.length != 0) revert SpaceAlreadyInitialized(vault);
        if (
            params.assets[0].token != usdc || params.assets[0].decimals != 6
                || params.assets[1].token != weth || params.assets[1].decimals != 18
        ) revert InvalidInitialization();
        if (
            params.capacityEpoch.positionIdHash != params.spaceId
                || params.capacityEpoch.aquaStrategyHash != params.strategyHash
                || params.capacityEpoch.chainId != block.chainid
                || params.capacityEpoch.verifyingContract != router
                || params.capacityEpoch.capacityBaseline != 0
                || params.capacityEpoch.capacityEpochId != bytes32(0)
                || params.capacityEpoch.consumedBefore != 0
        ) revert InvalidInitialization();
        if (
            params.priceInput.traderInputToken != weth
                || params.priceInput.traderOutputToken != usdc
                || params.capacityEpoch.traderInputTokenId != _tokenId(weth)
                || params.capacityEpoch.traderOutputTokenId != _tokenId(usdc)
        ) revert InvalidInitialization();
        if (params.fee.treasuryFeeRecipient != vault) revert InvalidInitialization();

        vault = _createVault(params.owner, params.spaceId);
        _pullExact(IERC20Minimal(usdc), params.owner, vault, INITIAL_USDC_AMOUNT);
        _pullExact(IERC20Minimal(weth), params.owner, vault, INITIAL_WETH_AMOUNT);

        uint256 policyNonce = AurkaPolicyRegistry(policyRegistry).createPolicyFromFactory(
            params.policyId,
            vault,
            params.owner,
            params.assets,
            params.maximumTransactionValue,
            params.fee,
            params.spaceId,
            params.strategyHash,
            params.priceOracle,
            params.priceMaxAgeSeconds,
            params.maximumPriceDeviationBps
        );
        if (params.capacityEpoch.policyNonce != policyNonce) revert InvalidInitialization();

        AurkaSpaceVault(vault).initializeApproval(usdc, aqua, INITIAL_USDC_AMOUNT);
        AurkaSpaceVault(vault).initializeApproval(weth, aqua, INITIAL_WETH_AMOUNT);
        address[] memory tokens = new address[](2);
        tokens[0] = usdc;
        tokens[1] = weth;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = INITIAL_USDC_AMOUNT;
        amounts[1] = INITIAL_WETH_AMOUNT;
        bytes32 shippedStrategyHash = AurkaSpaceVault(vault).initializeAquaStrategy(
            aqua, router, params.strategy, tokens, amounts
        );
        if (shippedStrategyHash != params.strategyHash) revert InvalidInitialization();

        (capacityEpochId, capacityBaseline) = ISpaceCapacityInitializer(router)
            .activateCapacityEpochFromFactory(params.policyId, params.capacityEpoch, params.priceInput);
        AurkaSpaceVault(vault).finalizeInitialization();
        emit SpaceInitialized(
            params.spaceId,
            params.policyId,
            params.owner,
            vault,
            INITIAL_USDC_AMOUNT,
            INITIAL_WETH_AMOUNT,
            capacityEpochId,
            capacityBaseline
        );
    }

    function _createVault(address owner, bytes32 spaceId) private returns (address vault) {
        vault = vaultAddress(owner, spaceId);
        if (vault.code.length == 0) {
            vault = address(
                new AurkaSpaceVault{ salt: keccak256(abi.encode(owner, spaceId)) }(
                    owner, address(this)
                )
            );
            emit VaultCreated(owner, spaceId, vault);
        }
    }

    function _pullExact(IERC20Minimal token, address from, address to, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(to);
        if (!token.transferFrom(from, to, amount)) revert TokenTransferFailed(address(token));
        uint256 received = token.balanceOf(to) - beforeBalance;
        if (received != amount) revert FundingAmountMismatch(address(token), amount, received);
    }

    function _tokenId(address token) private pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }
}
