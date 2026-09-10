import type { z } from "zod";

import {
  activityQuerySchema,
  activityResponseSchema,
  type ActivityItem,
  type ActivityStatus,
  type ActivityType,
  prepareIntentRequestSchema,
  prepareTokenIntentRequestSchema,
  type PrepareTokenIntentRequest,
  type PrepareIntentRequest,
  apiResponseSchema,
  apiFailureSchema,
  healthResponseSchema,
  readinessResponseSchema,
  type HealthResponse,
  type ReadinessResponse,
  type AtomicSettlementIntent,
  atomicSettlementIntentSchema,
  type Position,
  positionSchema,
  type Quote,
  quoteSchema,
  type AtomicSettlementProposal,
  type Execution,
  executionSchema,
  type DirectionalCapacity,
  directionalCapacitySchema,
  type RiskEvaluation,
  type RiskCertificate,
  type RiskPositionResponse,
  riskPositionResponseSchema,
  submitIntentRequestSchema,
  submitIntentResponseSchema,
  quoteRequestSchema,
  solveRequestSchema,
  solveResponseSchema,
  executeRequestSchema,
  executeResponseSchema,
  feeSummaryQuerySchema,
  feeSummaryResponseSchema,
  type FeeSummary,
  riskEvaluateRequestSchema,
  riskEvaluateResponseSchema,
  riskCertificateRequestSchema,
  riskCertificateResponseSchema,
  listRequestSchema,
  positionsResponseSchema,
  proposalsResponseSchema,
  spaceChangesResponseSchema,
  spaceListQuerySchema,
  spaceMutationConfirmRequestSchema,
  spaceMutationPrepareRequestSchema,
  spaceMutationPrepareResponseSchema,
  spaceMutationResponseSchema,
  spaceRecordSchema,
  spacesResponseSchema,
  type SpaceMutationConfirmRequest,
  type SpaceMutationPrepareRequest,
  type SpaceRecord,
  type SpaceMutationPrepareResponse,
  type SpaceMutationResponse,
  type SpaceChange,
  agentProposalRequestSchema,
  agentProposalResponseSchema,
  agentStatusSchema,
  type AgentProposalRequest,
  type AgentProposalResponse,
  type AgentStatus,
  delegatedAuthorizationSchema,
  delegatedRecoveryRequestSchema,
  delegatedSessionResponseSchema,
  delegatedStartRequestSchema,
  delegatedStatusSchema,
  type DelegatedSession,
  type DelegatedSessionAuthorization,
  type DelegatedRecoveryRequest,
  type DelegatedStartRequest,
  type DelegatedStatus,
} from "@aurka/shared";

export interface AurkaClientOptions {
  readonly baseUrl: string;
  readonly timeout?: number;
  readonly headers?: Record<string, string>;
}

