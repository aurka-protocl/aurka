import type { z } from "zod";

import {
  prepareIntentRequestSchema,
  type PrepareIntentRequest,
  apiResponseSchema,
  apiFailureSchema,
  healthResponseSchema,
  readinessResponseSchema,
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
  riskEvaluateRequestSchema,
  riskEvaluateResponseSchema,
  riskCertificateRequestSchema,
  riskCertificateResponseSchema,
  listRequestSchema,
  positionsResponseSchema,
  proposalsResponseSchema,
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

  async health(): Promise<{
    status: string;
    service: string;
    version: string;
  }> {
    return this.request("GET", "/health", undefined, healthResponseSchema);
  }

  async readiness(): Promise<{
    status: "ready" | "not_ready";
    database: "ok" | "error";
    rpc: "fixture-only" | "configured" | "error";
    indexerLagBlocks: number | null;
    risk: "not_configured" | "unverified";
  }> {
    return this.request("GET", "/ready", undefined, readinessResponseSchema);
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
