import type {
  AtomicSettlementIntent,
  AtomicSettlementProposal,
} from "@aurka/shared";

import { DeterministicRouterSimulator } from "../fixture.js";
import {
  buildRouterTransactionRequest,
  type RouterTransactionRequest,
} from "./calldata.js";
import { hashIntent } from "./hash.js";
import type {
  ProposalSimulation,
  RouterSimulator,
  SolverSnapshot,
} from "./types.js";

export interface Eip1193Transport {
  request(input: {
    readonly method: string;
    readonly params?: readonly unknown[];
  }): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Router eth_call reverted";
}

function traceMessage(trace: unknown): string | undefined {
  if (!trace || typeof trace !== "object") return undefined;
  const calls: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const call = node as Record<string, unknown>;
    calls.push(call);
    if (Array.isArray(call.calls)) call.calls.forEach(visit);
  };
  visit(trace);
  const summary = calls
    .map((call) => {
      const to = typeof call.to === "string" ? call.to : "?";
      const input =
        typeof call.input === "string" ? call.input.slice(0, 10) : "?";
      const error = typeof call.error === "string" ? ` ${call.error}` : "";
      const output =
        typeof call.output === "string" ? ` ${call.output.slice(0, 74)}` : "";
      return `${to} ${input}${error}${output}`;
    })
    .join("; ");
  return summary.length === 0 ? undefined : summary.slice(0, 400);
}

/**
 * Exact router boundary. A missing trader signature is expected while a
 * proposal is being quoted, so `simulate` performs the deterministic
 * preflight in that case. `simulateExact` is used by execution after the
 * external signature has been verified and always performs `eth_call`.
 */
export class Eip1193RouterSimulator implements RouterSimulator {
  constructor(
    private readonly transport: Eip1193Transport,
    private readonly preflight: RouterSimulator = new DeterministicRouterSimulator(),
  ) {}

  async simulate(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
  ): Promise<ProposalSimulation> {
    const preflight = await this.preflight.simulate(intent, proposal, snapshot);
    if (preflight.status !== "SUCCEEDED") return preflight;
    if (intent.signature === undefined) {
      return {
        status: "AUTHORIZATION_PENDING",
        gasEstimate: 0n,
        reason:
          "Deterministic preflight passed; exact eth_call awaits trader authorization",
      };
    }
    return this.simulateExact(intent, proposal, snapshot);
  }

  async simulateExact(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
  ): Promise<ProposalSimulation> {
    if (intent.signature === undefined) {
      return {
        status: "REVERTED",
        gasEstimate: 0n,
        reason: "Trader signature is required for exact router simulation",
      };
    }
    const intentHash = hashIntent(intent, snapshot);
    const request = buildRouterTransactionRequest(
      intent,
      proposal,
      snapshot,
      intentHash,
      intent.signature,
    );
    const call = toEthCall(request);
    try {
      const result = await this.transport.request({
        method: "eth_call",
        params: [call, `0x${snapshot.snapshotBlock.toString(16)}`],
      });
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
        return {
          status: "REVERTED",
          gasEstimate: 0n,
          reason: "Malformed eth_call result",
        };
      }
      return {
        status: "SUCCEEDED",
        // eth_call proves execution; gas estimation is deliberately left to
        // the wallet/broadcaster boundary and is not fabricated here.
        gasEstimate: 0n,
      };
    } catch (error) {
      let trace: string | undefined;
      try {
        trace = traceMessage(
          await this.transport.request({
            method: "debug_traceCall",
            params: [
              call,
              `0x${snapshot.snapshotBlock.toString(16)}`,
              { tracer: "callTracer" },
            ],
          }),
        );
      } catch {
        // A production RPC may not expose debug tracing; the original
        // eth_call error remains the authoritative simulation result.
      }
      const reason = `${errorMessage(error)}${trace ? ` [trace ${trace}]` : ""}`;
      return {
        status: "REVERTED",
        gasEstimate: 0n,
        reason: reason.slice(0, 500),
      };
    }
  }
}

function toEthCall(request: RouterTransactionRequest): Record<string, string> {
  return {
    to: request.to,
    data: request.data,
    value: `0x${BigInt(request.value).toString(16)}`,
  };
}

/** Minimal JSON-RPC client; chain reads remain behind EIP-1193 interfaces. */
export class JsonRpcHttpTransport implements Eip1193Transport {
  constructor(private readonly url: string) {}

  async request(input: {
    readonly method: string;
    readonly params?: readonly unknown[];
  }): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: input.method,
        params: input.params ?? [],
      }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = (await response.json()) as {
      jsonrpc?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    if (body.jsonrpc !== "2.0") throw new Error("Malformed JSON-RPC response");
    if (body.error) {
      const detail =
        typeof (body.error as { data?: unknown }).data === "string"
          ? `: ${(body.error as { data: string }).data}`
          : "";
      throw new Error(`${body.error.message ?? "RPC request failed"}${detail}`);
    }
    if (!Object.prototype.hasOwnProperty.call(body, "result"))
      throw new Error("Malformed JSON-RPC response: missing result");
    return body.result;
  }
}
