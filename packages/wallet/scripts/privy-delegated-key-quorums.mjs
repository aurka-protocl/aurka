/* global process */

/*
 * Read-only checks for the P-256 keys used to authorize Privy requests.
 *
 * A Privy key-quorum ID is not an EVM address and its private key must never
 * be passed through to the service.  This module derives only the public SPKI
 * representation in memory and compares it with Privy's readback.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { Buffer } from "node:buffer";

const PRIVY_AUTHORIZATION_KEY_PREFIX = "wallet-auth:";

function publicKeyDerBase64(privateKey, variableName) {
  const normalized = privateKey.startsWith(PRIVY_AUTHORIZATION_KEY_PREFIX)
    ? privateKey.slice(PRIVY_AUTHORIZATION_KEY_PREFIX.length)
    : privateKey;
  let key;
  try {
    key = normalized.includes("BEGIN")
      ? createPrivateKey(normalized)
      : createPrivateKey({
          key: Buffer.from(normalized, "base64"),
          format: "der",
          type: "pkcs8",
        });
  } catch {
    throw new Error(`${variableName} is not a readable P-256 private key`);
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error(`${variableName} must be a P-256 private key`);
  try {
    return createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .toString("base64");
  } catch {
    throw new Error(`${variableName} public key derivation failed`);
  }
}

function normalizePublicKey(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.includes("BEGIN")) {
    try {
      return createPublicKey(text)
        .export({ type: "spki", format: "der" })
        .toString("base64");
    } catch {
      return "";
    }
  }
  return text.replace(/\s+/g, "");
}

function exactThreshold(quorum, quorumId) {
  if (quorum?.id !== quorumId)
    throw new Error(`Privy key quorum readback mismatch for ${quorumId}`);
  const threshold = quorum.authorization_threshold;
  const keys = Array.isArray(quorum.authorization_keys)
    ? quorum.authorization_keys
    : [];
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    threshold > keys.length
  )
    throw new Error(`Privy key quorum ${quorumId} has an invalid threshold`);
  return { threshold, keys };
}

export function verifyAuthorizationKeyBinding({
  quorum,
  quorumId,
  privateKey,
  variableName,
}) {
  const { threshold, keys } = exactThreshold(quorum, quorumId);
  const derived = publicKeyDerBase64(privateKey, variableName);
  const matches = keys.filter(
    (entry) => normalizePublicKey(entry?.public_key) === derived,
  ).length;
  if (matches !== 1)
    throw new Error(
      `${variableName} does not match exactly one registered key in Privy quorum ${quorumId}`,
    );
  if (threshold > matches)
    throw new Error(
      `Privy quorum ${quorumId} threshold cannot be satisfied by the configured authorization key`,
    );
  return {
    id: quorumId,
    threshold,
    registeredKeyCount: keys.length,
    configuredKeyCount: matches,
    thresholdSatisfied: true,
  };
}

export async function verifyAuthorizationKeyQuorums(client) {
  if (typeof client?.keyQuorums !== "function")
    throw new Error("Installed Privy SDK does not expose keyQuorums()");
  const keyQuorums = client.keyQuorums();
  if (typeof keyQuorums?.get !== "function")
    throw new Error("Installed Privy SDK does not expose key-quorum readback");
  const ownerId = process.env.PRIVY_DELEGATED_OWNER_ID?.trim();
  const signerId = process.env.PRIVY_DELEGATED_SIGNER_ID?.trim();
  const ownerKey =
    process.env.PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY?.trim();
  const signerKey =
    process.env.PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY?.trim();
  if (!ownerId || !signerId || !ownerKey || !signerKey)
    throw new Error(
      "Privy owner/signer quorum IDs and authorization keys are required for key readback",
    );
  const [owner, signer] = await Promise.all([
    keyQuorums.get(ownerId),
    keyQuorums.get(signerId),
  ]);
  return {
    owner: verifyAuthorizationKeyBinding({
      quorum: owner,
      quorumId: ownerId,
      privateKey: ownerKey,
      variableName: "PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY",
    }),
    signer: verifyAuthorizationKeyBinding({
      quorum: signer,
      quorumId: signerId,
      privateKey: signerKey,
      variableName: "PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY",
    }),
  };
}
