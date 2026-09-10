import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";

import {
  activityQuerySchema,
  activityResponseSchema,
  activityTypeSchema,
  prepareIntentRequestSchema,
  prepareTokenIntentRequestSchema,
  apiFailureSchema,
  apiResponseSchema,
  directionalCapacitySchema,
  executeRequestSchema,
  executeResponseSchema,
  executionSchema,
  feeSummaryQuerySchema,
  feeSummaryResponseSchema,
  healthResponseSchema,
  listRequestSchema,
  paginatedSchema,
  positionCapacityQuerySchema,
  positionSchema,
  positionsResponseSchema,
  proposalsResponseSchema,
  quoteRequestSchema,
  quoteSchema,
  readinessResponseSchema,
  solveRequestSchema,
  solveResponseSchema,
  submitIntentRequestSchema,
  submitIntentResponseSchema,
  unsignedTransactionRequestSchema,
  atomicSettlementIntentSchema,
  agentProposalRequestSchema,
  agentProposalResponseSchema,
  agentStatusSchema,
  delegatedAuthorizationSchema,
  delegatedRecoveryRequestSchema,
  delegatedSessionIdRequestSchema,
  delegatedSessionResponseSchema,
  delegatedStartRequestSchema,
  delegatedStatusSchema,
  spaceChangesResponseSchema,
  spaceListQuerySchema,
  spaceMutationConfirmRequestSchema,
  spaceMutationPrepareRequestSchema,
  spaceMutationPrepareResponseSchema,
  spaceMutationResponseSchema,
  spaceRecordSchema,
  spacesResponseSchema,
  type AtomicSettlementIntent,
} from "@aurka/shared";
import { z } from "zod";

import { AurkaService, ServiceError } from "../service.js";
import { IdempotencyConflictError } from "../db/repository.js";
import { hashCanonical } from "../solver/hash.js";
import { StructuredLogger } from "../observability.js";
import {
  OpenRouterAgent,
  openRouterAgentOptionsFromEnv,
} from "../agent/openrouter.js";
import {
  DelegatedSessionService,
  UnavailableDelegatedWallet,
} from "../agent/delegated.js";
import {
  riskCertificateRequestSchema,
  riskCertificateResponseSchema,
  riskEvaluateRequestSchema,
  riskEvaluateResponseSchema,
  riskPositionResponseSchema,
} from "../risk-service.js";

const MAX_BODY_BYTES = 1_048_576;
export interface ApiServerOptions {
  readonly service?: AurkaService;
  readonly agent?: OpenRouterAgent;
  readonly delegated?: DelegatedSessionService;
  readonly requestBodyLimitBytes?: number;
  readonly logger?: StructuredLogger;
}

export interface ApiServerHandle {
  readonly server: Server;
  readonly service: AurkaService;
  readonly delegated: DelegatedSessionService;
}

function requestId(request: IncomingMessage): string {
  const value = request.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  request: IncomingMessage,
  schema: z.ZodType,
): void {
  const parsed = schema.parse(body);
  const encoded = JSON.stringify(parsed);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId(request),
  });
  response.end(encoded);
}

function sendSuccess(
  response: ServerResponse,
  statusCode: number,
  data: unknown,
  request: IncomingMessage,
  dataSchema: z.ZodType,
): void {
  send(
    response,
    statusCode,
    { ok: true, data },
    request,
    apiResponseSchema(dataSchema),
  );
}

function sendFailure(
  response: ServerResponse,
  statusCode: number,
  error: ServiceError | Error,
  request: IncomingMessage,
): void {
  const serviceError =
    error instanceof ServiceError
      ? error
      : new ServiceError("INTERNAL_ERROR", "Internal service error", 500);
  send(
    response,
    statusCode,
    {
      ok: false,
      error: {
        code: serviceError.code,
        message: serviceError.message,
        ...(Object.keys(serviceError.details).length === 0
          ? {}
          : { details: serviceError.details }),
        requestId: requestId(request),
      },
    },
    request,
    apiFailureSchema,
  );
}

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit)
      throw new ServiceError(
        "REQUEST_TOO_LARGE",
        "Request body exceeds the configured limit",
        413,
      );
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ServiceError(
      "INVALID_JSON",
      "Request body is not valid JSON",
      400,
    );
  }
}

