import type { RegistryRiskReader } from "./risk-service.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { startRiskWorker, type RiskCertificateWorker } from "./risk-worker.js";
import { LocalDemoProvider } from "./fixture.js";
import { loadConfig } from "./config.js";
import { ServiceDatabase } from "./db/database.js";
import { createApiServer, listenApiServer } from "./api/server.js";
import { AurkaService } from "./service.js";
import { JsonRpcHttpTransport } from "./solver/rpc.js";

const config = loadConfig();
const command = process.argv[2] ?? "serve";

if (command === "migrate" || command === "check") {
  const database = new ServiceDatabase({ filename: config.DATABASE_URL });
  const result = database.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'positions'",
    )
    .get() as { name?: string } | undefined;
  database.close();
  if (command === "check" && result?.name !== "positions")
    throw new Error("AURKA migrations did not create the positions table");
  console.log(
    command === "migrate"
      ? "AURKA migrations applied"
      : "AURKA database is ready",
  );
} else if (command === "serve") {
  const database = new ServiceDatabase({ filename: config.DATABASE_URL });
  if (config.RPC_URL && !config.SETTLEMENT_CONTRACT) {
    throw new Error(
      "SETTLEMENT_CONTRACT is required when RPC_URL is configured",
    );
  }
  const handle = createApiServer({
    service: new AurkaService({
      database,
      chainId: config.CHAIN_ID,
      indexConfirmations: config.INDEX_CONFIRMATIONS,
      ...(!config.RPC_URL ? { provider: new LocalDemoProvider() } : {}),
      ...(config.SETTLEMENT_CONTRACT
        ? { settlementContract: config.SETTLEMENT_CONTRACT }
        : {}),
      ...(config.RPC_URL
        ? { rpcTransport: new JsonRpcHttpTransport(config.RPC_URL) }
        : {}),
    }),
  });
  let stopRiskWorker: (() => Promise<void>) | undefined;
  if (config.RISK_RUNTIME_MODULE) {
    const runtime = (await import(
      pathToFileURL(resolve(config.RISK_RUNTIME_MODULE)).href
    )) as {
      createRiskRuntime?: (service: AurkaService) => Promise<{
        worker: RiskCertificateWorker;
        positions: string[];
        readRisk?: RegistryRiskReader;
        riskRegistry?: string;
      }>;
    };
    if (typeof runtime.createRiskRuntime !== "function")
      throw new Error("Risk runtime must export createRiskRuntime");
    const configured = await runtime.createRiskRuntime(handle.service);
    if (
      !Array.isArray(configured.positions) ||
      configured.positions.some((position) => typeof position !== "string") ||
      typeof configured.worker?.tick !== "function"
    )
      throw new Error("Invalid risk runtime");
    if (configured.riskRegistry)
      handle.service.riskService.configureCertificateRegistry(
        configured.riskRegistry,
      );
    if (configured.readRisk)
      handle.service.riskService.configureRegistryReader(configured.readRisk);
    stopRiskWorker = startRiskWorker(
      configured.worker,
      configured.positions,
      () =>
        console.error("Risk worker attempt failed; inspect its audit state"),
    );
  }
  await listenApiServer(handle, config.PORT, config.HOST);
  console.log(
    `AURKA services listening on http://${config.HOST}:${config.PORT}`,
  );
  const shutdown = () => {
    void (async () => {
      await new Promise<void>((resolve) =>
        handle.server.close(() => resolve()),
      );
      await stopRiskWorker?.();
      handle.service.close();
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else {
  throw new Error(`Unknown command: ${command}`);
}
