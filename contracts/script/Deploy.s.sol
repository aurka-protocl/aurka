// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "../src/AurkaPolicyRegistry.sol";
import { RiskModeRegistry } from "../src/RiskModeRegistry.sol";

interface VmDeployment {
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploys the Phase 3 registries. Policy creation remains a separate governance action.
contract DeployAurka {
    VmDeployment private constant VM =
        VmDeployment(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run()
        external
        returns (AurkaPolicyRegistry policyRegistry, RiskModeRegistry riskRegistry)
    {
        uint256 deployerPrivateKey = VM.envUint("DEPLOYER_PRIVATE_KEY");
        VM.startBroadcast(deployerPrivateKey);
        policyRegistry = new AurkaPolicyRegistry();
        riskRegistry = new RiskModeRegistry(policyRegistry);
        VM.stopBroadcast();
    }
}
