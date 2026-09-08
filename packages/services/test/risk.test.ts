import { describe, expect, it } from "vitest";

import {
  closeApiServer,
  createApiServer,
  listenApiServer,
} from "../src/api/server.js";
import { FIXTURE_POSITION_ID } from "../src/fixture.js";
import { AurkaService } from "../src/service.js";

import { body, request } from "./risk-fixture.js";

describe("risk API persistence boundary", () => {
  it("evaluates through the idempotent API and separates proposed and unavailable effective state", async () => {
    const service = new AurkaService({ riskNow: () => 200 });
    const handle = createApiServer({ service });
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("API did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const payload = body();
      const first = await fetch(`${base}/v1/risk/evaluate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "risk-1",
        },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      const firstJson = (await first.json()) as {
        data: { evaluation: { mode: string } };
      };
      expect(firstJson.data.evaluation.mode).toBe("CAUTIOUS");
      const replay = await fetch(`${base}/v1/risk/evaluate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "risk-1",
        },
        body: JSON.stringify(payload),
      });
      expect(replay.status).toBe(200);
      const risk = await fetch(`${base}/v1/risk/${FIXTURE_POSITION_ID}`);
      expect(risk.status).toBe(200);
      const riskData = (await risk.json()) as {
        data: {
          effective: { mode: string | null };
          configuration: { cooldownSeconds: number } | null;
        };
      };
      expect(riskData.data.effective.mode).toBe(null);
      expect(riskData.data.configuration?.cooldownSeconds).toBe(30);
    } finally {
      await closeApiServer(handle);
    }
  });
});

it("fails safe when one alarming source is below quorum", () => {
  const service = new AurkaService({ riskNow: () => 200 });
  try {
    const input = body();
    input.observations = [request("one", "-30")];
    expect(service.riskService.evaluate(input).evaluation).toMatchObject({
      mode: "CAUTIOUS",
      failSafe: true,
    });
  } finally {
    service.close();
  }
});
it("preserves recovery cooldown across service instances and rejects impossible bounds", () => {
  let now = 200;
  const service = new AurkaService({ riskNow: () => now });
  try {
    const input = body();
    input.observations = [request("a", "-20"), request("b", "-20")];
    expect(service.riskService.evaluate(input).evaluation.mode).toBe("SHOCK");
    const second = new AurkaService({
      database: service.database,
      seedFixture: false,
      riskNow: () => now,
    });
    input.observations = [request("a", "0"), request("b", "0")];
    expect(second.riskService.evaluate(input).evaluation.mode).toBe("SHOCK");
    now = 230;
    input.nowSeconds = 230;
    expect(second.riskService.evaluate(input).evaluation.mode).toBe("NORMAL");
    const invalid = body();
    invalid.positionId = "missing";
    expect(() => second.riskService.evaluate(invalid)).toThrow(
      "Position was not found",
    );
  } finally {
    service.close();
  }
  const invalidService = new AurkaService({ riskNow: () => 200 });
  try {
    const invalid = body();
    invalid.configuration.boundSets[1]!.activeBounds = invalid.hardBounds.map(
      (b) => ({ ...b, maximumWeightBps: b.minimumWeightBps }),
    );
    expect(() => invalidService.riskService.evaluate(invalid)).toThrow(
      "valid portfolio",
    );
  } finally {
    invalidService.close();
  }
});
it("reclaims an abandoned job and fences its previous owner", () => {
  const service = new AurkaService();
  try {
    const r = service.repository;
    r.ensureRiskJob("job", FIXTURE_POSITION_ID, 100);
    const first = r.claimRiskJob("job", 100)!;
    expect(r.claimRiskJob("job", 101)).toBeUndefined();
    const second = r.claimRiskJob("job", 220)!;
    expect(second.attempt).toBe(first.attempt + 1);
    r.releaseRiskJob("job", first.attempt, 0);
    expect(r.ownsRiskJob("job", second.attempt)).toBe(true);
  } finally {
    service.close();
  }
});

it("isolates public proposal state from trusted worker recovery state", () => {
  const service = new AurkaService({ riskNow: () => 200 });
  try {
    const publicInput = body();
    publicInput.configuration.version = "public-config";
    publicInput.observations = [request("a", "-30"), request("b", "-30")];
    expect(service.riskService.evaluate(publicInput).evaluation.mode).toBe(
      "PAUSED",
    );
    expect(service.riskService.evaluate(body(), "worker").evaluation.mode).toBe(
      "CAUTIOUS",
    );
  } finally {
    service.close();
  }
});
