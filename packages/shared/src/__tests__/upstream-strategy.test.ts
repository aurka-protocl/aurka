import { describe, expect, it } from "vitest";

import {
  buildLegacyHardcodedOrderStrategy,
  buildUpstreamStrategy,
} from "../upstream-strategy.js";

const maker = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const guard = "0x7777777777777777777777777777777777777777";
const weth = {
  token: "0x33dca285758fd19d1f51c7b73d5a5fb8dae4d2c4",
  decimals: 18,
  price: 3200n,
  priceDecimals: 0,
};
const usdc = {
  token: "0x8228fd953cdf5fac815d09ec5ea27ddd9412a714",
  decimals: 6,
  price: 1n,
  priceDecimals: 0,
};

describe("canonical upstream strategy builder", () => {
  it("sorts Sepolia WETH before USDC and associates rounding with output", () => {
    const result = buildUpstreamStrategy({
      maker,
      guard,
      traderInput: weth,
      traderOutput: usdc,
    });

    expect(result.orderData.slice(2, 42)).toBe(weth.token.slice(2));
    expect(result.orderData.slice(42, 82)).toBe(usdc.token.slice(2));
    expect(result.program.slice(-2)).toBe("80");
    expect(result.program.slice(6, 70)).toBe(
      (312500000000000n * 1_000_000n).toString(16).padStart(64, "0"),
    );
    expect(result.program.slice(70, 134)).toBe(
      (1_000_000n * 1_000_000n + 1n).toString(16).padStart(64, "0"),
    );
  });

  it("keeps bytes and hashes stable for mixed-case addresses and opposite order", () => {
    const lower = buildUpstreamStrategy({
      maker,
      guard,
      traderInput: weth,
      traderOutput: usdc,
    });
    const mixed = buildUpstreamStrategy({
      maker: maker.toUpperCase(),
      guard: guard.toUpperCase(),
      traderInput: {
        ...weth,
        token: "0x33DcA285758Fd19d1F51C7b73d5A5fb8dAe4D2c4",
      },
      traderOutput: {
        ...usdc,
        token: "0x8228Fd953Cdf5Fac815D09eC5Ea27dDd9412A714",
      },
    });
    const reverse = buildUpstreamStrategy({
      maker,
      guard,
      traderInput: usdc,
      traderOutput: weth,
    });

    expect(mixed.strategy).toBe(lower.strategy);
    expect(mixed.strategyHash).toBe(lower.strategyHash);
    expect(reverse.orderData.slice(2, 42)).toBe(weth.token.slice(2));
    expect(reverse.program.slice(-2)).toBe("00");
  });

  it("reproduces the legacy hardcoded order only for diagnosis", () => {
    const canonical = buildUpstreamStrategy({
      maker,
      guard,
      traderInput: weth,
      traderOutput: usdc,
    });
    const legacy = buildLegacyHardcodedOrderStrategy({
      maker,
      guard,
      usdc,
      weth,
    });

    expect(legacy.orderData.slice(2, 42)).toBe(usdc.token.slice(2));
    expect(legacy.program.slice(-2)).toBe("00");
    expect(legacy.strategyHash).not.toBe(canonical.strategyHash);
  });
});
