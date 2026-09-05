import { loadConfig } from "./config.js";
import { ServiceDatabase } from "./db/database.js";
import { createApiServer, listenApiServer } from "./api/server.js";
import { AurkaService } from "./service.js";

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
  const handle = createApiServer({ service: new AurkaService({ database }) });
  await listenApiServer(handle, config.PORT, config.HOST);
  console.log(
    `AURKA services listening on http://${config.HOST}:${config.PORT}`,
  );
  const shutdown = () => {
    void (async () => {
      await new Promise<void>((resolve) =>
        handle.server.close(() => resolve()),
      );
      handle.service.close();
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else {
  throw new Error(`Unknown command: ${command}`);
}
