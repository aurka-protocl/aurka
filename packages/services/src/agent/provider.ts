import type { AgentUnavailableCode } from "@aurka/shared";

export type AgentProvider = "openrouter" | "vertex";

export type ModelToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
  /** Gemini thought signatures are provider metadata, never user-visible. */
  readonly thoughtSignature?: string;
};

export type ModelMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly ModelToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
};

export type ModelResponse = {
  readonly choices: readonly [
    {
      readonly finish_reason?: string;
      readonly message: {
        readonly role: "assistant";
        readonly content?: unknown;
        readonly tool_calls?: unknown;
      };
    },
  ];
  readonly model?: unknown;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
};

export type AgentProviderTelemetry = {
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

export type ModelToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
};

export type ModelCompletionRequest = {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: unknown;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
};

export interface ModelTransport {
  readonly provider: AgentProvider;
  readonly model: string;
  readonly configured: boolean;
  complete(request: ModelCompletionRequest): Promise<ModelResponse>;
}

export class AgentProviderError extends Error {
  constructor(
    readonly code: AgentUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderError";
  }
}
