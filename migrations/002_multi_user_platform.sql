CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_registrations (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_fen INTEGER NOT NULL DEFAULT 0 CHECK (balance_fen >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen != 0),
  balance_after_fen INTEGER NOT NULL CHECK (balance_after_fen >= 0),
  entry_type TEXT NOT NULL,
  reference TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  memo TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS wallet_ledger_user_created_idx ON wallet_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portal_idempotency (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS topup_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'closed')),
  payment_type TEXT NOT NULL,
  gateway_trade_no TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS topup_orders_user_created_idx ON topup_orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS price_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  plan TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'AUTO',
  price_fen INTEGER NOT NULL CHECK (price_fen > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(product, plan, country)
);

CREATE TABLE IF NOT EXISTS customer_quotes (
  quote_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product TEXT NOT NULL,
  plan TEXT NOT NULL,
  country TEXT NOT NULL,
  price_fen INTEGER NOT NULL CHECK (price_fen > 0),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS customer_quotes_user_idx ON customer_quotes(user_id, expires_at);

CREATE TABLE IF NOT EXISTS customer_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  quote_id TEXT NOT NULL UNIQUE REFERENCES customer_quotes(quote_id),
  upstream_order_id TEXT UNIQUE,
  product TEXT NOT NULL,
  plan TEXT NOT NULL,
  country TEXT NOT NULL,
  price_fen INTEGER NOT NULL CHECK (price_fen > 0),
  status TEXT NOT NULL DEFAULT 'submitting',
  charge_status TEXT NOT NULL DEFAULT 'charged' CHECK (charge_status IN ('charged', 'settled', 'refunded')),
  reference TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS customer_orders_user_created_idx ON customer_orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cdk_purchases (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  upstream_batch_id TEXT,
  plan TEXT NOT NULL,
  country TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_days INTEGER NOT NULL,
  funding_cap_cents INTEGER NOT NULL CHECK (funding_cap_cents > 0),
  unit_price_fen INTEGER NOT NULL CHECK (unit_price_fen > 0),
  total_price_fen INTEGER NOT NULL CHECK (total_price_fen > 0),
  status TEXT NOT NULL DEFAULT 'creating',
  charge_status TEXT NOT NULL DEFAULT 'charged' CHECK (charge_status IN ('charged', 'settled', 'refunded')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS cdk_purchases_user_created_idx ON cdk_purchases(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_cdk_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purchase_id TEXT NOT NULL REFERENCES cdk_purchases(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unused',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS user_cdk_codes_user_idx ON user_cdk_codes(user_id, created_at DESC);