function queryValues(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

function idempotencyKey(
  request: IncomingMessage,
  payload: unknown,
): string | undefined {
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.length > 0) return header;
  if (payload && typeof payload === "object" && "idempotencyKey" in payload) {
    const value = payload.idempotencyKey;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  return undefined;
}

async function withIdempotency<T>(
  service: AurkaService,
  request: IncomingMessage,
  path: string,
  payload: unknown,
  callback: () => Promise<{ statusCode: number; data: T }>,
): Promise<{ statusCode: number; data: T; cached: boolean }> {
  const key = idempotencyKey(request, payload);
  if (!key) {
    const result = await callback();
    return { ...result, cached: false };
  }
  const method = request.method ?? "POST";
  const requestHash = hashCanonical(payload);
  // Atomically claim the slot; returns existing response if COMPLETED or throws 409.
  const existing = service.repository.claimIdempotencyKey(
    key,
    method,
    path,
    requestHash,
  );
  if (existing)
    return {
      statusCode: existing.statusCode,
      data: existing.body as T,
      cached: true,
    };
  try {
    const result = await callback();
    service.repository.completeIdempotencyResponse(key, {
      statusCode: result.statusCode,
      body: result.data,
    });
    return { ...result, cached: false };
  } catch (error) {
    service.repository.releaseIdempotencyKey(key, requestHash);
    throw error;
  }
}

export function openApi(): Record<string, unknown> {
  const contracts: [string, string, z.ZodType | undefined, z.ZodType][] = [
    ["/health", "get", undefined, healthResponseSchema],
    ["/ready", "get", undefined, readinessResponseSchema],
    ["/v1/positions", "get", undefined, positionsResponseSchema],
    ["/v1/spaces", "get", undefined, spacesResponseSchema],
    [
      "/v1/spaces/prepare",
      "post",
      spaceMutationPrepareRequestSchema,
      spaceMutationPrepareResponseSchema,
    ],
    [
      "/v1/spaces/confirm",
      "post",
      spaceMutationConfirmRequestSchema,
      spaceMutationResponseSchema,
    ],
    ["/v1/spaces/{id}", "get", undefined, spaceRecordSchema],
    ["/v1/spaces/{id}/changes", "get", undefined, spaceChangesResponseSchema],
    ["/v1/activity", "get", undefined, activityResponseSchema],
    ["/v1/positions/{id}", "get", undefined, positionSchema],
    ["/v1/positions/{id}/fees", "get", undefined, feeSummaryResponseSchema],
    [
      "/v1/positions/{id}/capacity",
      "get",
      undefined,
      directionalCapacitySchema,
    ],
    [
      "/v1/intents/prepare",
      "post",
      prepareIntentRequestSchema,
      atomicSettlementIntentSchema,
    ],
    [
      "/v1/intents/prepare-token",
      "post",
      prepareTokenIntentRequestSchema,
      atomicSettlementIntentSchema,
    ],
    [
      "/v1/intents",
      "post",
      submitIntentRequestSchema,
      submitIntentResponseSchema,
    ],
    ["/v1/intents/{id}", "get", undefined, atomicSettlementIntentSchema],
    ["/v1/intents/{id}/proposals", "get", undefined, proposalsResponseSchema],
    ["/v1/quote", "post", quoteRequestSchema, quoteSchema],
    ["/v1/solve", "post", solveRequestSchema, solveResponseSchema],
    ["/v1/execute", "post", executeRequestSchema, executeResponseSchema],
    ["/v1/executions/{hash}", "get", undefined, executionSchema],
    [
      "/v1/risk/evaluate",
      "post",
      riskEvaluateRequestSchema,
      riskEvaluateResponseSchema,
    ],
    [
      "/v1/risk/certificates",
      "post",
      riskCertificateRequestSchema,
      riskCertificateResponseSchema,
    ],
    ["/v1/risk/{positionId}", "get", undefined, riskPositionResponseSchema],
    ["/v1/agent/status", "get", undefined, agentStatusSchema],
    [
      "/v1/agent/propose",
      "post",
      agentProposalRequestSchema,
      agentProposalResponseSchema,
    ],
    ["/v1/delegated/status", "get", undefined, delegatedStatusSchema],
    [
      "/v1/delegated/sessions/authorize",
      "post",
      delegatedAuthorizationSchema,
      delegatedSessionResponseSchema,
    ],
    [
      "/v1/delegated/sessions/{id}",
      "get",
      undefined,
      delegatedSessionResponseSchema,
    ],
    [
      "/v1/delegated/sessions/{id}/start",
      "post",
      delegatedStartRequestSchema,
      delegatedSessionResponseSchema,
    ],
    [
      "/v1/delegated/sessions/{id}/stop",
      "post",
      delegatedSessionIdRequestSchema,
      delegatedSessionResponseSchema,
    ],
    [
      "/v1/delegated/sessions/{id}/reconcile",
      "post",
      delegatedSessionIdRequestSchema,
      delegatedSessionResponseSchema,
    ],
    [
      "/v1/delegated/sessions/{id}/recover",
      "post",
      delegatedRecoveryRequestSchema,
      delegatedSessionResponseSchema,
    ],
  ];
  const content = (schema: z.ZodType) => ({
    "application/json": {
      schema: z.toJSONSchema(schema, { unrepresentable: "any" }),
    },
  });
  const paths: Record<string, unknown> = {};
  for (const [path, method, input, output] of contracts) {
    const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      }),
    );
    if (path === "/v1/positions")
      parameters.push(
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      );
    if (path === "/v1/spaces")
      parameters.push(
        {
          name: "ownerAddress",
          in: "query",
          schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      );
    if (path === "/v1/activity")
      parameters.push(
        { name: "spaceId", in: "query", schema: { type: "string" } },
        { name: "positionId", in: "query", schema: { type: "string" } },
        {
          name: "chainId",
          in: "query",
          schema: { type: "integer", minimum: 1 },
        },
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: ["PREPARED", "PENDING", "CONFIRMED", "FAILED", "ORPHANED"],
          },
        },
        {
          name: "type",
          in: "query",
          schema: {
            type: "string",
            enum: activityTypeSchema.options,
          },
        },
        { name: "from", in: "query", schema: { type: "integer", minimum: 0 } },
        { name: "to", in: "query", schema: { type: "integer", minimum: 0 } },
      );
    if (path === "/v1/positions/{id}/fees")
      parameters.push(
        { name: "from", in: "query", schema: { type: "integer", minimum: 0 } },
        { name: "to", in: "query", schema: { type: "integer", minimum: 0 } },
      );
    if (path.endsWith("/capacity"))
      for (const name of ["traderInputToken", "traderOutputToken"])
        parameters.push({
          name,
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        });
    const success =
      path === "/v1/execute"
        ? "202"
        : path === "/v1/intents" || path === "/v1/risk/certificates"
          ? "201"
          : "200";
    paths[path] = {
      [method]: {
        parameters,
        ...(input
          ? { requestBody: { required: true, content: content(input) } }
          : {}),
        responses: {
          [success]: {
            description: "Success",
            content: content(apiResponseSchema(output)),
          },
          default: {
            description: "Typed API error",
            content: content(apiFailureSchema),
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "AURKA API", version: "0.2.0" },
    paths,
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  service: AurkaService,
  agent: OpenRouterAgent,
  delegated: DelegatedSessionService,
  limit: number,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const path = url.pathname;
  try {
    if (method === "GET" && path === "/health") {
      sendSuccess(
        response,
        200,
        {
          status: "ok",
          service: "aurka-services",
          version: "0.1.0",
          observedAt: Math.floor(Date.now() / 1000),
        },
        request,
        healthResponseSchema,
      );
      return;
    }
    if (method === "GET" && path === "/ready") {
      const readiness = await service.getReadiness();
      sendSuccess(response, 200, readiness, request, readinessResponseSchema);
      return;
    }
    if (method === "GET" && path === "/openapi.json") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(openApi()));
      return;
    }

    if (method === "GET" && path === "/v1/agent/status") {
      sendSuccess(response, 200, agent.status(), request, agentStatusSchema);
      return;
    }

    if (method === "GET" && path === "/v1/delegated/status") {
      sendSuccess(
        response,
        200,
        await delegated.status(),
        request,
        delegatedStatusSchema,
      );
      return;
    }

    const delegatedSessionMatch = path.match(
      /^\/v1\/delegated\/sessions\/([^/]+)$/,
    );
    if (method === "GET" && delegatedSessionMatch) {
      sendSuccess(
        response,
        200,
        delegated.get(decodeURIComponent(delegatedSessionMatch[1]!)),
        request,
        delegatedSessionResponseSchema,
      );
      return;
    }

    if (method === "GET" && path === "/v1/spaces") {
      const query = spaceListQuerySchema.parse(queryValues(url));
      await service.refreshSpaces(query.ownerAddress);
      sendSuccess(
        response,
        200,
        service.listSpaces(query.limit, query.cursor, query.ownerAddress),
        request,
        spacesResponseSchema,
      );
      return;
    }

    const spaceChangesMatch = path.match(/^\/v1\/spaces\/([^/]+)\/changes$/);
    if (method === "GET" && spaceChangesMatch) {
      sendSuccess(
        response,
        200,
        service.listSpaceChanges(decodeURIComponent(spaceChangesMatch[1]!)),
        request,
        spaceChangesResponseSchema,
      );
      return;
    }

    const spaceMatch = path.match(/^\/v1\/spaces\/([^/]+)$/);
    if (method === "GET" && spaceMatch) {
      const spaceId = decodeURIComponent(spaceMatch[1]!);
      await service.refreshSpace(spaceId);
      sendSuccess(
        response,
        200,
        service.getSpace(spaceId),
        request,
        spaceRecordSchema,
      );
      return;
    }

    if (method === "GET" && path === "/v1/positions") {
      const query = listRequestSchema.parse(queryValues(url));
      await service.refreshPositions();
      sendSuccess(
        response,
        200,
        paginatedSchema(positionSchema).parse(
          service.listPositions(query.limit, query.cursor),
        ),
        request,
        positionsResponseSchema,
      );
      return;
    }

    if (method === "GET" && path === "/v1/activity") {
      const query = activityQuerySchema.parse(queryValues(url));
      sendSuccess(
        response,
        200,
        service.listActivity(query),
        request,
        activityResponseSchema,
      );
      return;
    }

    const feeSummaryMatch = path.match(/^\/v1\/positions\/([^/]+)\/fees$/);
    if (method === "GET" && feeSummaryMatch) {
      const query = feeSummaryQuerySchema.parse(queryValues(url));
      sendSuccess(
        response,
        200,
        service.getFeeSummary(decodeURIComponent(feeSummaryMatch[1]!), query),
        request,
        feeSummaryResponseSchema,
      );
      return;
    }

    const capacityMatch = path.match(/^\/v1\/positions\/([^/]+)\/capacity$/);
    if (method === "GET" && capacityMatch) {
      const query = positionCapacityQuerySchema.parse(queryValues(url));
      const capacity = await service.getCapacity(
        decodeURIComponent(capacityMatch[1]!),
        query.traderInputToken,
        query.traderOutputToken,
      );
      sendSuccess(response, 200, capacity, request, directionalCapacitySchema);
      return;
    }

    const positionMatch = path.match(/^\/v1\/positions\/([^/]+)$/);
    if (method === "GET" && positionMatch) {
      const positionId = decodeURIComponent(positionMatch[1]!);
      await service.refreshPosition(positionId);
      sendSuccess(
        response,
        200,
        service.getPosition(positionId),
        request,
        positionSchema,
      );
      return;
    }

    const riskPositionMatch = path.match(/^\/v1\/risk\/([^/]+)$/);
    if (method === "GET" && riskPositionMatch) {
      sendSuccess(
        response,
        200,
        await service.riskService.getPositionLive(
          decodeURIComponent(riskPositionMatch[1]!),
        ),
        request,
        riskPositionResponseSchema,
      );
      return;
    }

    const payload = method === "POST" ? await body(request, limit) : undefined;
    if (method === "POST" && path === "/v1/agent/propose") {
      const input = agentProposalRequestSchema.parse(payload);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      try {
        const result = await agent.propose(input, controller.signal);
        if (controller.signal.aborted || response.writableEnded) return;
        sendSuccess(
          response,
          200,
          result,
          request,
          agentProposalResponseSchema,
        );
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
      return;
    }
    if (method === "POST" && path === "/v1/delegated/sessions/authorize") {
      const input = delegatedAuthorizationSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 201,
          data: await delegated.authorize(input),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        delegatedSessionResponseSchema,
      );
      return;
    }
    const delegatedStartMatch = path.match(
      /^\/v1\/delegated\/sessions\/([^/]+)\/start$/,
    );
    if (method === "POST" && delegatedStartMatch) {
      const input = delegatedStartRequestSchema.parse(payload);
      const sessionId = decodeURIComponent(delegatedStartMatch[1]!);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 200,
          data: await delegated.start(sessionId, input.message),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        delegatedSessionResponseSchema,
      );
      return;
    }
    const delegatedStopMatch = path.match(
      /^\/v1\/delegated\/sessions\/([^/]+)\/(stop|reconcile)$/,
    );
    if (method === "POST" && delegatedStopMatch) {
      const sessionId = decodeURIComponent(delegatedStopMatch[1]!);
      const operation = delegatedStopMatch[2];
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 200,
          data:
            operation === "stop"
              ? await delegated.stop(sessionId)
              : await delegated.reconcile(sessionId),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        delegatedSessionResponseSchema,
      );
      return;
    }
    const delegatedRecoveryMatch = path.match(
      /^\/v1\/delegated\/sessions\/([^/]+)\/recover$/,
    );
    if (method === "POST" && delegatedRecoveryMatch) {
      const input = delegatedRecoveryRequestSchema.parse(payload);
      const sessionId = decodeURIComponent(delegatedRecoveryMatch[1]!);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 200,
          data: await delegated.recover(sessionId, input),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        delegatedSessionResponseSchema,
      );
      return;
    }
    if (method === "POST" && path === "/v1/spaces/prepare") {
      const input = spaceMutationPrepareRequestSchema.parse(payload);
      sendSuccess(
        response,
        200,
        service.prepareSpaceMutation(input),
        request,
        spaceMutationPrepareResponseSchema,
      );
      return;
    }
    if (method === "POST" && path === "/v1/spaces/confirm") {
      const input = spaceMutationConfirmRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 200,
          data: await service.confirmSpaceMutation(input),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        spaceMutationResponseSchema,
      );
      return;
    }
    if (method === "POST" && path === "/v1/intents/prepare") {
      const input = prepareIntentRequestSchema.parse(payload);
      service.getPosition(input.positionId);
      if (!service.provider.prepareIntent)
        throw new ServiceError(
          "PREPARATION_UNAVAILABLE",
          "The configured provider does not support intent preparation",
          503,
        );
      const intent = await service.provider.prepareIntent(input);
      sendSuccess(response, 200, intent, request, atomicSettlementIntentSchema);
      return;
    }
    if (method === "POST" && path === "/v1/intents/prepare-token") {
      const input = prepareTokenIntentRequestSchema.parse(payload);
      const intent = await service.prepareTokenIntent(input);
      sendSuccess(response, 200, intent, request, atomicSettlementIntentSchema);
      return;
    }
    if (method === "POST" && path === "/v1/risk/evaluate") {
      const input = riskEvaluateRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 200,
          data: service.riskService.evaluate(input),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        riskEvaluateResponseSchema,
      );
      return;
    }
    if (method === "POST" && path === "/v1/risk/certificates") {
      const input = riskCertificateRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 201,
          data: service.riskService.saveCertificate(input),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        riskCertificateResponseSchema,
      );
      return;
    }
    if (method === "POST" && path === "/v1/intents") {
      const input = submitIntentRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 201,
          data: await service.submitIntent(input.intent),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        submitIntentResponseSchema,
      );
      return;
    }

    const intentProposalMatch = path.match(
      /^\/v1\/intents\/([^/]+)\/proposals$/,
    );
    if (method === "GET" && intentProposalMatch) {
      sendSuccess(
        response,
        200,
        await service.listProposals(
          decodeURIComponent(intentProposalMatch[1]!),
        ),
        request,
        proposalsResponseSchema,
      );
      return;
    }

    const intentMatch = path.match(/^\/v1\/intents\/([^/]+)$/);
    if (method === "GET" && intentMatch) {
      const intent = service.repository.getIntent(
        decodeURIComponent(intentMatch[1]!),
      );
      if (!intent)
        throw new ServiceError("INTENT_NOT_FOUND", "Intent was not found", 404);
      sendSuccess(response, 200, intent, request, atomicSettlementIntentSchema);
      return;
    }

    if (method === "POST" && path === "/v1/quote") {
      const input = quoteRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 200,
          data: await service.quote(input.intent),
        }),
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        quoteSchema,
      );
      return;
    }

    if (method === "POST" && path === "/v1/solve") {
      const input = solveRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => {
          await service.submitIntent(input.intent);
          return { statusCode: 200, data: await service.solve(input.intent) };
        },
      );
      sendSuccess(
        response,
        result.statusCode,
        result.data,
        request,
        solveResponseSchema,
      );
      return;
    }

    if (method === "POST" && path === "/v1/execute") {
      const input = executeRequestSchema.parse(payload);
      const result = await withIdempotency(
        service,
        request,
        path,
        payload,
        async () => ({
          statusCode: 202,
          data: await service.execute(
            input.intentHash,
            input.proposalHash,
            input.externalSignature,
          ),
        }),
      );
      const transaction = unsignedTransactionRequestSchema.parse(
        result.data.transactionRequest,
      );
      sendSuccess(
        response,
        result.statusCode,
        { ...result.data, transactionRequest: transaction },
        request,
        executeResponseSchema,
      );
      return;
    }

    const executionMatch = path.match(/^\/v1\/executions\/([^/]+)$/);
    if (method === "GET" && executionMatch) {
      sendSuccess(
        response,
        200,
        service.getExecution(decodeURIComponent(executionMatch[1]!)),
        request,
        executionSchema,
      );
      return;
    }

    throw new ServiceError("NOT_FOUND", "Route was not found", 404);
  } catch (error) {
    if (response.headersSent || response.writableEnded) return;
    if (error instanceof z.ZodError) {
      sendFailure(
        response,
        400,
        new ServiceError("INVALID_REQUEST", "Request validation failed", 400, {
          issues: error.issues,
        }),
        request,
      );
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      sendFailure(
        response,
        409,
        new ServiceError("IDEMPOTENCY_CONFLICT", error.message, 409),
        request,
      );
      return;
    }
    const statusCode = error instanceof ServiceError ? error.statusCode : 500;
    sendFailure(
      response,
      statusCode,
      error instanceof Error ? error : new Error("Unknown error"),
      request,
    );
  }
}

