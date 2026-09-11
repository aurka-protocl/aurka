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

/** Durable Space identity and lifecycle state. Positions remain the canonical
 * settlement read model; this table owns user-facing metadata and drafts. */
export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    controller: text("controller").notNull(),
    treasury: text("treasury").notNull(),
    chainId: integer("chain_id").notNull(),
    policyId: text("policy_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    policyRegistry: text("policy_registry").notNull(),
    mode: text("mode").notNull(),
    state: text("state").notNull(),
    positionId: text("position_id"),
    draftJson: text("draft_json"),
    failureReason: text("failure_reason"),
    authNonce: text("auth_nonce").notNull().default("0"),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("spaces_owner_idx").on(table.owner, table.id),
    index("spaces_state_idx").on(table.state, table.updatedAt),
  ],
);

export const spaceChanges = sqliteTable(
  "space_changes",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    status: text("status").notNull(),
    receiptHash: text("receipt_hash"),
    payloadJson: text("payload_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("space_changes_space_idx").on(
      table.spaceId,
      table.createdAt,
      table.id,
    ),
  ],
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
    positionId: text("position_id").notNull(),
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

/**
 * One projected settlement joins the router's TradeExecuted and FeesRouted
 * logs. The raw logs remain authoritative; this table is a bounded read model
 * used for activity pagination and fee aggregation.
 */
