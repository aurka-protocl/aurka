// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaSpaceVault } from "./AurkaSpaceVault.sol";

/// @notice Retries resolve to the same treasury; owners cannot claim each other's salts.
contract AurkaSpaceVaultFactory {
    event VaultCreated(address indexed owner, bytes32 indexed spaceId, address vault);

    function vaultAddress(address owner, bytes32 spaceId) public view returns (address) {
        bytes32 salt = keccak256(abi.encode(owner, spaceId));
        bytes32 initHash =
            keccak256(abi.encodePacked(type(AurkaSpaceVault).creationCode, abi.encode(owner)));
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))
            )
        );
    }

    function createVault(bytes32 spaceId) external returns (address vault) {
        vault = vaultAddress(msg.sender, spaceId);
        if (vault.code.length == 0) {
            vault = address(
                new AurkaSpaceVault{ salt: keccak256(abi.encode(msg.sender, spaceId)) }(msg.sender)
            );
            emit VaultCreated(msg.sender, spaceId, vault);
        }
    }
}
