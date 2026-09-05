// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function assume(bool condition) external;
    function chainId(uint256 newChainId) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData)
        external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function targetContract(address target) external;
    function warp(uint256 timestamp) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed(string message);

    function assertTrue(bool condition) internal pure {
        if (!condition) revert AssertionFailed("expected true");
    }

    function assertFalse(bool condition) internal pure {
        if (condition) revert AssertionFailed("expected false");
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert AssertionFailed("uint values differ");
    }

    function assertEq(address actual, address expected) internal pure {
        if (actual != expected) revert AssertionFailed("addresses differ");
    }

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        if (actual != expected) revert AssertionFailed("bytes32 values differ");
    }

    function assertEq(bool actual, bool expected) internal pure {
        if (actual != expected) revert AssertionFailed("bool values differ");
    }

    function assertGe(uint256 actual, uint256 minimum) internal pure {
        if (actual < minimum) revert AssertionFailed("value below minimum");
    }

    function assertLe(uint256 actual, uint256 maximum) internal pure {
        if (actual > maximum) revert AssertionFailed("value above maximum");
    }

    function bound(uint256 value, uint256 minimum, uint256 maximum)
        internal
        pure
        returns (uint256)
    {
        if (minimum > maximum) revert AssertionFailed("invalid bound");
        if (value >= minimum && value <= maximum) return value;
        return minimum + (value % (maximum - minimum + 1));
    }
}
