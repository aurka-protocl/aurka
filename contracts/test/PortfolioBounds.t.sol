// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PortfolioBounds } from "../src/libraries/PortfolioBounds.sol";
import { TestBase } from "./TestBase.sol";

contract PortfolioBoundsHarness {
    function normalizeValue(
        uint256 balance,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 valueDecimals
    ) external pure returns (uint256) {
        return PortfolioBounds.normalizeValue(
            balance, tokenDecimals, price, priceDecimals, valueDecimals
        );
    }

    function normalizeValueDown(
        uint256 balance,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 valueDecimals
    ) external pure returns (uint256) {
        return PortfolioBounds.normalizeValueDown(
            balance, tokenDecimals, price, priceDecimals, valueDecimals
        );
    }

    function nav(PortfolioBounds.AssetState[] memory assets) external pure returns (uint256) {
        return PortfolioBounds.nav(assets);
    }

    function weights(uint256 value, uint256 total)
        external
        pure
        returns (uint256 down, uint256 up)
    {
        return
            (PortfolioBounds.weightBpsDown(value, total), PortfolioBounds.weightBpsUp(value, total));
    }

    function withinBounds(PortfolioBounds.AssetState[] memory assets)
        external
        pure
        returns (bool)
    {
        return PortfolioBounds.isWithinBounds(assets);
    }

    function preview(
        PortfolioBounds.AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 fill
    ) external pure returns (PortfolioBounds.AssetState[] memory) {
        return PortfolioBounds.previewTrade(assets, traderInputToken, traderOutputToken, fill);
    }

    function maximumFill(
        PortfolioBounds.AssetState[] memory assets,
        address traderInputToken,
        address traderOutputToken,
        uint256 requested,
        uint256 cap
    ) external pure returns (PortfolioBounds.FillResult memory) {
        return PortfolioBounds.maximumSafeFill(
            assets, traderInputToken, traderOutputToken, requested, cap
        );
    }
}

contract PortfolioBoundsTest is TestBase {
    PortfolioBoundsHarness internal harness;

    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);
    address internal constant LINK = address(0x1003);

    function setUp() public {
        harness = new PortfolioBoundsHarness();
    }

    function testSharedPortfolioVector() public view {
        PortfolioBounds.AssetState[] memory assets = _portfolio();
        assertEq(harness.nav(assets), 1_000_000);
        (uint256 usdcDown, uint256 usdcUp) = harness.weights(600_000, 1_000_000);
        assertEq(usdcDown, 6_000);
        assertEq(usdcUp, 6_000);
        assertTrue(harness.withinBounds(assets));

        PortfolioBounds.FillResult memory result =
            harness.maximumFill(assets, WETH, USDC, 200_000, 50_000);
        assertEq(result.maximumSafeFill, 50_000);
        assertEq(
            uint256(result.bindingConstraint), uint256(PortfolioBounds.Constraint.TRANSACTION_CAP)
        );
        PortfolioBounds.AssetState[] memory post =
            harness.preview(assets, WETH, USDC, result.maximumSafeFill);
        assertEq(post[0].value, 550_000);
        assertEq(post[1].value, 350_000);
        assertEq(post[2].value, 100_000);
        assertTrue(harness.withinBounds(post));
    }

    function testBoundaryMinusOneExactAndPlusOne() public view {
        PortfolioBounds.AssetState[] memory assets = _portfolio();
        assertTrue(harness.withinBounds(harness.preview(assets, WETH, USDC, 49_999)));
        assertTrue(harness.withinBounds(harness.preview(assets, WETH, USDC, 50_000)));
        assertFalse(harness.withinBounds(harness.preview(assets, WETH, USDC, 50_001)));
    }

    function testRejectsSixtyTwoThousandProposal() public view {
        PortfolioBounds.AssetState[] memory post = harness.preview(_portfolio(), WETH, USDC, 62_000);
        assertFalse(harness.withinBounds(post));
    }

    function testZeroSameDirectionAndReverseCapacity() public view {
        PortfolioBounds.AssetState[] memory post = harness.preview(_portfolio(), WETH, USDC, 50_000);
        PortfolioBounds.FillResult memory same =
            harness.maximumFill(post, WETH, USDC, 200_000, 50_000);
        PortfolioBounds.FillResult memory reverse =
            harness.maximumFill(post, USDC, WETH, 200_000, 50_000);
        assertEq(same.maximumSafeFill, 0);
        assertEq(reverse.maximumSafeFill, 50_000);
    }

    function testDepositsAndWithdrawalsStartNewCapacityEpoch() public view {
        PortfolioBounds.AssetState[] memory deposited = _portfolio();
        deposited[0].value += 20_000;
        PortfolioBounds.FillResult memory depositCapacity =
            harness.maximumFill(deposited, WETH, USDC, 200_000, 200_000);
        assertEq(depositCapacity.maximumSafeFill, 57_000);

        PortfolioBounds.AssetState[] memory withdrawn = _portfolio();
        withdrawn[1].value -= 10_000;
        PortfolioBounds.FillResult memory withdrawalCapacity =
            harness.maximumFill(withdrawn, WETH, USDC, 200_000, 200_000);
        assertEq(withdrawalCapacity.maximumSafeFill, 55_500);
    }

    function testNormalizesTokenAndPriceDecimalsRoundingUp() public view {
        assertEq(harness.normalizeValue(1e18, 18, 3_000e8, 8, 6), 3_000e6);
        // One smallest unit at a sub-unit price still conservatively contributes one value unit.
        assertEq(harness.normalizeValue(1, 6, 1, 8, 6), 1);
        assertEq(harness.normalizeValueDown(1, 6, 1, 8, 6), 0);
    }

    function testWeightsRoundConservatively() public view {
        (uint256 down, uint256 up) = harness.weights(1, 3);
        assertEq(down, 3_333);
        assertEq(up, 3_334);
    }

    function testUnsupportedAssetReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioBounds.AssetNotFound.selector, address(0x9999))
        );
        harness.maximumFill(_portfolio(), address(0x9999), WETH, 1, 1);
    }

    function testArithmeticOverflowReverts() public {
        vm.expectRevert();
        harness.normalizeValue(type(uint256).max, 0, 2, 0, 0);
    }

    function testFuzzMaximumFillIsSafeAndMaximal(uint256 requested) public view {
        requested = bound(requested, 0, 250_000);
        PortfolioBounds.AssetState[] memory assets = _portfolio();
        PortfolioBounds.FillResult memory result =
            harness.maximumFill(assets, WETH, USDC, requested, 50_000);
        uint256 expected = requested < 50_000 ? requested : 50_000;
        assertEq(result.maximumSafeFill, expected);
        assertTrue(
            harness.withinBounds(harness.preview(assets, WETH, USDC, result.maximumSafeFill))
        );
        if (result.maximumSafeFill < requested && result.maximumSafeFill < 50_000) {
            assertFalse(
                harness.withinBounds(
                    harness.preview(assets, WETH, USDC, result.maximumSafeFill + 1)
                )
            );
        }
    }

    function _portfolio() internal pure returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](3);
        assets[0] = PortfolioBounds.AssetState(USDC, 600_000, 5_500, 10_000);
        assets[1] = PortfolioBounds.AssetState(WETH, 300_000, 0, 3_500);
        assets[2] = PortfolioBounds.AssetState(LINK, 100_000, 0, 1_500);
    }
}
