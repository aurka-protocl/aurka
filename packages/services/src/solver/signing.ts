import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 as keccak256 } from "@noble/hashes/sha3.js";

import type { AtomicSettlementProposal } from "@aurka/shared";
import type { ProposalSigner, SolverSnapshot } from "./types.js";

const FIXTURE_PRIVATE_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);

export const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (item) =>
    item.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function signDigest(digest: string, privateKey: Uint8Array): string {
  const recovered = secp256k1.sign(bytes(digest), privateKey, {
    prehash: false,
    format: "recovered",
  });
  const recovery = recovered[0] ?? 0;
  if (recovery < 0 || recovery > 1) {
    throw new Error("Invalid signature recovery bit");
  }
  const r = recovered.slice(1, 33);
  const s = recovered.slice(33, 65);
  const sValue = BigInt(hex(s));
  if (sValue > SECP256K1_HALF_ORDER) {
    throw new Error("Signature s exceeds half order");
  }
  const v = recovery + 27;
  const result = new Uint8Array(65);
  result.set(r, 0);
  result.set(s, 32);
  result[64] = v;
  return hex(result);
}

/** A local-only signer; production services inject a custody/wallet adapter. */
export class FixtureProposalSigner implements ProposalSigner {
  readonly address: string;

  constructor(private readonly privateKey = FIXTURE_PRIVATE_KEY) {
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    this.address = ethereumAddress(publicKey);
  }

  async signProposal(
    proposal: AtomicSettlementProposal,
    proposalHash: string,
    snapshot: SolverSnapshot,
  ): Promise<string> {
    void snapshot;
    if (proposal.solver.toLowerCase() !== this.address.toLowerCase())
      throw new Error("Proposal solver does not match signer");
    return signDigest(proposalHash, this.privateKey);
  }
}

function ethereumAddress(publicKey: Uint8Array): string {
  const uncompressed =
    publicKey.length === 65
      ? publicKey
      : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const digest = keccak256(uncompressed.slice(1));
  return `0x${Array.from(digest.slice(-20), (item) =>
    item.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function verifySignature(
  expectedSigner: string,
  digest: string,
  signature: string,
): boolean {
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    const encoded = bytes(signature);
    if (encoded.length !== 65) return false;
    const v = encoded[64] ?? 0;
    if (v !== 27 && v !== 28) return false;
    const recovery = v - 27;
    const r = encoded.slice(0, 32);
    const s = encoded.slice(32, 64);
    const sValue = BigInt(hex(s));
    if (sValue > SECP256K1_HALF_ORDER) return false;

    const nobleRecovered = new Uint8Array(65);
    nobleRecovered[0] = recovery;
    nobleRecovered.set(r, 1);
    nobleRecovered.set(s, 33);

    const recoveredPub = secp256k1.recoverPublicKey(
      nobleRecovered,
      bytes(digest),
      { prehash: false },
    );
    return (
      ethereumAddress(recoveredPub).toLowerCase() ===
      expectedSigner.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function verifyProposalSignature(
  proposal: AtomicSettlementProposal,
  proposalHash: string,
): boolean {
  return verifySignature(
    proposal.solver,
    proposalHash,
    proposal.signature ?? "",
  );
}

export function fixtureSignerAddress(): string {
  return new FixtureProposalSigner().address;
}
