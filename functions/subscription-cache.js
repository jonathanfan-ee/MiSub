import { getBinding } from './storage-adapter.js';
import { fetchSubscriptionText, parseClashProxyList } from './subscription-fetch.js';

export const CACHE_TIMING = Object.freeze({
    fresh: 30 * 60_000,
    timeout: 10_000,
    retry: 5 * 60_000,
    lock: 30_000,
    warning: 24 * 60 * 60_000,
});
const FORMATS = ['clash', 'universal'];
const CURRENT_SOURCE = `EXISTS (SELECT 1 FROM subscriptions, json_each(subscriptions.data) AS source
    WHERE subscriptions.id = 'main' AND json_extract(source.value, '$.id') = ?1
        AND json_extract(source.value, '$.url') = ?11
        AND json_extract(source.value, '$.fetchPolicy') = 'cache-first')`;
const LINK = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2?|tuic|anytls|socks5):\/\//i;
export const countUniversalNodes = text => text.split(/\r?\n/).filter(line => LINK.test(line.trim())).length;

function latestUserInfo(rows) {
    for (const row of [...rows].sort((a, b) => (b.last_success_at || 0) - (a.last_success_at || 0))) {
        try {
            const info = JSON.parse(row.user_info || 'null');
            if (info && typeof info === 'object' && Object.keys(info).length) return info;
        } catch { /* A malformed metadata field must not discard usable nodes. */ }
    }
    return null;
}

export async function sourceUrlHash(url) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The third (lease) row coordinates both formats. Only payload rows hold snapshots.
// Fencing by token AND URL hash prevents late jobs from replacing a newer refresh.
export class D1SourceCacheStore {
    constructor(db, { enforceSourceUrl = false } = {}) {
        this.db = db;
        this.enforceSourceUrl = enforceSourceUrl;
    }

    async rows(id, hash) {
        const result = await this.db.prepare('SELECT * FROM subscription_cache WHERE source_id = ?1 AND source_url_hash = ?2')
            .bind(id, hash).all();
        return result.results;
    }

    async lock(id, hash, now, force, sourceUrl = '') {
        const token = crypto.randomUUID();
        const row = await this.db.prepare(`
            INSERT INTO subscription_cache (source_id, format, source_url_hash, last_attempt_at, lock_until, lock_token)
            SELECT ?1, 'lease', ?2, ?3, ?4, ?5 WHERE (?10 = 0 OR ${CURRENT_SOURCE})
            ON CONFLICT(source_id, format) DO UPDATE SET
                source_url_hash = excluded.source_url_hash, last_attempt_at = excluded.last_attempt_at,
                lock_until = excluded.lock_until, lock_token = excluded.lock_token
            WHERE subscription_cache.source_url_hash != ?2 OR
                (subscription_cache.lock_until <= ?3 AND
                 (?6 = 1 OR subscription_cache.last_attempt_at <= ?7))
            RETURNING lock_token
        `).bind(id, hash, now, now + CACHE_TIMING.lock, token, force ? 1 : 0, now - CACHE_TIMING.retry,
            null, null, this.enforceSourceUrl ? 1 : 0, sourceUrl).first();
        return row?.lock_token || null;
    }

    async publish(id, hash, token, snapshots, now, sourceUrl = '') {
        const statements = FORMATS.map(format => {
            const snapshot = snapshots[format];
            return this.db.prepare(`
                INSERT INTO subscription_cache
                    (source_id, format, source_url_hash, payload, node_count, user_info, last_success_at, last_attempt_at, error_code)
                SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
                WHERE EXISTS (SELECT 1 FROM subscription_cache WHERE source_id = ?1 AND format = 'lease'
                    AND source_url_hash = ?3 AND lock_token = ?10 AND lock_until > ?8)
                    AND (?12 = 0 OR ${CURRENT_SOURCE})
                ON CONFLICT(source_id, format) DO UPDATE SET
                    source_url_hash = excluded.source_url_hash,
                    payload = CASE WHEN ?7 IS NOT NULL THEN excluded.payload WHEN subscription_cache.source_url_hash = ?3 THEN subscription_cache.payload ELSE '' END,
                    node_count = CASE WHEN ?7 IS NOT NULL THEN excluded.node_count WHEN subscription_cache.source_url_hash = ?3 THEN subscription_cache.node_count ELSE 0 END,
                    user_info = CASE WHEN ?7 IS NOT NULL AND excluded.user_info IS NOT NULL THEN excluded.user_info WHEN subscription_cache.source_url_hash = ?3 THEN subscription_cache.user_info ELSE NULL END,
                    last_success_at = CASE WHEN ?7 IS NOT NULL THEN ?7 WHEN subscription_cache.source_url_hash = ?3 THEN subscription_cache.last_success_at ELSE NULL END,
                    last_attempt_at = excluded.last_attempt_at, error_code = excluded.error_code
            `).bind(id, format, hash, snapshot.text || '', snapshot.count || 0,
                snapshot.userInfo ? JSON.stringify(snapshot.userInfo) : null,
                snapshot.failure ? null : now, now, snapshot.failure || null, token, sourceUrl, this.enforceSourceUrl ? 1 : 0);
        });
        statements.push(this.db.prepare(`UPDATE subscription_cache SET lock_until = 0, lock_token = NULL, last_attempt_at = ?4
            WHERE source_id = ?1 AND format = 'lease' AND source_url_hash = ?2 AND lock_token = ?3`)
            .bind(id, hash, token, now));
        await this.db.batch(statements);
    }
}