export const settlementRecords = sqliteTable(
  "settlement_records",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    contract: text("contract").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    blockNumber: text("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    positionIdHash: text("position_id_hash"),
    positionId: text("position_id"),
    intentHash: text("intent_hash"),
    tradeEventId: text("trade_event_id"),
    feeEventId: text("fee_event_id"),
    tradeJson: text("trade_json"),
    feeJson: text("fee_json"),
    orphaned: integer("orphaned", { mode: "boolean" }).notNull(),
    observedAt: createdAt("observed_at"),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    uniqueIndex("settlement_records_proposal_idx").on(
      table.chainId,
      table.contract,
      table.transactionHash,
      table.proposalHash,
    ),
    index("settlement_records_activity_idx").on(
      table.chainId,
      table.positionId,
      table.observedAt,
      table.id,
    ),
    index("settlement_records_status_idx").on(
      table.chainId,
      table.orphaned,
      table.observedAt,
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

export const delegatedSessions = sqliteTable(
  "delegated_sessions",
  {
    id: text("id").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    agentAddress: text("agent_address").notNull(),
    state: text("state").notNull(),
    planJson: text("plan_json").notNull(),
    walletJson: text("wallet_json").notNull(),
    authorizedAt: createdAt("authorized_at"),
    authorityGeneration: integer("authority_generation").notNull().default(0),
    consumedInputAmount: text("consumed_input_amount").notNull(),
    tradeCount: integer("trade_count").notNull(),
    lastProposalHash: text("last_proposal_hash"),
    lastTransactionHash: text("last_transaction_hash"),
    lastRecoveryTransactionHash: text("last_recovery_transaction_hash"),
    lastResult: text("last_result"),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("delegated_sessions_owner_idx").on(
      table.ownerAddress,
      table.updatedAt,
    ),
    index("delegated_sessions_state_idx").on(table.state, table.updatedAt),
  ],
);

export const delegatedTrades = sqliteTable(
  "delegated_trades",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    intentHash: text("intent_hash").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    inputAmount: text("input_amount").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    // Stored before the broadcast boundary so restart reconciliation can
    // validate the canonical transaction and settlement event, not only its
    // hash.
    receiptExpectationJson: text("receipt_expectation_json"),
    transactionHash: text("transaction_hash"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    uniqueIndex("delegated_trades_idempotency_idx").on(table.idempotencyKey),
    index("delegated_trades_session_idx").on(table.sessionId, table.createdAt),
    index("delegated_trades_status_idx").on(table.status, table.updatedAt),
  ],
);

/** A recovery authorization is consumed before invoking the owner/operator
 * callback. Keeping it separate from the session means a replay remains
 * rejected after a process restart and a callback timeout cannot be mistaken
 * for permission to send a second transfer. */
export const delegatedRecoveries = sqliteTable(
  "delegated_recoveries",
  {
    authorizationHash: text("authorization_hash").primaryKey(),
    sessionId: text("session_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    destination: text("destination").notNull(),
    assetsJson: text("assets_json").notNull(),
    status: text("status").notNull(),
    transactionHash: text("transaction_hash"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("delegated_recoveries_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("delegated_recoveries_status_idx").on(table.status, table.updatedAt),
  ],
);

/** One-time owner-signed control authorizations. */
export const delegatedControlAuthorizations = sqliteTable(
  "delegated_control_authorizations",
  {
    authorizationHash: text("authorization_hash").primaryKey(),
    sessionId: text("session_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    action: text("action").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("delegated_control_nonce_idx").on(table.sessionId, table.nonce),
  ],
);

/** Wallet-login challenges are single-use and intentionally separate from
 * long-lived agent records. The nonce is never reused after verification. */
export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    chainId: integer("chain_id").notNull(),
    nonce: text("nonce").notNull(),
    origin: text("origin").notNull(),
    expiresAt: createdAt("expires_at"),
    consumedAt: integer("consumed_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("auth_challenges_address_idx").on(table.address, table.createdAt),
    index("auth_challenges_expiry_idx").on(table.expiresAt, table.consumedAt),
  ],
);

/** Only a SHA-256 digest of the browser cookie is persisted. */
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    chainId: integer("chain_id").notNull(),
    expiresAt: createdAt("expires_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("auth_sessions_owner_idx").on(table.ownerAddress, table.createdAt),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
  ],
);

/** Durable per-user Privy agent registry. The external owner wallet is the
 * AURKA login identity; Privy resources remain server-side and are never
 * exposed to the browser. */
export const tradingAgents = sqliteTable(
  "trading_agents",
  {
    id: text("id").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    chainId: integer("chain_id").notNull(),
    walletId: text("wallet_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    signerId: text("signer_id").notNull(),
    policyId: text("policy_id").notNull(),
    recoveryPolicyId: text("recovery_policy_id").notNull(),
    state: text("state").notNull(),
    fundingJson: text("funding_json").notNull(),
    mandateJson: text("mandate_json"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    uniqueIndex("trading_agents_owner_chain_idx").on(
      table.ownerAddress,
      table.chainId,
    ),
    uniqueIndex("trading_agents_wallet_idx").on(table.walletId),
    index("trading_agents_state_idx").on(table.state, table.updatedAt),
  ],
);

/** Durable provider-side provisioning checkpoint. The policy and wallet IDs
 * are written as soon as Privy returns them, so an unknown provider outcome
 * can be reconciled with the same idempotency key after a restart. */
export const agentProvisioningOperations = sqliteTable(
  "agent_provisioning_operations",
  {
    id: text("id").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    chainId: integer("chain_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull(),
    recoveryPolicyId: text("recovery_policy_id"),
    walletId: text("wallet_id"),
    walletAddress: text("wallet_address"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    uniqueIndex("agent_provisioning_owner_chain_idx").on(
      table.ownerAddress,
      table.chainId,
    ),
    uniqueIndex("agent_provisioning_idempotency_idx").on(table.idempotencyKey),
    index("agent_provisioning_state_idx").on(table.state, table.updatedAt),
  ],
);

/** Durable Sepolia faucet reservations. Pending rows reserve the full
 * operation across restarts; confirmed rows preserve global issuance
 * accounting so a new browser session cannot reset the budget. */
export const agentFundingOperations = sqliteTable(
  "agent_funding_operations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    chainId: integer("chain_id").notNull(),
    ethAmount: text("eth_amount").notNull(),
    usdcAmount: text("usdc_amount").notNull(),
    wethAmount: text("weth_amount").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [
    index("agent_funding_operations_agent_idx").on(table.agentId, table.status),
    index("agent_funding_operations_budget_idx").on(
      table.status,
      table.chainId,
    ),
  ],
);

/** Durable lease used by the background trading worker. A crashed process
 * leaves the row behind; another process can claim it after expiry. */
export const delegatedWorkerLeases = sqliteTable(
  "delegated_worker_leases",
  {
    sessionId: text("session_id").primaryKey(),
    leaseId: text("lease_id").notNull(),
    expiresAt: createdAt("expires_at"),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("delegated_worker_leases_expiry_idx").on(table.expiresAt)],
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

export const riskStates = sqliteTable("risk_states", {
  positionId: text("position_id").primaryKey(),
  stateJson: text("state_json").notNull(),
});

export const riskWorkflows = sqliteTable("risk_workflows", {
  positionId: text("position_id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
});

export const schema = {
  riskWorkflows,
  riskStates,
  spaces,
  spaceChanges,
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
  settlementRecords,
  capacityEpochs,
  agentIdentities,
  delegatedSessions,
  delegatedTrades,
  delegatedRecoveries,
  delegatedControlAuthorizations,
  authChallenges,
  authSessions,
  tradingAgents,
  agentFundingOperations,
  delegatedWorkerLeases,
  indexingCheckpoints,
  indexingHeaders,
  chainEvents,
  idempotencyKeys,
};

export const sqlitePragmas = sql.raw(
  "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
);
