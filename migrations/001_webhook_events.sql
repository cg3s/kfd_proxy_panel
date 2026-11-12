CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_events_created_at_idx
  ON webhook_events (created_at DESC);

CREATE INDEX IF NOT EXISTS webhook_events_type_created_at_idx
  ON webhook_events (event_type, created_at DESC);
