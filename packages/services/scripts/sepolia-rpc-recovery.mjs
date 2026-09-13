/* global AbortSignal, fetch, process */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_COOLDOWN_MS = 30_000;
const DEFAULT_CACHE_MS = 5_000;
const HEAD_CACHE_METHODS = new Set([
  "eth_blockNumber",
  "eth_chainId",
  "eth_getBlockByNumber",
]);
const WRITE_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
]);

function nowMs() {
  return Date.now();
}

function requestKey(method, params) {
  return JSON.stringify([method, params], (_, value) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

function isHeadRead(method, params) {
  return (
    HEAD_CACHE_METHODS.has(method) &&
    (method !== "eth_getBlockByNumber" ||
      params[0] === "latest" ||
      params[0] === "finalized")
  );
}

function isRateLimitedMessage(message) {
  return /rate.?limit|too many requests|quota|429|compute units/i.test(
    message ?? "",
  );
}

function retryAfterMs(headers, now) {
  const value = headers?.get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(MAX_COOLDOWN_MS, Math.max(0, seconds * 1_000));
  const date = Date.parse(value);
  if (Number.isFinite(date))
    return Math.min(MAX_COOLDOWN_MS, Math.max(0, date - now));
  return undefined;
}

function safeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? "RPC request failed");
}

export function rpcErrorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string")
    if (error.code !== "UNKNOWN_RPC_ERROR") return error.code;
  const message = safeErrorMessage(error);
  if (/rate limited|rate.?limit|too many requests|quota|429/i.test(message))
    return "RPC_RATE_LIMITED";
  if (/cooling down|cooldown/i.test(message)) return "RPC_COOLDOWN";
  if (/synchronizing|trading is temporarily paused/i.test(message))
    return "RPC_SYNCING";
  return "RPC_UNAVAILABLE";
}

export class RpcCooldownError extends Error {
  constructor(nextRetryAt, message = "Sepolia RPC is cooling down") {
    super(message);
    this.name = "RpcCooldownError";
    this.code = "RPC_COOLDOWN";
    this.statusCode = 503;
    this.nextRetryAt = nextRetryAt;
  }
}

export class RpcRateLimitedError extends RpcCooldownError {
  constructor(nextRetryAt) {
    super(nextRetryAt, "Sepolia RPC is rate limited; retry after the cooldown");
    this.name = "RpcRateLimitedError";
    this.code = "RPC_RATE_LIMITED";
  }
}

export class RpcSyncingError extends Error {
  constructor(
    message = "Sepolia chain data is still synchronizing",
    nextRetryAt,
  ) {
    super(message);
    this.name = "RpcSyncingError";
    this.code = "RPC_SYNCING";
    this.statusCode = 503;
    if (nextRetryAt !== undefined) this.nextRetryAt = nextRetryAt;
  }
}

/**
 * One process-wide JSON-RPC boundary. It deliberately does not retry a
 * transport request: viem and application calls must not multiply each
 * other. Identical reads share a promise, head reads are briefly cached, and
 * a provider rate-limit opens one cooldown for every caller in this process.
 */
export class RpcRequestCoordinator {
  constructor({
    url,
    fetchImpl = fetch,
    now = nowMs,
    random = Math.random,
    cacheMs = DEFAULT_CACHE_MS,
    log = () => {},
    onWrite = () => {},
  }) {
    if (!url) throw new Error("RPC coordinator requires a URL");
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.cacheMs = cacheMs;
    this.log = log;
    this.onWrite = onWrite;
    this.inFlight = new Map();
    this.cache = new Map();
    this.cooldownUntil = 0;
    this.rateLimitFailures = 0;
    this.requestCount = 0;
    this.methodCounts = new Map();
    this.cooldownCount = 0;
  }

  get nextRetryAt() {
    return this.cooldownUntil > this.now() ? this.cooldownUntil : undefined;
  }

  get nextRetryAtSeconds() {
    const retryAt = this.nextRetryAt;
    return retryAt === undefined ? undefined : Math.ceil(retryAt / 1_000);
  }

  stats() {
    return {
      requestCount: this.requestCount,
      cooldownCount: this.cooldownCount,
      cooldownUntil: this.nextRetryAt,
      byMethod: Object.fromEntries(this.methodCounts),
    };
  }

  resetStats() {
    this.requestCount = 0;
    this.cooldownCount = 0;
    this.methodCounts.clear();
  }

  invalidate() {
    this.cache.clear();
  }