export function createApiServer(
  options: ApiServerOptions = {},
): ApiServerHandle {
  const service = options.service ?? new AurkaService();
  const agent =
    options.agent ??
    new OpenRouterAgent(service, openRouterAgentOptionsFromEnv());
  const delegated =
    options.delegated ??
    new DelegatedSessionService(
      service,
      agent,
      new UnavailableDelegatedWallet(),
    );
  const limit = options.requestBodyLimitBytes ?? MAX_BODY_BYTES;
  const logger = options.logger ?? new StructuredLogger();
  const server = createServer((request, response) => {
    const id = requestId(request);
    logger.info("api.request", {
      requestId: id,
      method: request.method ?? "GET",
      path: request.url ?? "/",
    });
    void handle(request, response, service, agent, delegated, limit).finally(
      () => {
        logger.info("api.response", {
          requestId: id,
          method: request.method ?? "GET",
          path: request.url ?? "/",
          statusCode: response.statusCode,
        });
      },
    );
  });
  return { server, service, delegated };
}

export async function listenApiServer(
  handleValue: ApiServerHandle,
  port: number,
  host = "127.0.0.1",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      handleValue.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      handleValue.server.off("error", onError);
      resolve();
    };
    handleValue.server.once("error", onError);
    handleValue.server.once("listening", onListening);
    handleValue.server.listen(port, host);
  });
}

export async function closeApiServer(
  handleValue: ApiServerHandle,
): Promise<void> {
  handleValue.service.close();
  if (!handleValue.server.listening) return;
  await new Promise<void>((resolve, reject) =>
    handleValue.server.close((error) => (error ? reject(error) : resolve())),
  );
}

export type { AtomicSettlementIntent };
