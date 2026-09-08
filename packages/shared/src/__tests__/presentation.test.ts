import { describe, expect, it } from "vitest";

import {
  formatBasisPoints,
  formatDecimalUnits,
  formatScaledBasisPoints,
  formatSnapshotAge,
  parseDecimalUnits,
  parseTokenAmount,
} from "../presentation.js";

describe("lossless financial presentation", () => {
  it("formats zero, six-decimal, and eighteen-decimal amounts", () => {
    expect(formatDecimalUnits("0", 0)).toBe("0");
    expect(formatDecimalUnits("1234567", 6)).toBe("1.234567");
    expect(formatDecimalUnits("1000000000000000001", 18)).toBe(
      "1.000000000000000001",
    );
  });

  it("preserves large uint values and signed differences", () => {
    const maximum = (2n ** 256n - 1n).toString();
    expect(formatDecimalUnits(maximum, 0)).toBe(maximum);
    expect(formatDecimalUnits(-1234567n, 6)).toBe("-1.234567");
  });

  it("rejects unrepresentable precision instead of rounding", () => {
    expect(parseTokenAmount("1.234567", 6)).toBe(1_234_567n);
    expect(() => parseTokenAmount("1.2345671", 6)).toThrow(/fractional digits/);
    expect(() => parseDecimalUnits("1e3", 6)).toThrow(/plain decimal/);
    expect(() => parseDecimalUnits("1.00", 0)).toThrow(/fractional digits/);
  });

  it("handles decimal boundaries without floating-point rounding", () => {
    expect(parseTokenAmount("0.000001", 6)).toBe(1n);
    expect(parseTokenAmount("0.000000000000000001", 18)).toBe(1n);
    expect(formatDecimalUnits(999_999n, 6)).toBe("0.999999");
    expect(formatDecimalUnits(1_000_000n, 6)).toBe("1");
  });

  it("renders basis points and fractional basis points exactly", () => {
    expect(formatBasisPoints(5_500)).toBe("55.00%");
    expect(formatBasisPoints("1")).toBe("0.01%");
    expect(formatScaledBasisPoints("21066666666666666667")).toBe(
      "21.066666666666666667 bps",
    );
  });

  it("reports snapshot age without pretending a source is live", () => {
    expect(formatSnapshotAge(100, 159)).toBe("59s ago");
    expect(formatSnapshotAge(100, 3_700)).toBe("1h ago");
  });
});
