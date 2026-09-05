// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PortfolioBounds } from "../../src/libraries/PortfolioBounds.sol";
import { TestBase } from "../TestBase.sol";

contract SafeTradeHandler {
    address internal constant USDC = address(0x1001);
    address internal constant WETH = address(0x1002);
    address internal constant LINK = address(0x1003);

    uint256 public usdc = 600_000;
    uint256 public weth = 300_000;
    uint256 public link = 100_000;

    function trade(uint256 requested, bool reverse) external {
        requested %= 200_001;
        PortfolioBounds.AssetState[] memory assets = portfolio();
        address input = reverse ? USDC : WETH;
        address output = reverse ? WETH : USDC;
        PortfolioBounds.FillResult memory result =
            PortfolioBounds.maximumSafeFill(assets, input, output, requested, 50_000);
        if (reverse) {
            usdc += result.maximumSafeFill;
            weth -= result.maximumSafeFill;
        } else {
            weth += result.maximumSafeFill;
            usdc -= result.maximumSafeFill;
        }
    }

    function portfolio() public view returns (PortfolioBounds.AssetState[] memory assets) {
        assets = new PortfolioBounds.AssetState[](3);
        assets[0] = PortfolioBounds.AssetState(USDC, usdc, 5_500, 10_000);
        assets[1] = PortfolioBounds.AssetState(WETH, weth, 0, 3_500);
        assets[2] = PortfolioBounds.AssetState(LINK, link, 0, 1_500);
    }

    function isSafe() external view returns (bool) {
        return PortfolioBounds.isWithinBounds(portfolio());
    }
}

contract PortfolioInvariantTest is TestBase {
    SafeTradeHandler internal handler;

    function setUp() public {
        handler = new SafeTradeHandler();
    }

    function invariantEverySuccessfulFillPreservesBounds() public view {
        assertTrue(handler.isSafe());
    }

    function invariantNavIsPreserved() public view {
        assertEq(handler.usdc() + handler.weth() + handler.link(), 1_000_000);
    }
}
