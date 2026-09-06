import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = (name = "created_at") =>
  integer(name, { mode: "number" }).notNull();

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    chainId: integer("chain_id").notNull(),
    owner: text("owner").notNull(),
    treasury: text("treasury").notNull(),
    policyId: text("policy_id").notNull(),
    riskMode: text("risk_mode").notNull(),
    portfolioJson: text("portfolio_json").notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("positions_chain_idx").on(table.chainId)],
);

export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    registry: text("registry").notNull(),
    treasury: text("treasury").notNull(),
    governance: text("governance").notNull(),
    maximumTransactionValue: text("maximum_transaction_value").notNull(),
    quoteTtlSeconds: integer("quote_ttl_seconds").notNull(),
    priceMaxAgeSeconds: integer("price_max_age_seconds").notNull(),
    maximumPriceDeviationBps: integer("maximum_price_deviation_bps").notNull(),
    feeJson: text("fee_json").notNull(),
    paused: integer("paused", { mode: "boolean" }).notNull(),
    nonce: text("nonce").notNull(),
    policyJson: text("policy_json").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("policies_chain_idx").on(table.chainId)],
);

export const managedAssets = sqliteTable(
  "managed_assets",
  {
    policyId: text("policy_id").notNull(),
    token: text("token").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    minimumWeightBps: integer("minimum_weight_bps").notNull(),
    maximumWeightBps: integer("maximum_weight_bps").notNull(),
  },
  (table) => [primaryKey({ columns: [table.policyId, table.token] })],
);

export const riskCertificates = sqliteTable(
  "risk_certificates",
  {
    hash: text("hash").primaryKey(),
    policyId: text("policy_id").notNull(),
    chainId: integer("chain_id").notNull(),
    verifyingContract: text("verifying_contract").notNull(),
    nonce: text("nonce").notNull(),
    riskMode: text("risk_mode").notNull(),
    expiresAt: integer("expires_at").notNull(),
    certificateJson: text("certificate_json").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    status: text("status").notNull().default("ACTIVE"),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("risk_certificates_policy_idx").on(table.policyId)],
);

export const riskObservations = sqliteTable(
  "risk_observations",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    chainId: integer("chain_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    indexedBlock: text("indexed_block").notNull(),
    indexedBlockHash: text("indexed_block_hash").notNull(),
    finality: text("finality").notNull(),
    payloadHash: text("payload_hash").notNull(),
    observationJson: text("observation_json").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("risk_observations_source_idx").on(table.sourceId, table.id),
  ],
);

export const riskEvaluations = sqliteTable(
  "risk_evaluations",
  {
    evaluationHash: text("evaluation_hash").primaryKey(),
    positionId: text("position_id").notNull(),
    configurationVersion: text("configuration_version").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    configurationJson: text("configuration_json").notNull(),
    sourceDigest: text("source_digest").notNull(),
    mode: text("mode").notNull(),
    activeBoundsHash: text("active_bounds_hash").notNull(),
    evaluatedAt: integer("evaluated_at").notNull(),
    evaluationJson: text("evaluation_json").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("risk_evaluations_position_idx").on(
      table.positionId,
      table.evaluatedAt,
    ),
  ],
);

export const riskJobs = sqliteTable(
  "risk_jobs",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull(),
    lastError: text("last_error"),
    nextRunAt: integer("next_run_at").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("risk_jobs_due_idx").on(table.status, table.nextRunAt)],
);

export const riskAuditEvents = sqliteTable(
  "risk_audit_events",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id").notNull(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("risk_audit_position_idx").on(table.positionId, table.createdAt),
  ],
);

export const walletPolicies = sqliteTable(
  "wallet_policies",
  {
    fingerprint: text("fingerprint").primaryKey(),
    walletId: text("wallet_id").notNull(),
    role: text("role").notNull(),
    signerAddress: text("signer_address").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revoked: integer("revoked", { mode: "boolean" }).notNull(),
    policyJson: text("policy_json").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("wallet_policies_wallet_idx").on(table.walletId)],
);

