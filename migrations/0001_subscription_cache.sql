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
