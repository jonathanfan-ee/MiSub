
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_at ON subscriptions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
CREATE INDEX IF NOT EXISTS idx_settings_updated_at ON settings(updated_at);

-- Optional airport source snapshots (feature defaults off).
-- Additive and idempotent. Apply manually to the selected site's D1 only.
-- No existing subscription/profile/settings rows are changed.
CREATE TABLE IF NOT EXISTS subscription_cache (
    source_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('clash', 'universal', 'lease')),
    source_url_hash TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '',
    node_count INTEGER NOT NULL DEFAULT 0,
    user_info TEXT,
    last_success_at INTEGER,
    last_attempt_at INTEGER,
    error_code TEXT,
    lock_until INTEGER NOT NULL DEFAULT 0,
    lock_token TEXT,
    PRIMARY KEY (source_id, format)
);

-- Additive only. Review/apply manually after 0001_subscription_cache.sql.
CREATE TABLE IF NOT EXISTS collector_jobs (
    source_id TEXT PRIMARY KEY,
    source_url_hash TEXT NOT NULL,
    collector_id TEXT NOT NULL,
    requested_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    claim_token TEXT
);
CREATE TABLE IF NOT EXISTS collector_nonces (
    collector_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    PRIMARY KEY (collector_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_collector_nonces_time ON collector_nonces(issued_at);