export class AurkaClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: AurkaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeout = options.timeout ?? 30000;
    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...options.headers,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.defaultHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const failure = apiFailureSchema.safeParse(raw);
        if (failure.success)
          throw new AurkaError(
            failure.data.error.code,
            failure.data.error.message,
            response.status,
            failure.data.error.details,
          );
        throw new AurkaError(
          "HTTP_ERROR",
          `HTTP ${response.status}`,
          response.status,
        );
      }
      const parsed = apiResponseSchema(schema).safeParse(raw);
      if (!parsed.success)
        throw new AurkaError(
          "INVALID_RESPONSE",
          "API response does not match the contract",
          response.status,
        );
      if (!parsed.data.ok)
        throw new AurkaError(
          parsed.data.error.code,
          parsed.data.error.message,
          response.status,
          parsed.data.error.details,
        );
      return parsed.data.data;
    } catch (error) {
      if (error instanceof AurkaError) throw error;
      throw new AurkaError(
        controller.signal.aborted
          ? "TIMEOUT"
          : error instanceof SyntaxError
            ? "INVALID_RESPONSE"
            : "NETWORK_ERROR",
        error instanceof Error ? error.message : "Request failed",
        0,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async prepareIntent(
    input: PrepareIntentRequest,
  ): Promise<AtomicSettlementIntent> {
    return this.request(
      "POST",
      "/v1/intents/prepare",
      prepareIntentRequestSchema.parse(input),
      atomicSettlementIntentSchema,
    );
  }

  /** Prepare an intent from a human token amount using the service snapshot. */
  async prepareIntentFromTokenAmount(
    input: PrepareTokenIntentRequest,
  ): Promise<AtomicSettlementIntent> {
    return this.request(
      "POST",
      "/v1/intents/prepare-token",
      prepareTokenIntentRequestSchema.parse(input),
      atomicSettlementIntentSchema,
    );
  }

  async health(): Promise<HealthResponse> {
    return this.request("GET", "/health", undefined, healthResponseSchema);
  }

  async readiness(): Promise<ReadinessResponse> {
    return this.request("GET", "/ready", undefined, readinessResponseSchema);
  }

  async agentStatus(): Promise<AgentStatus> {
    return this.request(
      "GET",
      "/v1/agent/status",
      undefined,
      agentStatusSchema,
    );
  }

  async agentPropose(
    input: AgentProposalRequest,
  ): Promise<AgentProposalResponse> {
    return this.request(
      "POST",
      "/v1/agent/propose",
      agentProposalRequestSchema.parse(input),
      agentProposalResponseSchema,
    );
  }

  async delegatedStatus(): Promise<DelegatedStatus> {
    return this.request(
      "GET",
      "/v1/delegated/status",
      undefined,
      delegatedStatusSchema,
    );
  }

  async authorizeDelegatedSession(
    input: DelegatedSessionAuthorization,
  ): Promise<DelegatedSession> {
    return this.request(
      "POST",
      "/v1/delegated/sessions/authorize",
      delegatedAuthorizationSchema.parse(input),
      delegatedSessionResponseSchema,
    );
  }

  async delegatedSession(id: string): Promise<DelegatedSession> {
    return this.request(
      "GET",
      `/v1/delegated/sessions/${encodeURIComponent(id)}`,
      undefined,
      delegatedSessionResponseSchema,
    );
  }

  async startDelegatedSession(
    id: string,
    input: DelegatedStartRequest,
  ): Promise<DelegatedSession> {
    return this.request(
      "POST",
      `/v1/delegated/sessions/${encodeURIComponent(id)}/start`,
      delegatedStartRequestSchema.parse(input),
      delegatedSessionResponseSchema,
    );
  }

  async stopDelegatedSession(id: string): Promise<DelegatedSession> {
    return this.request(
      "POST",
      `/v1/delegated/sessions/${encodeURIComponent(id)}/stop`,
      {},
      delegatedSessionResponseSchema,
    );
  }

  async reconcileDelegatedSession(id: string): Promise<DelegatedSession> {
    return this.request(
      "POST",
      `/v1/delegated/sessions/${encodeURIComponent(id)}/reconcile`,
      {},
      delegatedSessionResponseSchema,
    );
  }

  async recoverDelegatedSession(
    id: string,
    input: DelegatedRecoveryRequest,
  ): Promise<DelegatedSession> {
    return this.request(
      "POST",
      `/v1/delegated/sessions/${encodeURIComponent(id)}/recover`,
      delegatedRecoveryRequestSchema.parse(input),
      delegatedSessionResponseSchema,
    );
  }

  async listPositions(
    limit?: number,
    cursor?: string,
  ): Promise<{ items: Position[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    const queryInput = listRequestSchema.parse({
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    params.set("limit", queryInput.limit.toString());
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    return this.request(
      "GET",
      `/v1/positions${query ? `?${query}` : ""}`,
      undefined,
      positionsResponseSchema,
    );
  }

  async getPosition(id: string): Promise<Position> {
    return this.request(
      "GET",
      `/v1/positions/${encodeURIComponent(id)}`,
      undefined,
      positionSchema,
    );
  }

  async listSpaces(
    limit?: number,
    ownerAddress?: string,
    cursor?: string,
  ): Promise<{ items: SpaceRecord[]; nextCursor: string | null }> {
    const queryInput = spaceListQuerySchema.parse({
      ...(limit === undefined ? {} : { limit }),
      ...(ownerAddress === undefined ? {} : { ownerAddress }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const params = new URLSearchParams({ limit: String(queryInput.limit) });
    if (queryInput.ownerAddress)
      params.set("ownerAddress", queryInput.ownerAddress);
    if (queryInput.cursor) params.set("cursor", queryInput.cursor);
    return this.request(
      "GET",
      `/v1/spaces?${params.toString()}`,
      undefined,
      spacesResponseSchema,
    );
  }

  async getSpace(id: string): Promise<SpaceRecord> {
    return this.request(
      "GET",
      `/v1/spaces/${encodeURIComponent(id)}`,
      undefined,
      spaceRecordSchema,
    );
  }

  async prepareSpaceMutation(
    input: SpaceMutationPrepareRequest,
  ): Promise<SpaceMutationPrepareResponse> {
    return this.request(
      "POST",
      "/v1/spaces/prepare",
      spaceMutationPrepareRequestSchema.parse(input),
      spaceMutationPrepareResponseSchema,
    );
  }

  async confirmSpaceMutation(
    input: SpaceMutationConfirmRequest,
  ): Promise<SpaceMutationResponse> {
    return this.request(
      "POST",
      "/v1/spaces/confirm",
      spaceMutationConfirmRequestSchema.parse(input),
      spaceMutationResponseSchema,
    );
  }

  async listSpaceChanges(id: string): Promise<SpaceChange[]> {
    return this.request(
      "GET",
      `/v1/spaces/${encodeURIComponent(id)}/changes`,
      undefined,
      spaceChangesResponseSchema,
    );
  }

  async getCapacity(
    positionId: string,
    traderInputToken: string,
    traderOutputToken: string,
  ): Promise<DirectionalCapacity> {
    const params = new URLSearchParams({
      traderInputToken,
      traderOutputToken,
    });
    return this.request(
      "GET",
      `/v1/positions/${encodeURIComponent(positionId)}/capacity?${params.toString()}`,
      undefined,
      directionalCapacitySchema,
    );
  }

  async submitIntent(intent: AtomicSettlementIntent): Promise<{
    intent: AtomicSettlementIntent;
    intentHash: string;
  }> {
    const input = submitIntentRequestSchema.parse({ intent });
    return this.request(
      "POST",
      "/v1/intents",
      input,
      submitIntentResponseSchema,
    );
  }

  async getIntent(id: string): Promise<AtomicSettlementIntent> {
    return this.request(
      "GET",
      `/v1/intents/${encodeURIComponent(id)}`,
      undefined,
      atomicSettlementIntentSchema,
    );
  }

  async listProposals(intentId: string): Promise<AtomicSettlementProposal[]> {
    return this.request(
      "GET",
      `/v1/intents/${encodeURIComponent(intentId)}/proposals`,
      undefined,
      proposalsResponseSchema,
    );
  }

  async quote(intent: AtomicSettlementIntent): Promise<Quote> {
    const input = quoteRequestSchema.parse({ intent });
    return this.request("POST", "/v1/quote", input, quoteSchema);
  }

  async solve(intent: AtomicSettlementIntent): Promise<{
    proposal: AtomicSettlementProposal;
    proposalHash: string;
    simulation: {
      status: "SUCCEEDED" | "REVERTED" | "STALE" | "AUTHORIZATION_PENDING";
      gasEstimate: string;
      reason?: string | undefined;
    };
  }> {
    const input = solveRequestSchema.parse({ intent });
    return this.request("POST", "/v1/solve", input, solveResponseSchema);
  }

  async execute(
    intentHash: string,
    proposalHash: string,
    externalSignature?: string,
    idempotencyKey?: string,
  ): Promise<{
    execution: Execution;
    transactionRequest: {
      chainId: number;
      to: string;
      data: string;
      value: string;
    };
  }> {
    const input = executeRequestSchema.parse({
      intentHash,
      proposalHash,
      externalSignature,
      idempotencyKey,
    });
    return this.request("POST", "/v1/execute", input, executeResponseSchema);
  }

  async getExecution(hash: string): Promise<Execution> {
    return this.request(
      "GET",
      `/v1/executions/${encodeURIComponent(hash)}`,
      undefined,
      executionSchema,
    );
  }

  async listActivity(
    input: {
      spaceId?: string;
      positionId?: string;
      chainId?: number;
      type?: ActivityType;
      status?: ActivityStatus;
      from?: number;
      to?: number;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
    const queryInput = activityQuerySchema.parse(input);
    const params = new URLSearchParams({ limit: queryInput.limit.toString() });
    for (const key of [
      "spaceId",
      "positionId",
      "chainId",
      "type",
      "status",
      "from",
      "to",
    ] as const) {
      const value = queryInput[key];
      if (value !== undefined) params.set(key, String(value));
    }
    if (queryInput.cursor) params.set("cursor", queryInput.cursor);
    return this.request(
      "GET",
      `/v1/activity?${params.toString()}`,
      undefined,
      activityResponseSchema,
    );
  }

  async getFeeSummary(
    positionId: string,
    input: { from?: number; to?: number } = {},
  ): Promise<FeeSummary> {
    const queryInput = feeSummaryQuerySchema.parse(input);
    const params = new URLSearchParams();
    if (queryInput.from !== undefined)
      params.set("from", String(queryInput.from));
    if (queryInput.to !== undefined) params.set("to", String(queryInput.to));
    const query = params.toString();
    return this.request(
      "GET",
      `/v1/positions/${encodeURIComponent(positionId)}/fees${query ? `?${query}` : ""}`,
      undefined,
      feeSummaryResponseSchema,
    );
  }

  async evaluateRisk(input: {
    positionId: string;
    observations: unknown[];
    configuration: unknown;
    hardMaximumTradeValue: string;
    hardBounds: unknown[];
    chainId: number;
    deploymentId: string;
    canonicalBlock: string;
    canonicalBlockHashes: Record<string, string>;
    nowSeconds: number;
    currentState?: unknown;
    idempotencyKey?: string;
  }): Promise<{
    positionId: string;
    evaluation: RiskEvaluation;
  }> {
    const parsed = riskEvaluateRequestSchema.parse(input);
    return this.request(
      "POST",
      "/v1/risk/evaluate",
      parsed,
      riskEvaluateResponseSchema,
    );
  }

  async saveRiskCertificate(input: {
    positionId: string;
    certificate: RiskCertificate;
    idempotencyKey?: string;
  }): Promise<{
    positionId: string;
    certificate: RiskCertificate;
  }> {
    const parsed = riskCertificateRequestSchema.parse(input);
    return this.request(
      "POST",
      "/v1/risk/certificates",
      parsed,
      riskCertificateResponseSchema,
    );
  }

  async getRiskPosition(positionId: string): Promise<RiskPositionResponse> {
    return this.request(
      "GET",
      `/v1/risk/${encodeURIComponent(positionId)}`,
      undefined,
      riskPositionResponseSchema,
    );
  }
}

export class AurkaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AurkaError";
  }
}