export const intents = sqliteTable(
  "intents",
  {
    id: text("id").primaryKey(),
    intentHash: text("intent_hash").notNull(),
    trader: text("trader").notNull(),
    policyId: text("policy_id").notNull(),
    status: text("status").notNull(),
    intentJson: text("intent_json").notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [uniqueIndex("intents_hash_idx").on(table.intentHash)],
);

export const proposals = sqliteTable(
  "proposals",
  {
    proposalHash: text("proposal_hash").primaryKey(),
    intentHash: text("intent_hash").notNull(),
    solver: text("solver").notNull(),
    status: text("status").notNull(),
    simulationStatus: text("simulation_status").notNull(),
    proposalJson: text("proposal_json").notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("proposals_intent_idx").on(table.intentHash),
    index("proposals_rank_idx").on(table.intentHash, table.status),
  ],
);

export const quotes = sqliteTable(
  "quotes",
  {
    id: text("id").primaryKey(),
    intentHash: text("intent_hash").notNull(),
    quoteJson: text("quote_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    simulationStatus: text("simulation_status").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("quotes_intent_idx").on(table.intentHash)],
);

export const executions = sqliteTable(
  "executions",
  {
    transactionHash: text("transaction_hash").primaryKey(),
    intentHash: text("intent_hash").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    status: text("status").notNull(),
    executionJson: text("execution_json").notNull(),
    submittedAt: createdAt("submitted_at"),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    uniqueIndex("executions_intent_proposal_idx").on(
      table.intentHash,
      table.proposalHash,
    ),
  ],
);

export const capacityEpochs = sqliteTable(
  "capacity_epochs",
  {
    positionId: text("position_id").notNull(),
    traderInputToken: text("trader_input_token").notNull(),
    traderOutputToken: text("trader_output_token").notNull(),
    capacityEpochId: text("capacity_epoch_id").notNull(),
    capacityBaselineValue: text("capacity_baseline_value").notNull(),
    consumedValue: text("consumed_value").notNull(),
    policyNonce: text("policy_nonce").notNull(),
    riskCertificateHash: text("risk_certificate_hash").notNull(),
    balanceSnapshot: text("balance_snapshot").notNull(),
    priceSnapshot: text("price_snapshot").notNull(),
    portfolioPriceSnapshot: text("portfolio_price_snapshot").notNull(),
    aquaStrategyHash: text("aqua_strategy_hash").notNull(),
    chainId: integer("chain_id").notNull(),
    verifyingContract: text("verifying_contract").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.positionId,
        table.traderInputToken,
        table.traderOutputToken,
      ],
    }),
    uniqueIndex("capacity_epochs_id_idx").on(table.capacityEpochId),
  ],
);

export const agentIdentities = sqliteTable(
  "agent_identities",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    role: text("role").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    metadataJson: text("metadata_json").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [uniqueIndex("agent_identities_address_idx").on(table.address)],
);

export const indexingCheckpoints = sqliteTable(
  "indexing_checkpoints",
  {
    chainId: integer("chain_id").notNull(),
    contract: text("contract").notNull(),
    blockNumber: text("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.contract] })],
);

/** Canonical headers retained so restart-time reorg recovery can find an
 * actual common ancestor even when the replaced blocks had no events. */
export const indexingHeaders = sqliteTable(
  "indexing_headers",
  {
    chainId: integer("chain_id").notNull(),
    contract: text("contract").notNull(),
    blockNumber: text("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.contract, table.blockNumber] }),
    index("indexing_headers_block_idx").on(
      table.chainId,
      table.contract,
      table.blockNumber,
    ),
  ],
);

export const chainEvents = sqliteTable(
  "chain_events",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    blockNumber: text("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    contract: text("contract").notNull(),
    eventVersion: integer("event_version").notNull(),
    name: text("name").notNull(),
    payloadJson: text("payload_json").notNull(),
    removed: integer("removed", { mode: "boolean" }).notNull(),
    observedAt: createdAt("observed_at"),
  },
  (table) => [
    uniqueIndex("chain_events_log_idx").on(
      table.chainId,
      table.contract,
      table.transactionHash,
      table.logIndex,
    ),
    index("chain_events_block_idx").on(table.chainId, table.blockNumber),
  ],
);

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status", { enum: ["PENDING", "COMPLETED"] })
    .notNull()
    .default("PENDING"),
  statusCode: integer("status_code"),
  responseJson: text("response_json"),
  createdAt: createdAt(),
});

export const positionRelations = relations(positions, ({ one }) => ({
  policy: one(policies, {
    fields: [positions.policyId],
    references: [policies.id],
  }),
}));

export const policyRelations = relations(policies, ({ many }) => ({
  assets: many(managedAssets),
  positions: many(positions),
  riskCertificates: many(riskCertificates),
}));

export const schema = {
  positions,
  policies,
  managedAssets,
  riskCertificates,
  riskObservations,
  riskEvaluations,
  riskJobs,
  riskAuditEvents,
  walletPolicies,
  intents,
  proposals,
  quotes,
  executions,
  capacityEpochs,
  agentIdentities,
  indexingCheckpoints,
  indexingHeaders,
  chainEvents,
  idempotencyKeys,
};

export const sqlitePragmas = sql.raw(
  "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
);
