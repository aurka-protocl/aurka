import { AurkaClient } from "@aurka/sdk";
import type { SpaceAdapter, SpaceRecord } from "@aurka/shared";
import { apiBaseUrl } from "../config";

export type { SpaceAdapter, SpaceRecord };

class ApiSpaceAdapter implements SpaceAdapter {
  private readonly client = new AurkaClient({ baseUrl: apiBaseUrl });

  async listSpaces(limit = 50, ownerAddress?: string): Promise<SpaceRecord[]> {
    const response = await this.client.listSpaces(limit, ownerAddress);
    return response.items;
  }

  async getSpace(spaceId: string): Promise<SpaceRecord> {
    return this.client.getSpace(spaceId);
  }
}

export const spaceAdapter: SpaceAdapter = new ApiSpaceAdapter();

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
