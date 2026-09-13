import { AurkaError } from "@aurka/sdk";
import { describe, expect, it } from "vitest";
import { displayAssetSymbol, userFacingError } from "./ui";

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
    ).toBe("This Space needs an updated price before trading can resume.");
  });

  it("uses the supplied fallback without exposing provider details", () => {
    const message = "provider secret, stack trace, and arbitrary internals";
    const result = userFacingError(new Error(message), "Trade unavailable.");

    expect(result).toBe("Trade unavailable.");
    expect(result).not.toContain(message);
  });

  it("keeps network and timeout categories actionable", () => {
    expect(userFacingError(new Error("fetch failed"))).toContain(
      "couldn't connect",
    );
    expect(userFacingError(new Error("request timed out"))).toContain(
      "taking longer than expected",
    );
  });

  it("asks the user to review an amount adjustment without a token-specific increment", () => {
    expect(
      userFacingError(
        new AurkaError(
          "UNREPRESENTABLE_AMOUNT",
          "internal conversion detail",
          400,
        ),
      ),
    ).toContain("Review the supported amount");
  });

  it("distinguishes an immutable strategy repair from a price update", () => {
    expect(
      userFacingError(
        new AurkaError("STRATEGY_MISMATCH", "private details", 409),
      ),
    ).toContain("owner repair");
  });

  it("gives agent failures the action appropriate to their cause", () => {
    expect(
      userFacingError(
        new AurkaError(
          "DELEGATED_CONFIGURATION_MISSING",
          "private configuration details",
          503,
        ),
      ),
    ).toContain("administrator attention");
    expect(
      userFacingError(new AurkaError("AGENT_NOT_FOUND", "private", 404)),
    ).toBe("Create your trading agent before starting.");
    expect(
      userFacingError(
        new AurkaError("DELEGATED_TIMEOUT", "provider private details", 503),
      ),
    ).toContain("Your setup is saved");
    expect(
      userFacingError(
        new AurkaError("DELEGATED_POLICY_MISMATCH", "private", 409),
      ),
    ).toBe("Trading permissions need attention.");
    expect(
      userFacingError(new AurkaError("DELEGATED_REVOKED", "private", 409)),
    ).toContain("stopped");
  });

  it("removes fixture-only prefixes from displayed asset names", () => {
    expect(displayAssetSymbol("AURKA Demo WETH")).toBe("WETH");
    expect(displayAssetSymbol("Mock USDC")).toBe("USDC");
  });
});
