import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  chooseOperatorAction,
  EMPTY_STATE,
  nextBackoffMs,
  priceNeedsRefresh,
  readOperatorState,
  saveOperatorState,
} from "../scripts/sepolia-price-operator.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Sepolia price operator state", () => {
  it("refreshes before expiry by the poll and receipt margin", () => {
    expect(priceNeedsRefresh(120, 1, 120, 60)).toBe(true);
    expect(priceNeedsRefresh(120, 59, 120, 60)).toBe(true);
    expect(priceNeedsRefresh(120, 100, 120, 60)).toBe(false);
  });

  it("prioritizes timestamp refresh, then capacity, and stops at the budget", () => {
    const state = { ...EMPTY_STATE };
    expect(
      chooseOperatorAction(
        { needed: true, priceRefreshNeeded: true },
        state,
        48,
      ),
    ).toBe("price-refresh");
    expect(
      chooseOperatorAction(
        { needed: true, priceRefreshNeeded: false },
        { ...state, operationsSubmitted: 47 },
        48,
      ),
    ).toBe("capacity-renewal");
    expect(
      chooseOperatorAction(
        { needed: true, priceRefreshNeeded: true },
        { ...state, operationsSubmitted: 48 },
        48,
      ),
    ).toBe("budget_exhausted");
  });

  it("persists reserved operations and unknown outcomes across restarts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-operator-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "state.json");
    saveOperatorState(filename, {
      ...EMPTY_STATE,
      operationsSubmitted: 3,
      pendingAction: "price-refresh",
      unknownOutcomes: 1,
    });
    expect(readOperatorState(filename)).toMatchObject({
      operationsSubmitted: 3,
      pendingAction: "price-refresh",
      unknownOutcomes: 1,
    });
    expect(nextBackoffMs(1, 90_000)).toBe(2_000);
    expect(nextBackoffMs(8, 90_000)).toBe(32_000);
  });
});
