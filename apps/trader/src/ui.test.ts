import { AurkaError } from "@aurka/sdk";
import { describe, expect, it } from "vitest";
import { userFacingError } from "./ui";

describe("user-facing error mapping", () => {
  it("maps a known domain error without exposing provider text", () => {
    expect(
      userFacingError(
        new AurkaError(
          "PRICING_RENEWAL_REQUIRED",
          "private provider details",
          409,
        ),
      ),
    ).toBe(
      "This Space needs owner-assisted price recovery before it can trade again.",
    );
  });

  it("uses a support code for an unknown provider exception", () => {
    const message = "provider secret, stack trace, and arbitrary internals";
    const result = userFacingError(new Error(message), "Trade unavailable.");

    expect(result).toBe(
      "Trade unavailable. Support code: AURKA-UNEXPECTED-ERROR.",
    );
    expect(result).not.toContain(message);
  });

  it("keeps network and timeout categories actionable", () => {
    expect(userFacingError(new Error("fetch failed"))).toContain(
      "could not reach the service",
    );
    expect(userFacingError(new Error("request timed out"))).toContain(
      "too long to respond",
    );
  });
});
