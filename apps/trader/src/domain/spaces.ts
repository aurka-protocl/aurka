import { AurkaClient, AurkaError } from "@aurka/sdk";
import type { SpaceAdapter, SpaceRecord } from "@aurka/shared";
import { apiBaseUrl } from "../config";

export type { SpaceAdapter, SpaceRecord };

const CACHE_TTL_MS = 15_000;
const RETRY_DELAYS_MS = [250, 750] as const;

interface CacheEntry<T> {
  readonly value: T;
  readonly cachedAt: number;
}

class ApiSpaceAdapter implements SpaceAdapter {
  private readonly client = new AurkaClient({ baseUrl: apiBaseUrl });
  private readonly listCache = new Map<string, CacheEntry<SpaceRecord[]>>();
  private readonly spaceCache = new Map<string, CacheEntry<SpaceRecord>>();
  private readonly listRequests = new Map<string, Promise<SpaceRecord[]>>();
  private readonly spaceRequests = new Map<string, Promise<SpaceRecord>>();
  private cacheGeneration = 0;

  private async withRetry<T>(request: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await request();
      } catch (error: unknown) {
        lastError = error;
        const retryable =
          !(error instanceof AurkaError) ||
          error.statusCode === 0 ||
          error.statusCode >= 500;
        if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, RETRY_DELAYS_MS[attempt]!),
        );
      }
    }
    throw lastError;
  }

  private listKey(limit: number, ownerAddress?: string): string {
    return `${limit}:${ownerAddress?.toLowerCase() ?? "all"}`;
  }

  private loadList(
    key: string,
    limit: number,
    ownerAddress?: string,
  ): Promise<SpaceRecord[]> {
    const existing = this.listRequests.get(key);
    if (existing) return existing;
    const generation = this.cacheGeneration;
    const request = this.withRetry(() =>
      this.client.listSpaces(limit, ownerAddress).then((response) => {
        if (generation === this.cacheGeneration) {
          this.listCache.set(key, {
            value: response.items,
            cachedAt: Date.now(),
          });
          for (const space of response.items)
            this.spaceCache.set(space.identity.id, {
              value: space,
              cachedAt: Date.now(),
            });
        }
        return response.items;
      }),
    );
    this.listRequests.set(key, request);
    void request
      .then(undefined, () => {})
      .then(() => {
        if (this.listRequests.get(key) === request)
          this.listRequests.delete(key);
      });
    return request;
  }

  private loadSpace(spaceId: string): Promise<SpaceRecord> {
    const existing = this.spaceRequests.get(spaceId);
    if (existing) return existing;
    const generation = this.cacheGeneration;
    const request = this.withRetry(() =>
      this.client.getSpace(spaceId).then((space) => {
        if (generation === this.cacheGeneration)
          this.spaceCache.set(spaceId, { value: space, cachedAt: Date.now() });
        return space;
      }),
    );
    this.spaceRequests.set(spaceId, request);
    void request
      .then(undefined, () => {})
      .then(() => {
        if (this.spaceRequests.get(spaceId) === request)
          this.spaceRequests.delete(spaceId);
      });
    return request;
  }

  invalidate(spaceId: string): void {
    this.cacheGeneration += 1;
    this.spaceCache.delete(spaceId);
    this.listCache.clear();
  }

  invalidateAll(): void {
    this.cacheGeneration += 1;
    this.spaceCache.clear();
    this.listCache.clear();
  }

  async listSpaces(limit = 50, ownerAddress?: string): Promise<SpaceRecord[]> {
    const key = this.listKey(limit, ownerAddress);
    const cached = this.listCache.get(key);
    if (cached) {
      if (Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
      // Serve stale data immediately and refresh it in the background. A
      // temporary RPC outage must not blank navigation, filters, or context.
      void this.loadList(key, limit, ownerAddress).catch(() => {});
      return cached.value;
    }
    return this.loadList(key, limit, ownerAddress);
  }

  async getSpace(spaceId: string): Promise<SpaceRecord> {
    const cached = this.spaceCache.get(spaceId);
    if (cached) {
      if (Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
      void this.loadSpace(spaceId).catch(() => {});
      return cached.value;
    }
    return this.loadSpace(spaceId);
  }
}

const apiSpaceAdapter = new ApiSpaceAdapter();
export const spaceAdapter: SpaceAdapter = apiSpaceAdapter;

/** Clear client-side Space data after an explicit user refresh or mutation. */
export function invalidateSpaceCache(spaceId?: string): void {
  if (spaceId === undefined) apiSpaceAdapter.invalidateAll();
  else apiSpaceAdapter.invalidate(spaceId);
}

export function spaceUrl(
  spaceId: string,
  section?: "overview" | "holdings" | "settings",
): string {
  const base = `/spaces/${encodeURIComponent(spaceId)}`;
  return section && section !== "overview" ? `${base}/${section}` : base;
}

export function tradeUrl(spaceId: string): string {
  return `/trade/${encodeURIComponent(spaceId)}`;
}
