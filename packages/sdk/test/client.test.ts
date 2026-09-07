import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { AurkaClient, AurkaError } from "../src/index.js";
import {
  createApiServer,
  listenApiServer,
  closeApiServer,
  createCanonicalFixture,
} from "@aurka/services";
afterEach(() => vi.unstubAllGlobals());
it("consumes real envelopes, preserves errors and prepares a quote", async () => {
  const handle = createApiServer();
  await listenApiServer(handle, 0);
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const client = new AurkaClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  try {
    expect((await client.health()).status).toBe("ok");
    expect(await client.readiness()).toMatchObject({
      status: "ready",
      indexerLagBlocks: null,
      risk: "not_configured",
    });
    const positions = await client.listPositions(1);
    expect(positions.items).toHaveLength(1);
    const position = positions.items[0]!;
    expect((await client.getPosition(position.id)).owner).toBe(position.owner);
    await expect(client.getPosition("missing")).rejects.toMatchObject({
      code: "POSITION_NOT_FOUND",
      statusCode: 404,
    });
    const fixture = createCanonicalFixture();
    const intent = await client.prepareIntent({
      positionId: position.id,
      trader: fixture.intent.trader,
      traderInputToken: fixture.intent.traderInputToken,
      traderOutputToken: fixture.intent.traderOutputToken,
      requestedValue: fixture.intent.requestedValue,
      minimumTraderOutputValue: "0",
      nonce: "123",
      deadline: fixture.intent.deadline,
    });
    const quote = await client.quote(intent);
    expect(quote.executableTraderInputAmount).not.toBe("0");
    const solved = await client.solve(intent);
    expect(solved.proposal.traderInputValue).toBe("50000");
    const risk = await client.getRiskPosition(position.id);
    expect(risk.effective.mode).toBe(null);
    expect(risk.proposed).toBe(null);
  } finally {
    await closeApiServer(handle);
  }
});
it("classifies invalid responses separately from transport failures", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ ok: true, data: { wrong: true } })),
  );
  await expect(
    new AurkaClient({ baseUrl: "http://fixture" }).health(),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(new AurkaError("X", "test", 400)).toBeInstanceOf(Error);
});
it("keeps the timeout active while reading a stalled HTTP body", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true,');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  try {
    await expect(
      new AurkaClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeout: 50,
      }).health(),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
