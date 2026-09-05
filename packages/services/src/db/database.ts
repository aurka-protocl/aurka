import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { schema } from "./schema.js";

export type ServiceDrizzleDatabase = BetterSQLite3Database<typeof schema>;

function migrationDirectory(): string {
  const candidates = [
    new URL("../../drizzle", import.meta.url),
    new URL("../../../drizzle", import.meta.url),
  ];
  for (const candidate of candidates) {
    const directory = fileURLToPath(candidate);
    if (fs.existsSync(path.join(directory, "meta", "_journal.json"))) {
      return directory;
    }
  }
  throw new Error("AURKA Drizzle migration directory was not found");
}

export interface ServiceDatabaseOptions {
  readonly filename?: string;
  readonly migrate?: boolean;
}

/** SQLite connection with WAL, foreign keys, and Drizzle migrations enabled. */
export class ServiceDatabase {
  readonly sqlite: Database.Database;
  readonly db: ServiceDrizzleDatabase;

  constructor(options: ServiceDatabaseOptions = {}) {
    const filename = options.filename ?? ":memory:";
    this.sqlite = new Database(filename);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") this.sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(this.sqlite, { schema });
    if (options.migrate !== false)
      migrate(this.db, { migrationsFolder: migrationDirectory() });
  }

  transaction<T>(callback: (database: ServiceDrizzleDatabase) => T): T {
    return this.db.transaction(callback);
  }

  close(): void {
    this.sqlite.close();
  }
}

export function assertDatabaseMigrations(filename = ":memory:"): void {
  const database = new ServiceDatabase({ filename });
  database.close();
}