export class SourceCache {
    constructor(store, { decode, fetchImpl = fetch, now = Date.now, timeoutMs = CACHE_TIMING.timeout } = {}) {
        this.store = store;
        this.decode = decode;
        this.fetchImpl = fetchImpl;
        this.now = now;
        this.timeoutMs = timeoutMs;
    }

    async refresh(sub, { force = false } = {}) {
        const hash = await sourceUrlHash(sub.url);
        const token = await this.store.lock(sub.id, hash, this.now(), force, sub.url);
        if (!token) return false;
        const snapshots = Object.fromEntries(await Promise.all(FORMATS.map(async format => {
            const result = await fetchSubscriptionText({ url: sub.url }, {
                decode: this.decode, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs,
                includeMetadata: true,
                preferClash: format === 'clash',
                isUsable: text => format === 'clash' ? Boolean(parseClashProxyList(text)) : countUniversalNodes(text) > 0,
            });
            const count = result.failure ? 0 : format === 'clash'
                ? parseClashProxyList(result.text).length : countUniversalNodes(result.text);
            return [format, { ...result, count }];
        })));
        await this.store.publish(sub.id, hash, token, snapshots, this.now(), sub.url);
        return true;
    }

    async read(sub, format, context) {
        const hash = await sourceUrlHash(sub.url);
        const rows = await this.store.rows(sub.id, hash);
        const cached = rows.find(row => row.format === format && row.payload && row.last_success_at != null);
        if (cached) {
            if (this.now() - cached.last_success_at >= CACHE_TIMING.fresh) {
                const refresh = this.refresh(sub).catch(() => { /* D1 outage: retain snapshot, retry on a later access. */ });
                if (context?.waitUntil) context.waitUntil(refresh);
                else await refresh;
            }
            return { text: cached.payload, usedSource: 'cache-first', failure: cached.error_code || null, userInfo: latestUserInfo(rows) };
        }
        // Cold reads wait for the first snapshot. Other readers share the source lease.
        const started = await this.refresh(sub);
        const deadline = Date.now() + this.timeoutMs;
        do {
            const current = await this.store.rows(sub.id, hash);
            const snapshot = current.find(row => row.format === format);
            if (snapshot?.payload && snapshot.last_success_at != null) {
                return { text: snapshot.payload, usedSource: 'cache-first', failure: snapshot.error_code || null, userInfo: latestUserInfo(current) };
            }
            const lease = current.find(row => row.format === 'lease');
            if (started || !lease?.lock_token || lease.lock_until <= this.now()) {
                return { text: '', usedSource: 'cache-first', failure: snapshot?.error_code || 'cache-empty' };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        return { text: '', usedSource: 'cache-first', failure: 'refresh-in-progress' };
    }

    async status(sub) {
        const rows = await this.store.rows(sub.id, await sourceUrlHash(sub.url));
        const now = this.now();
        return Object.fromEntries(FORMATS.map(format => {
            const row = rows.find(row => row.format === format);
            const ageMs = row?.last_success_at == null ? null : Math.max(0, now - row.last_success_at);
            let userInfo = null;
            try { userInfo = JSON.parse(row?.user_info || 'null'); } catch { /* Old malformed metadata is not a subscription failure. */ }
            return [format, { count: row?.node_count || 0, lastSuccessAt: row?.last_success_at ?? null,
                ageMs, warning: ageMs != null && ageMs >= CACHE_TIMING.warning,
                lastAttemptAt: row?.last_attempt_at ?? null, error: row?.error_code || null, userInfo }];
        }));
    }
}

export function createSourceCache(env, config, decode) {
    if (config.sourceCacheEnabled !== true || config.storageType !== 'd1') return null;
    const db = getBinding(env, 'MISUB_DB');
    return db ? new SourceCache(new D1SourceCacheStore(db, { enforceSourceUrl: true }), { decode }) : null;
}

export const usesSourceCache = (sub, config) => config.sourceCacheEnabled === true && sub.fetchPolicy === 'cache-first';
