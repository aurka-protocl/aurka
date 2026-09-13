import { describe, expect, it, vi } from "vitest";

import { openRouterAgentOptionsFromEnv } from "../src/agent/openrouter.js";
import { VertexModelTransport } from "../src/agent/vertex.js";

describe("Vertex agent transport", () => {
  it("maps Gemini function calls and preserves thought signatures privately", async () => {
    const generateContent = vi.fn(async (input: unknown) => {
      expect(input).toMatchObject({
        model: "gemini-3.1-flash-lite",
        config: {
          toolConfig: {
            functionCallingConfig: {
              allowedFunctionNames: ["discover_spaces"],
            },
          },
          automaticFunctionCalling: { disable: true },
        },
      });
      return {
        modelVersion: "gemini-3.1-flash-lite",
        candidates: [
          {
            content: {
              parts: [
                { text: "private thought", thought: true },
                {
                  functionCall: {
                    name: "discover_spaces",
                    args: {},
                  },
                  thoughtSignature: "opaque-signature",
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 4,
          totalTokenCount: 16,
        },
      };
    });
    const transport = new VertexModelTransport({
      client: {
        models: { generateContent },
      } as never,
    });
    const response = await transport.complete({
      messages: [
        { role: "system", content: "Use tools only." },
        { role: "user", content: "Find a small trade." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "discover_spaces",
            description: "Discover active Spaces.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      toolChoice: {
        type: "function",
        function: { name: "discover_spaces" },
      },
      maxOutputTokens: 700,
    });

    expect(response.choices[0]?.message.content).toBeUndefined();
    expect(response.choices[0]?.message.tool_calls).toEqual([
      expect.objectContaining({
        type: "function",
        function: {
          name: "discover_spaces",
          arguments: "{}",
        },
        thoughtSignature: "opaque-signature",
      }),
    ]);
    expect(response.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
    });
  });

  it("selects Vertex explicitly without constructing an OpenRouter request", () => {
    const options = openRouterAgentOptionsFromEnv({
      AURKA_AI_PROVIDER: "vertex",
      GOOGLE_CLOUD_PROJECT: "gapwise-505217",
      GOOGLE_CLOUD_LOCATION: "global",
      AURKA_AI_CHAT_MODEL: "gemini-3.1-flash-lite",
      AURKA_AI_AGENT_MODEL: "gemini-3.1-flash-lite",
      AURKA_AGENT_TEST_MODE: "false",
    });
    expect(options.provider).toBe("vertex");
    expect(options.model).toBe("gemini-3.1-flash-lite");
    expect(options.apiKey).toBeUndefined();
    expect(options.transport?.provider).toBe("vertex");
    expect(options.transport?.model).toBe("gemini-3.1-flash-lite");
    expect(() =>
      openRouterAgentOptionsFromEnv({ AURKA_AI_PROVIDER: "gemini-3.6" }),
    ).toThrow(/Unsupported AI provider/);
  });
});
