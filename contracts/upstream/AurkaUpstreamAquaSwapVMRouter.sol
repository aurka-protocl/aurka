// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:upstream-repository https://github.com/1inch/swap-vm
/// @custom:upstream-commit afd99c408b4ed610027f4426c6f98650acac9f5f
/// @custom:upstream-license https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt

import { LimitSwapVMRouter } from "@aurka-swap-vm/routers/LimitSwapVMRouter.sol";

/// @notice Pinned upstream SwapVM router used by the AURKA real settlement path.
/// @dev This thin constructor wrapper leaves the upstream VM and opcode map
/// unchanged. AURKA's entry router supplies the policy-bound order and taker
/// data, while a maker hook rejects direct fills outside that route.
contract AurkaUpstreamAquaSwapVMRouter is LimitSwapVMRouter {
    constructor(address aqua, address weth, address owner)
        LimitSwapVMRouter(aqua, weth, owner, "AURKA SwapVM", "1")
    { }

    /// @notice Marker used by the AURKA router to select the upstream Aqua app.
    function aurkaUpstreamSwapVM() external pure returns (bool) {
        return true;
    }
}
