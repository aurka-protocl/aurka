import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";

import {
  apiFailureSchema,
  apiResponseSchema,
  directionalCapacitySchema,
  executeRequestSchema,
  executeResponseSchema,
  executionSchema,
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
  type AtomicSettlementIntent,
} from "@aurka/shared";
import { z } from "zod";

import { AurkaService, ServiceError } from "../service.js";
import { IdempotencyConflictError } from "../db/repository.js";
import { hashCanonical } from "../solver/hash.js";
import { StructuredLogger } from "../observability.js";
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
  readonly requestBodyLimitBytes?: number;
  readonly logger?: StructuredLogger;
}

export interface ApiServerHandle {
  readonly server: Server;
  readonly service: AurkaService;
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

function openApi(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "AURKA Solver and Settlement API", version: "0.1.0" },
    paths: {
      "/v1/positions": { get: { operationId: "listPositions" } },
      "/v1/positions/{id}": { get: { operationId: "getPosition" } },
      "/v1/positions/{id}/capacity": { get: { operationId: "getCapacity" } },
      "/v1/intents": { post: { operationId: "createIntent" } },
      "/v1/intents/{id}": { get: { operationId: "getIntent" } },
      "/v1/quote": { post: { operationId: "quote" } },
      "/v1/solve": { post: { operationId: "solve" } },
      "/v1/intents/{id}/proposals": { get: { operationId: "listProposals" } },
      "/v1/execute": { post: { operationId: "execute" } },
      "/v1/executions/{hash}": { get: { operationId: "getExecution" } },
      "/v1/risk/evaluate": { post: { operationId: "evaluateRisk" } },
      "/v1/risk/certificates": { post: { operationId: "saveRiskCertificate" } },
      "/v1/risk/{positionId}": { get: { operationId: "getRisk" } },
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  service: AurkaService,
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
        { status: "ok", service: "aurka-services", version: "0.1.0" },
        request,
        healthResponseSchema,
      );
      return;
    }
    if (method === "GET" && path === "/ready") {
      const ready = service.database.sqlite
        .prepare("SELECT 1 AS ready")
        .get() as { ready: number };
      sendSuccess(
        response,
        200,
        {
          status: ready.ready === 1 ? "ready" : "not_ready",
          database: ready.ready === 1 ? "ok" : "error",
          rpc: service.runtime.rpc,
          indexerLagBlocks: 0,
        },
        request,
        readinessResponseSchema,
      );
      return;
    }
    if (method === "GET" && path === "/openapi.json") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(openApi()));
      return;
    }

    if (method === "GET" && path === "/v1/positions") {
      const query = listRequestSchema.parse(queryValues(url));
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
      sendSuccess(
        response,
        200,
        service.getPosition(decodeURIComponent(positionMatch[1]!)),
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
        service.riskService.getPosition(
          decodeURIComponent(riskPositionMatch[1]!),
        ),
        request,
        riskPositionResponseSchema,
      );
      return;
    }

    const payload = method === "POST" ? await body(request, limit) : undefined;
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
  const limit = options.requestBodyLimitBytes ?? MAX_BODY_BYTES;
  const logger = options.logger ?? new StructuredLogger();
  const server = createServer((request, response) => {
    const id = requestId(request);
    logger.info("api.request", {
      requestId: id,
      method: request.method ?? "GET",
      path: request.url ?? "/",
    });
    void handle(request, response, service, limit).finally(() => {
      logger.info("api.response", {
        requestId: id,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        statusCode: response.statusCode,
      });
    });
  });
  return { server, service };
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
