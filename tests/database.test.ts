import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../src/database";

describe("SQLite webhook storage", () => {
  it("migrates the local schema, checks health, and deduplicates event IDs", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.migrate(readFileSync(join(process.cwd(), "migrations", "001_webhook_events.sql"), "utf8"));
      database.healthCheck();

      const event = {
        id: "evt_local_test",
        type: "card.opened",
        created_at: "2026-11-12T00:00:00.000Z",
        data: { card_id: "card_local" },
      };
      const rawBody = JSON.stringify(event);

      expect(database.insertWebhookEvent(event, rawBody)).toBe(true);
      expect(database.insertWebhookEvent(event, rawBody)).toBe(false);
    } finally {
      database.close();
    }
  });
});
