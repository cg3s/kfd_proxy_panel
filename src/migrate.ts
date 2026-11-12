import { loadDatabasePath } from "./config";
import { SqliteDatabase } from "./database";
import { applyMigrations } from "./migration-runner";

async function migrate(): Promise<void> {
  const database = new SqliteDatabase(loadDatabasePath());
  try {
    await applyMigrations(database);
    console.log("Database migrations completed");
  } finally {
    database.close();
  }
}

void migrate().catch((error: unknown) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
