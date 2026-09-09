import { AurkaClient } from "@aurka/sdk";
import type { Position, SpaceAdapter, SpaceRecord } from "@aurka/shared";
import { apiBaseUrl, appMode } from "../config";

export type { SpaceAdapter, SpaceRecord };

function toSpaceRecord(position: Position): SpaceRecord {
  return {
    identity: {
      id: position.id,
      name: position.name,
      ownerAddress: position.owner,
      treasuryAddress: position.treasury,
      chainId: position.chainId,
      mode: appMode,
    },
    position,
  };
}

class ApiSpaceAdapter implements SpaceAdapter {
  private readonly client = new AurkaClient({ baseUrl: apiBaseUrl });

  async listSpaces(limit = 50): Promise<SpaceRecord[]> {
    const response = await this.client.listPositions(limit);
    return response.items.map(toSpaceRecord);
  }

  async getSpace(spaceId: string): Promise<SpaceRecord> {
    return toSpaceRecord(await this.client.getPosition(spaceId));
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
