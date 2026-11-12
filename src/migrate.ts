import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDatabasePath } from "./config";
import { SqliteDatabase } from "./database";

async function migrate(): Promise<void> {
  const database = new SqliteDatabase(loadDatabasePath());
  try {
    const sql = await readFile(join(process.cwd(), "migrations", "001_webhook_events.sql"), "utf8");
    database.migrate(sql);
    console.log("Database migration completed");
  } finally {
    database.close();
  }
}

void migrate().catch((error: unknown) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
