import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 as keccak256 } from "@noble/hashes/sha3.js";

import type { AtomicSettlementProposal } from "@aurka/shared";

import type { ProposalSigner, SolverSnapshot } from "./types.js";

const FIXTURE_PRIVATE_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

/** A local-only signer; production services inject a custody/wallet adapter. */
export class FixtureProposalSigner implements ProposalSigner {
  readonly address: string;

  constructor(private readonly privateKey = FIXTURE_PRIVATE_KEY) {
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    // Ethereum address derivation is supplied by `ethereumAddress` below.
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
    const encoded = Uint8Array.from(
      secp256k1.sign(bytes(proposalHash), this.privateKey, {
        prehash: false,
        format: "recovered",
      }),
    );
    encoded[0] = (encoded[0] ?? 0) + 27;
    return `0x${Array.from(encoded, (item) => item.toString(16).padStart(2, "0")).join("")}`;
  }
}

function ethereumAddress(publicKey: Uint8Array): string {
  // This import is intentionally resolved statically by bundlers and Node.
  const uncompressed =
    publicKey.length === 65
      ? publicKey
      : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const digest = keccak256(uncompressed.slice(1));
  return `0x${Array.from(digest.slice(-20), (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

export function verifyProposalSignature(
  proposal: AtomicSettlementProposal,
  proposalHash: string,
): boolean {
  const signature = proposal.signature;
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    const encoded = bytes(signature);
    const recovery = (encoded[0] ?? 0) - 27;
    if (recovery < 0 || recovery > 3) return false;
    const recovered = secp256k1.recoverPublicKey(
      Uint8Array.from([recovery, ...encoded.slice(1)]),
      bytes(proposalHash),
      { prehash: false },
    );
    return (
      ethereumAddress(recovered).toLowerCase() === proposal.solver.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function fixtureSignerAddress(): string {
  return new FixtureProposalSigner().address;
}
