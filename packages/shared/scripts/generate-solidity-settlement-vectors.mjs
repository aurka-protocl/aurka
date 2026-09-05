import { readFileSync, writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

const vectorPath = new URL("../test-vectors/settlement.json", import.meta.url);
const outputPath = new URL(
  "../../../contracts/test/SettlementVectors.sol",
  import.meta.url,
);
const vector = JSON.parse(readFileSync(vectorPath, "utf8"));
const canonical = vector.canonical200000Request;

const output = [
  "// SPDX-License-Identifier: MIT",
  "pragma solidity 0.8.28;",
  "",
  "// Generated from packages/shared/test-vectors/settlement.json.",
  "library SettlementVectors {",
  "    bytes32 internal constant CAPACITY_EPOCH_ID = " +
    canonical.capacityEpochId +
    ";",
  "    uint256 internal constant REQUESTED_VALUE = " +
    canonical.requestedValue +
    ";",
  "    uint256 internal constant EXECUTED_VALUE = " +
    canonical.executedValue +
    ";",
  "    uint256 internal constant TOTAL_FEE = " + canonical.totalFeeAmount + ";",
  "    uint256 internal constant TREASURY_FEE = " +
    canonical.treasuryAmount +
    ";",
  "    uint256 internal constant SOLVER_FEE = " + canonical.solverAmount + ";",
  "    uint256 internal constant PROTOCOL_FEE = " +
    canonical.protocolAmount +
    ";",
  "    uint256 internal constant TRADER_OUTPUT_VALUE = " +
    canonical.traderOutputValue +
    ";",
  "    uint256 internal constant TREASURY_OUTPUT_VALUE = " +
    canonical.treasuryOutputValue +
    ";",
  "    uint256 internal constant FINAL_USDC = " +
    canonical.finalPortfolio.USDC +
    ";",
  "    uint256 internal constant FINAL_WETH = " +
    canonical.finalPortfolio.WETH +
    ";",
  "    uint256 internal constant FINAL_LINK = " +
    canonical.finalPortfolio.LINK +
    ";",
  "    uint256 internal constant FINAL_NAV = " +
    canonical.finalPortfolio.nav +
    ";",
  "}",
  "",
].join("\n");

writeFileSync(fileURLToPath(outputPath), output);
