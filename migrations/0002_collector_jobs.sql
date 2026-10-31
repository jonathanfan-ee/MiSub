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
