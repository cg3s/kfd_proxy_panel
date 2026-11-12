import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteDatabase } from "./database";

export async function applyMigrations(
  database: SqliteDatabase,
  migrationsDirectory = join(process.cwd(), "migrations"),
): Promise<void> {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    database.migrate(await readFile(join(migrationsDirectory, migration), "utf8"));
  }
}
