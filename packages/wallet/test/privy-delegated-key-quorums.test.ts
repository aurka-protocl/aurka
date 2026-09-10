import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  verifyAuthorizationKeyBinding,
  verifyAuthorizationKeyQuorums,
} from "../scripts/privy-delegated-key-quorums.mjs";

function keyMaterial() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

describe("Privy authorization key readback", () => {
  it("matches a P-256 private key to its registered quorum member", () => {
    const material = keyMaterial();
    expect(
      verifyAuthorizationKeyBinding({
        quorum: {
          id: "owner-quorum",
          authorization_threshold: 1,
          authorization_keys: [{ public_key: material.publicKey }],
        },
        quorumId: "owner-quorum",
        privateKey: material.privateKey,
        variableName: "TEST_KEY",
      }),
    ).toMatchObject({
      id: "owner-quorum",
      threshold: 1,
      registeredKeyCount: 1,
      configuredKeyCount: 1,
      thresholdSatisfied: true,
    });
  });

  it("rejects an EVM key or a quorum threshold that one configured key cannot satisfy", () => {
    const material = keyMaterial();
    expect(() =>
      verifyAuthorizationKeyBinding({
        quorum: {
          id: "owner-quorum",
          authorization_threshold: 1,
          authorization_keys: [{ public_key: material.publicKey }],
        },
        quorumId: "owner-quorum",
        privateKey: `0x${"11".repeat(32)}`,
        variableName: "TEST_KEY",
      }),
    ).toThrow("P-256");

    expect(() =>
      verifyAuthorizationKeyBinding({
        quorum: {
          id: "owner-quorum",
          authorization_threshold: 2,
          authorization_keys: [{ public_key: material.publicKey }],
        },
        quorumId: "owner-quorum",
        privateKey: material.privateKey,
        variableName: "TEST_KEY",
      }),
    ).toThrow("invalid threshold");
  });

  it("reads and binds both configured quorums through the callable SDK service", async () => {
    const owner = keyMaterial();
    const signer = keyMaterial();
    const names = [
      "PRIVY_DELEGATED_OWNER_ID",
      "PRIVY_DELEGATED_SIGNER_ID",
      "PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY",
      "PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY",
    ];
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.PRIVY_DELEGATED_OWNER_ID = "owner-quorum";
      process.env.PRIVY_DELEGATED_SIGNER_ID = "signer-quorum";
      process.env.PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY =
        owner.privateKey;
      process.env.PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY = signer.privateKey;
      const get = vi.fn(async (id: string) =>
        id === "owner-quorum"
          ? {
              id,
              authorization_threshold: 1,
              authorization_keys: [{ public_key: owner.publicKey }],
            }
          : {
              id,
              authorization_threshold: 1,
              authorization_keys: [{ public_key: signer.publicKey }],
            },
      );
      const result = await verifyAuthorizationKeyQuorums({
        keyQuorums: () => ({ get }),
      });
      expect(result.owner.thresholdSatisfied).toBe(true);
      expect(result.signer.thresholdSatisfied).toBe(true);
      expect(get).toHaveBeenCalledWith("owner-quorum");
      expect(get).toHaveBeenCalledWith("signer-quorum");
    } finally {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    }
  });
});