  request({ method, params = [] }) {
    const key = requestKey(method, params);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const now = this.now();
    if (this.cooldownUntil > now)
      return Promise.reject(new RpcCooldownError(this.nextRetryAtSeconds));

    const cacheEntry = this.cache.get(key);
    if (cacheEntry && cacheEntry.expiresAt > now)
      return Promise.resolve(cacheEntry.value);
    if (cacheEntry) this.cache.delete(key);

    const request = this.perform(method, params, key);
    this.inFlight.set(key, request);
    void request.then(
      () => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      },
      () => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      },
    );
    return request;
  }

  async perform(method, params, key) {
    const now = this.now();
    if (this.cooldownUntil > now)
      throw new RpcCooldownError(this.nextRetryAtSeconds);

    this.requestCount += 1;
    this.methodCounts.set(method, (this.methodCounts.get(method) ?? 0) + 1);
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error("Sepolia RPC request failed", { cause: error });
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const providerMessage =
      body?.error?.message ??
      (typeof body?.error === "string" ? body.error : undefined) ??
      `RPC HTTP ${response.status}`;
    const rateLimited =
      response.status === 429 ||
      (body?.error &&
        (body.error.code === -32005 || isRateLimitedMessage(providerMessage)));
    if (response.ok === false || body?.error || body?.result === undefined) {
      if (rateLimited) {
        const delay =
          retryAfterMs(response.headers, this.now()) ?? this.backoffDelay();
        const retryAt = this.openCooldown(delay, providerMessage);
        throw new RpcRateLimitedError(Math.ceil(retryAt / 1_000));
      }
      throw new Error(
        /https?:\/\//i.test(providerMessage)
          ? "Sepolia RPC request failed"
          : `Sepolia RPC request failed: ${providerMessage.slice(0, 160)}`,
      );
    }

    this.rateLimitFailures = 0;
    if (WRITE_METHODS.has(method)) {
      this.invalidate();
      this.onWrite();
    }
    if (isHeadRead(method, params))
      this.cache.set(key, {
        value: body.result,
        expiresAt: this.now() + this.cacheMs,
      });
    return body.result;
  }

  backoffDelay() {
    const exponent = Math.min(this.rateLimitFailures, 4);
    const base = Math.min(MAX_COOLDOWN_MS, 2_000 * 2 ** exponent);
    const jitter = Math.floor(base * 0.2 * this.random());
    return Math.min(MAX_COOLDOWN_MS, base + jitter);
  }

  openCooldown(delay, reason) {
    const retryAt = this.now() + Math.min(MAX_COOLDOWN_MS, Math.max(0, delay));
    this.cooldownUntil = Math.max(this.cooldownUntil, retryAt);
    this.rateLimitFailures += 1;
    this.cooldownCount += 1;
    this.log({
      level: "warn",
      message: "sepolia.rpc.cooldown",
      retryAt: Math.ceil(this.cooldownUntil / 1_000),
      reason: isRateLimitedMessage(reason) ? "rate_limited" : "provider_error",
    });
    return this.cooldownUntil;
  }
}

function restoredEvent(value) {
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  for (const field of ["blockNumber", "transactionIndex", "logIndex"]) {
    if (typeof result[field] === "string" && /^\d+$/.test(result[field]))
      result[field] = BigInt(result[field]);
  }
  if (result.args && typeof result.args === "object")
    result.args = { ...result.args };
  for (const field of [
    "capacityBaselineValue",
    "policyNonce",
    "consumedBefore",
  ]) {
    if (
      typeof result.args?.[field] === "string" &&
      /^\d+$/.test(result.args[field])
    )
      result.args[field] = BigInt(result.args[field]);
  }
  return result;
}

/**
 * Small atomic JSON store for chain-derived event evidence. Entries are
 * namespaced by deployment identity by the caller and retain a resumable
 * search cursor so a restart never has to replay the whole history.
 */
export class PersistentEpochEventStore {
  constructor({ filename, chainId, router, now = nowMs }) {
    this.filename = filename;
    this.chainId = chainId;
    this.router = router?.toLowerCase();
    this.now = now;
    this.entries = new Map();
    this.progress = new Map();
    this.load();
  }

  load() {
    if (
      !this.filename ||
      this.filename === ":memory:" ||
      !existsSync(this.filename)
    )
      return;
    try {
      const value = JSON.parse(readFileSync(this.filename, "utf8"));
      if (
        value?.version !== 1 ||
        value.chainId !== this.chainId ||
        value.router?.toLowerCase() !== this.router
      )
        return;
      for (const [key, entry] of Object.entries(value.entries ?? {}))
        this.entries.set(key, entry);
      for (const [key, entry] of Object.entries(value.progress ?? {}))
        this.progress.set(key, entry);
    } catch {
      // A corrupt cache is disposable chain-derived data; a fresh bounded
      // lookup is safer than preventing the API from starting.
    }
  }

  get(key) {
    const entry = this.entries.get(key);
    return entry?.event ? restoredEvent(entry.event) : undefined;
  }

  set(key, identity, event) {
    this.entries.set(key, {
      ...identity,
      event,
      savedAt: Math.floor(this.now() / 1_000),
    });
    this.progress.delete(key);
    this.persist();
  }

  delete(key) {
    const deleted = this.entries.delete(key) || this.progress.delete(key);
    if (deleted) this.persist();
    return deleted;
  }

  getProgress(key) {
    return this.progress.get(key);
  }

  setProgress(key, value) {
    this.progress.set(key, value);
    this.persist();
  }

  clearProgress(key) {
    if (this.progress.delete(key)) this.persist();
  }

  persist() {
    if (!this.filename || this.filename === ":memory:") return;
    const directory = path.dirname(this.filename);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp-${process.pid}`;
    const body = JSON.stringify(
      {
        version: 1,
        chainId: this.chainId,
        router: this.router,
        entries: Object.fromEntries(this.entries),
        progress: Object.fromEntries(this.progress),
      },
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
    writeFileSync(temporary, `${body}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.filename);
  }
}

export function epochEventKey(
  chainId,
  router,
  positionIdHash,
  capacityEpochId,
) {
  return [chainId, router, positionIdHash, capacityEpochId]
    .map((value) => String(value).toLowerCase())
    .join(":");
}
