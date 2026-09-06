import { writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

import {
  createCanonicalFixture,
  DeterministicRouterSimulator,
} from "../dist/fixture.js";
import { DirectSolver } from "../dist/solver/direct.js";
import { buildRouterTransactionRequest } from "../dist/solver/calldata.js";
import { FixtureProposalSigner } from "../dist/solver/signing.js";

const fixture = createCanonicalFixture();
const intent = {
  ...fixture.intent,
  intentId: `0x${"07".repeat(32)}`,
  requestedValue: "25000",
};
const solver = new DirectSolver(
  { getSnapshot: async () => fixture.snapshot },
  new DeterministicRouterSimulator(),
  new FixtureProposalSigner(),
);
const solved = await solver.solve(intent);
const request = buildRouterTransactionRequest(
  intent,
  solved.proposal,
  fixture.snapshot,
  solved.proposal.intentHash,
);
const vector = {
  abiVersion: "AURKA-005",
  description:
    "Generated direct partial-fill calldata; amounts are fill-specific",
  intentHash: solved.proposal.intentHash,
  proposalHash: solved.proposalHash,
  traderInputAmount: solved.proposal.traderInputAmount,
  traderOutputAmount: solved.proposal.traderOutputAmount,
  solverFeeAmount: solved.proposal.solverFeeAmount,
  protocolFeeAmount: solved.proposal.protocolFeeAmount,
  treasuryOutputAmount: (
    BigInt(solved.proposal.traderOutputAmount) +
    BigInt(solved.proposal.solverFeeAmount) +
    BigInt(solved.proposal.protocolFeeAmount)
  ).toString(),
  calldata: request.data,
};

writeFileSync(
  fileURLToPath(
    new URL("../test-vectors/router-execute-partial.json", import.meta.url),
  ),
  `${JSON.stringify(vector, null, 2)}\n`,
);
writeFileSync(
  fileURLToPath(
    new URL(
      "../../../contracts/test/ServiceRouterCalldataFixture.sol",
      import.meta.url,
    ),
  ),
  [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity 0.8.28;",
    "",
    "// Generated from packages/services/test-vectors/router-execute-partial.json.",
    "library ServiceRouterCalldataFixture {",
    "    bytes internal constant CALLDATA =",
    `        hex"${request.data.slice(2)}";`,
    `    uint256 internal constant TRADER_INPUT_AMOUNT = ${solved.proposal.traderInputAmount};`,
    `    uint256 internal constant TRADER_OUTPUT_AMOUNT = ${solved.proposal.traderOutputAmount};`,
    `    uint256 internal constant TREASURY_OUTPUT_AMOUNT = ${vector.treasuryOutputAmount};`,
    "}",
    "",
  ].join("\n"),
);
