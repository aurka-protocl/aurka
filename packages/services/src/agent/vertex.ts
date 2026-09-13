import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";

import {
  AgentProviderError,
  type ModelCompletionRequest,
  type ModelMessage,
  type ModelResponse,
  type ModelToolCall,
  type ModelTransport,
} from "./provider.js";

const DEFAULT_PROJECT = "gapwise-505217";
const DEFAULT_LOCATION = "global";
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

type VertexPart = {
  readonly text?: unknown;
  readonly thought?: unknown;
  readonly thoughtSignature?: unknown;
  readonly functionCall?: { readonly name?: unknown; readonly args?: unknown };
};

function textContent(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { error: "Tool result was not valid JSON" };
  }
}

function vertexContents(messages: readonly ModelMessage[]): {
  readonly systemInstruction?: string;
  readonly contents: readonly Record<string, unknown>[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map(textContent)
    .filter(Boolean)
    .join("\n\n");
  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: textContent(message) }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (textContent(message)) parts.push({ text: textContent(message) });
      for (const call of message.tool_calls ?? []) {
        parts.push({
          functionCall: {
            name: call.function.name,
            args: parseJson(call.function.arguments),
          },
          ...(call.thoughtSignature
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.name ?? "unknown_tool",
            ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
            response: parseJson(textContent(message)),
          },
        },
      ],
    });
  }
  return {
    ...(system ? { systemInstruction: system } : {}),
    contents,
  };
}

function providerError(error: unknown): AgentProviderError {
  const record = error as {
    readonly status?: unknown;
    readonly code?: unknown;
  };
  const description = error instanceof Error ? error.message.toLowerCase() : "";
  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof record?.code === "number"
        ? record.code
        : undefined;
  const message = "The Vertex AI request was rejected.";
  if (
    status === 401 ||
    status === 403 ||
    /unauthenticated|permission denied|authentication/i.test(description)
  )
    return new AgentProviderError("AUTHENTICATION_REJECTED", message);
  if (status === 429 || /rate.?limit|resource exhausted/i.test(description))
    return new AgentProviderError("RATE_LIMITED", message);
  if (
    status === 408 ||
    status === 504 ||
    /timeout|timed out/i.test(description)
  )
    return new AgentProviderError("TIMEOUT", message);
  if (status !== undefined && status >= 500)
    return new AgentProviderError("PROVIDER_OUTAGE", message);
  return new AgentProviderError(
    "NETWORK_ERROR",
    "The Vertex AI provider could not be reached.",
  );
}

function responseFromVertex(response: {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly VertexPart[] };
    readonly finishReason?: unknown;
  }[];
  readonly modelVersion?: unknown;
  readonly usageMetadata?: {
    readonly promptTokenCount?: unknown;
    readonly candidatesTokenCount?: unknown;
    readonly totalTokenCount?: unknown;
  };
}): ModelResponse {
  const candidate = response.candidates?.[0];
  if (!candidate)
    throw new AgentProviderError(
      "MALFORMED_RESPONSE",
      "Vertex AI returned no candidate.",
    );
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts))
    throw new AgentProviderError(
      "MALFORMED_RESPONSE",
      "Vertex AI returned malformed content.",
    );
  const calls: ModelToolCall[] = [];
  const visibleText: string[] = [];
  parts.forEach((part, index) => {
    if (typeof part.text === "string" && part.thought !== true)
      visibleText.push(part.text);
    const functionCall = part.functionCall;
    if (!functionCall) return;
    if (
      typeof functionCall.name !== "string" ||
      !functionCall.name.trim() ||
      !functionCall.args ||
      typeof functionCall.args !== "object" ||
      Array.isArray(functionCall.args)
    )
      throw new AgentProviderError(
        "MALFORMED_RESPONSE",
        "Vertex AI returned malformed function-call arguments.",
      );
    calls.push({
      id: `vertex-tool-${index}`,
      type: "function",
      function: {
        name: functionCall.name,
        arguments: JSON.stringify(functionCall.args),
      },
      ...(typeof part.thoughtSignature === "string"
        ? { thoughtSignature: part.thoughtSignature }
        : {}),
    });
  });
  const usage = response.usageMetadata;
  const numberValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : undefined;
  const inputTokens = numberValue(usage?.promptTokenCount);
  const outputTokens = numberValue(usage?.candidatesTokenCount);
  const totalTokens = numberValue(usage?.totalTokenCount);
  return {
    choices: [
      {
        ...(typeof candidate.finishReason === "string"
          ? { finish_reason: candidate.finishReason }
          : {}),
        message: {
          role: "assistant",
          ...(visibleText.length > 0
            ? { content: visibleText.join("\n") }
            : {}),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        },
      },
    ],
    ...(typeof response.modelVersion === "string"
      ? { model: response.modelVersion }
      : {}),
    ...(inputTokens !== undefined ||
    outputTokens !== undefined ||
    totalTokens !== undefined
      ? {
          usage: {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
          },
        }
      : {}),
  };
}

export interface VertexModelTransportOptions {
  readonly project?: string;
  readonly location?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly client?: GoogleGenAI;
}

/** Thin Vertex adapter. ADC is resolved by @google/genai from the VM identity. */
export class VertexModelTransport implements ModelTransport {
  readonly provider = "vertex" as const;
  readonly model: string;
  readonly configured: boolean;
  private readonly project: string;
  private readonly location: string;
  private readonly timeoutMs: number;
  private readonly client: GoogleGenAI;

  constructor(options: VertexModelTransportOptions = {}) {
    this.project = options.project?.trim() || DEFAULT_PROJECT;
    this.location = options.location?.trim() || DEFAULT_LOCATION;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? 60_000, 1_000),
      60_000,
    );
    this.configured = Boolean(this.project && this.location && this.model);
    this.client =
      options.client ??
      new GoogleGenAI({
        vertexai: true,
        project: this.project,
        location: this.location,
      });
  }

  async complete(request: ModelCompletionRequest): Promise<ModelResponse> {
    if (!this.configured)
      throw new AgentProviderError(
        "MISSING_CONFIGURATION",
        "Vertex AI project, location, or model is not configured.",
      );
    const converted = vertexContents(request.messages);
    const forcedToolName =
      request.toolChoice && typeof request.toolChoice === "object"
        ? (
            request.toolChoice as {
              readonly function?: { readonly name?: unknown };
            }
          ).function?.name
        : undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: converted.contents as never,
        config: {
          ...(converted.systemInstruction
            ? { systemInstruction: converted.systemInstruction }
            : {}),
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description,
                parametersJsonSchema: tool.function.parameters,
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: forcedToolName
              ? {
                  mode: FunctionCallingConfigMode.ANY,
                  allowedFunctionNames: [String(forcedToolName)],
                }
              : { mode: FunctionCallingConfigMode.AUTO },
          },
          automaticFunctionCalling: { disable: true },
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens,
          ...(request.signal ? { abortSignal: request.signal } : {}),
          httpOptions: { timeout: this.timeoutMs },
        },
      });
      return responseFromVertex(response);
    } catch (error) {
      if (error instanceof AgentProviderError) throw error;
      if (request.signal?.aborted)
        throw new AgentProviderError(
          "TIMEOUT",
          "The Vertex AI request exceeded its time budget.",
        );
      throw providerError(error);
    }
  }
}
