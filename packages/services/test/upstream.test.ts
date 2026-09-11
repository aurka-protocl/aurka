import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  createCanonicalFixture,
  DeterministicRouterSimulator,
  FixtureProvider,
} from "../src/fixture.js";
import { DirectSolver } from "../src/solver/direct.js";
import { FixtureProposalSigner } from "../src/solver/signing.js";
import {
  buildUpstreamSwapVMData,
  buildUpstreamSwapVMStrategy,
  SWAPVM_AQUA_COMMIT,
  SWAPVM_UPSTREAM_COMMIT,
} from "../src/solver/upstream.js";
import { buildRouterTransactionRequest } from "../src/solver/calldata.js";
import { hashIntent } from "../src/solver/hash.js";
import { AurkaService } from "../src/service.js";

const guard = "0x7777777777777777777777777777777777777777";

function word(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function reviewedStrategyHash(): string {
  const tokenA = "1111111111111111111111111111111111111111";
  const tokenB = "2222222222222222222222222222222222222222";
  const program = `0x9040${word(1_000_001n)}${word(1_000_000n)}530100`;
  const orderData = `0x${tokenA}${tokenB}${guard.slice(2)}${program.slice(2)}`;
  const traits =
    (1n << 254n) |
    (1n << 250n) |
    (1n << 246n) |
    (60n << 208n) |
    (60n << 192n) |
    (40n << 176n) |
    (40n << 160n);
  const encoded =
    `0x${word(32)}${"aa".repeat(20).padStart(64, "0")}${word(traits)}${word(96)}${word(129)}` +
    `${orderData.slice(2).padEnd(320, "0")}`;
  return `0x${Array.from(keccak_256(hexBytes(encoded)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

describe("pinned upstream SwapVM settlement template", () => {
  it("keeps the official pins and exact order/taker byte layout", async () => {
    const fixture = createCanonicalFixture({
      assetTokens: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      strategyHash: reviewedStrategyHash(),
    });
    const snapshot = { ...fixture.snapshot, swapVMGuard: guard };
    const solver = new DirectSolver(
      new FixtureProvider({ snapshot, intent: fixture.intent }),
      new DeterministicRouterSimulator(),
      new FixtureProposalSigner(),
    );
    const solved = await solver.solve(fixture.intent);
    const upstream = buildUpstreamSwapVMData(
      fixture.intent,
      solved.proposal,
      snapshot,
    );

    expect(SWAPVM_UPSTREAM_COMMIT).toBe(
      "afd99c408b4ed610027f4426c6f98650acac9f5f",
    );
    expect(SWAPVM_AQUA_COMMIT).toBe("9c5c42e5840e8741fba3597c48456c9510212b66");
    expect(upstream.orderData.length).toBe(2 + 129 * 2);
    expect(upstream.takerTraitsAndData.length).toBe(2 + 59 * 2);
    expect(upstream.orderData.slice(2, 6)).toBe("1111");
    expect(upstream.orderData.slice(82, 86)).toBe("7777");
    expect(upstream.orderData.slice(122, 124)).toBe("90");
    expect(upstream.orderData.slice(-6)).toBe("530100");
    expect(upstream.takerTraitsAndData.slice(2 + 20 * 2, 2 + 22 * 2)).toBe(
      "0051",
    );
    expect(upstream.strategyHash.toLowerCase()).toBe(
      snapshot.aquaStrategyHash.toLowerCase(),
    );

    const transaction = buildRouterTransactionRequest(
      fixture.intent,
      solved.proposal,
      snapshot,
      hashIntent(fixture.intent, snapshot),
    );
    expect(transaction.data.slice(0, 10)).toBe("0xa9aedf0c");
  });

  it("blocks quoting when a controlled oracle price no longer matches the shipped strategy", async () => {
    const fixture = createCanonicalFixture();
    const current = {
      ...fixture.snapshot,
      swapVMGuard: guard,
    };
    const shipped = buildUpstreamSwapVMStrategy(
      current,
      fixture.intent.traderInputToken,
      fixture.intent.traderOutputToken,
    );
    const changed = {
      ...current,
      aquaStrategyHash: shipped.strategyHash,
      portfolio: {
        ...current.portfolio,
        assets: current.portfolio.assets.map((asset) =>
          asset.token.toLowerCase() ===
          fixture.intent.traderOutputToken.toLowerCase()
            ? { ...asset, price: 2n, priceDecimals: 1 }
            : asset,
        ),
      },
    };
    const provider = {
      getPositionSnapshot: async () => changed,
      getSnapshot: async () => changed,
    };
    const service = new AurkaService({
      provider,
      seedFixture: false,
      spaceMode: "fork",
    });
    try {
      await expect(service.quote(fixture.intent)).rejects.toMatchObject({
        code: "PRICING_RENEWAL_REQUIRED",
        details: expect.objectContaining({
          state: "PRICING_NEEDS_RENEWAL",
          executable: false,
        }),
      });
      expect(
        service.repository.getIntent(fixture.intent.intentId),
      ).toBeUndefined();
    } finally {
      service.close();
    }
  });
});
