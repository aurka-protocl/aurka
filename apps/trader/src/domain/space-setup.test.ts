import { describe, expect, it } from "vitest";
import { parseSendCallsResult } from "./space-setup";

describe("wallet call result parsing", () => {
  it("accepts the standard SendCallsResult object", () => {
    expect(parseSendCallsResult({ id: "wallet-batch-1" })).toBe(
      "wallet-batch-1",
    );
  });

  it.each(["wallet-batch-1", {}, { id: "" }, { id: 12 }, null])(
    "rejects malformed result %#",
    (result) => {
      expect(() => parseSendCallsResult(result)).toThrow("malformed");
    },
  );
});
