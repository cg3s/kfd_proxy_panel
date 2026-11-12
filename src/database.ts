import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { KafudaWebhookEvent } from "./webhook";

export interface GatewayDatabase {
  healthCheck(): void;
  insertWebhookEvent(event: KafudaWebhookEvent, rawBody: string): boolean;
  listWebhookEvents(limit: number): Array<{
    event_id: string;
    event_type: string;
    created_at: string;
    received_at: string;
    payload: string;
  }>;
  migrate(sql: string): void;
  close(): void;
}

export class SqliteDatabase implements GatewayDatabase {
  readonly connection: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.connection = new Database(databasePath);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("busy_timeout = 5000");
    this.connection.pragma("foreign_keys = ON");
  }

  healthCheck(): void {
    this.connection.prepare("SELECT 1").get();
  }

  insertWebhookEvent(event: KafudaWebhookEvent, rawBody: string): boolean {
    const result = this.connection
      .prepare(
        `INSERT INTO webhook_events (event_id, event_type, created_at, payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id) DO NOTHING`,
      )
      .run(event.id, event.type, event.created_at, rawBody);
    return result.changes > 0;
  }

  listWebhookEvents(limit: number) {
    return this.connection
      .prepare(
        `SELECT event_id, event_type, created_at, received_at, payload
         FROM webhook_events
         ORDER BY received_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      event_id: string;
      event_type: string;
      created_at: string;
      received_at: string;
      payload: string;
    }>;
  }

  migrate(sql: string): void {
    this.connection.exec(sql);
  }

  close(): void {
    this.connection.close();
  }
}
