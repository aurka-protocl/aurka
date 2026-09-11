/* global AbortSignal, Buffer, console, fetch, process */
import { createServer } from "node:http";

const DEFAULT_ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_SEND_RATE_LIMIT_PER_MINUTE = 12;

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRequest(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    (value.params === undefined || Array.isArray(value.params)) &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null)
  );
}

function rateKey(request) {
  return request.socket.remoteAddress ?? "unknown";
}

function createRateLimiter(limit, windowMs = 60_000) {
  const entries = new Map();
  return (key) => {
    const now = Date.now();
    const previous = entries.get(key);
    const entry =
      previous && now - previous.startedAt < windowMs
        ? previous
        : { startedAt: now, count: 0 };
    entry.count += 1;
    entries.set(key, entry);
    if (entries.size > 10_000) {
      for (const [candidate, value] of entries)
        if (now - value.startedAt >= windowMs) entries.delete(candidate);
    }
    return entry.count <= limit;
  };
}

export function createFilteredRpcServer(options = {}) {
  const upstreamUrl = options.upstreamUrl ?? process.env.RPC_UPSTREAM_URL;
  if (!upstreamUrl) throw new Error("RPC_UPSTREAM_URL is required");
  const allowedMethods = options.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateLimit = createRateLimiter(
    options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
  );
  const sendRateLimit = createRateLimiter(
    options.sendRateLimitPerMinute ?? DEFAULT_SEND_RATE_LIMIT_PER_MINUTE,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, service: "aurka-rpc-proxy" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "POST is required" });
      return;
    }
    if (!rateLimit(rateKey(request))) {
      json(response, 429, { error: "RPC rate limit exceeded" });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(request, maxBodyBytes));
    } catch (error) {
      json(
        response,
        error?.message === "body_too_large" ? 413 : 400,
        rpcError(null, -32600, "A single JSON-RPC object is required"),
      );
      return;
    }
    if (!isRequest(payload)) {
      json(response, 400, rpcError(null, -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (!allowedMethods.has(payload.method)) {
      json(
        response,
        403,
        rpcError(payload.id, -32601, "RPC method is not exposed"),
      );
      return;
    }
    if (
      payload.method === "eth_sendRawTransaction" &&
      !sendRateLimit(rateKey(request))
    ) {
      json(
        response,
        429,
        rpcError(payload.id, -32005, "RPC send rate limit exceeded"),
      );
      return;
    }

    try {
      const upstream = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await upstream.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        json(
          response,
          502,
          rpcError(payload.id, -32000, "Invalid upstream RPC response"),
        );
        return;
      }
      json(response, upstream.ok ? 200 : 502, value);
    } catch {
      json(
        response,
        502,
        rpcError(payload.id, -32000, "Upstream RPC unavailable"),
      );
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith("filtered-rpc-proxy.mjs")) {
  const server = createFilteredRpcServer({
    rateLimitPerMinute: Number(
      process.env.RPC_RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
    ),
    sendRateLimitPerMinute: Number(
      process.env.RPC_SEND_RATE_LIMIT_PER_MINUTE ??
        DEFAULT_SEND_RATE_LIMIT_PER_MINUTE,
    ),
  });
  const host = process.env.RPC_PROXY_HOST ?? "0.0.0.0";
  const port = Number(process.env.RPC_PROXY_PORT ?? 8546);
  server.listen(port, host, () =>
    console.log(`AURKA filtered RPC listening on http://${host}:${port}`),
  );
}
