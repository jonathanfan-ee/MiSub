import { getBinding } from './storage-adapter.js';
import { CACHE_TIMING, D1SourceCacheStore, sourceUrlHash, countUniversalNodes, isCollectorSource } from './subscription-cache.js';
import { parseClashProxyList } from './subscription-fetch.js';

const FORMATS = ['clash', 'universal'];
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
const AUTH_WINDOW = 5 * 60_000;
const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR = /^(http-[1-5]\d\d|timeout|fetch-failed|unsupported-or-empty-response|provider-blocked|rate-limited|response-too-large|unsafe-target|invalid-response)$/;
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const httpError = (code, status) => Object.assign(new Error(code), { status });
const isIpv4 = value => typeof value === 'string' && value.split('.').length === 4
    && value.split('.').every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);

// Secrets live in a Pages secret, never in settings, exports, or API responses.
export function collectorRegistry(env) {
    try {
        const value = JSON.parse(env.MISUB_COLLECTORS || '{}');
        return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([id, entry]) => ID.test(id)
            && typeof entry?.secret === 'string' && entry.secret.length >= 32 && !entry.secret.startsWith('REPLACE_') && isIpv4(entry.expectedIpv4))));
    } catch { return Object.create(null); }
}
export const publicCollectors = env => Object.entries(collectorRegistry(env)).map(([id, value]) => ({ id, expectedIpv4: value.expectedIpv4 }));

async function readLimited(request, limit) {
    const reader = request.body?.getReader();
    if (!reader) return { bytes: new Uint8Array(), text: '' };
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw httpError('request-too-large', 413); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export async function collectorSigningText(method, path, timestamp, nonce, body) {
    const digest = await crypto.subtle.digest('SHA-256', typeof body === 'string' ? encoder.encode(body) : body);
    return `${method}\n${path}\n${timestamp}\n${nonce}\n${hex(digest)}`;
}
async function authenticate(request, env, body, db, now) {
    const id = request.headers.get('X-Collector-Id') || '';
    const entry = collectorRegistry(env)[id];
    const timestamp = request.headers.get('X-Collector-Timestamp') || '';
    const nonce = request.headers.get('X-Collector-Nonce') || '';
    const signature = request.headers.get('X-Collector-Signature') || '';
    if (!entry || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > AUTH_WINDOW
        || !/^[A-Za-z0-9_-]{20,80}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)
        || request.headers.get('CF-Connecting-IP') !== entry.expectedIpv4) throw httpError('unauthorized', 401);
    const key = await crypto.subtle.importKey('raw', encoder.encode(entry.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16)),
        encoder.encode(await collectorSigningText(request.method, new URL(request.url).pathname, timestamp, nonce, body)));
    if (!valid) throw httpError('unauthorized', 401);
    const inserted = await db.prepare('INSERT OR IGNORE INTO collector_nonces (collector_id, nonce, issued_at) VALUES (?1, ?2, ?3)')
        .bind(id, nonce, Number(timestamp)).run();
    if (!inserted.meta.changes) throw httpError('replayed-request', 409);
    await db.prepare('DELETE FROM collector_nonces WHERE issued_at < ?1').bind(now - AUTH_WINDOW).run();
    return id;
}

async function loadConfig(db) {
    const [settings, sources] = await Promise.all([
        db.prepare("SELECT value FROM settings WHERE key = 'main'").first('value'),
        db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data'),
    ]);
    const config = JSON.parse(settings || 'null'), subs = JSON.parse(sources || 'null');
    if (config?.storageType !== 'd1' || !Array.isArray(subs)) throw httpError('collector-storage-unavailable', 503);
    return { config, subs };
}
function configuredSource(sub, id) {
    try {
        return sub && sub.enabled === true && isCollectorSource(sub) && sub.fetchPolicy === 'cache-first'
            && sub.collectorId === id && new URL(sub.url).protocol === 'https:';
    } catch { return false; }
}
const CURRENT = `EXISTS (SELECT 1 FROM subscriptions, json_each(subscriptions.data) AS source
    WHERE subscriptions.id = 'main' AND json_extract(source.value, '$.id') = ?1
    AND json_extract(source.value, '$.url') = ?4 AND json_extract(source.value, '$.refreshVia') = 'collector'
    AND json_extract(source.value, '$.fetchPolicy') = 'cache-first'
    AND json_extract(source.value, '$.collectorId') = ?3 AND json_extract(source.value, '$.enabled') = 1)`;

export async function queueCollectorSource(env, sub, { resume = false, now = Date.now() } = {}) {
    const db = getBinding(env, 'MISUB_DB');
    if (!db || !collectorRegistry(env)[sub.collectorId] || !configuredSource(sub, sub.collectorId)) {
        return { success: false, error: 'collector-not-configured' };
    }
    const hash = await sourceUrlHash(sub.url);
    const result = await db.prepare(`INSERT INTO collector_jobs
        (source_id, source_url_hash, collector_id, requested_at) SELECT ?1, ?2, ?3, ?5 WHERE ${CURRENT}
        ON CONFLICT(source_id) DO UPDATE SET source_url_hash = ?2, collector_id = ?3, requested_at = ?5,
            paused = CASE WHEN collector_jobs.source_url_hash != ?2 OR collector_jobs.collector_id != ?3 OR ?6 = 1 THEN 0 ELSE collector_jobs.paused END,
            error_code = CASE WHEN collector_jobs.source_url_hash != ?2 OR collector_jobs.collector_id != ?3 OR ?6 = 1 THEN NULL ELSE collector_jobs.error_code END,
            next_attempt_at = CASE WHEN collector_jobs.source_url_hash != ?2 OR collector_jobs.collector_id != ?3 THEN 0 ELSE collector_jobs.next_attempt_at END,
            claim_token = CASE WHEN collector_jobs.source_url_hash != ?2 OR collector_jobs.collector_id != ?3 THEN NULL ELSE collector_jobs.claim_token END
        WHERE collector_jobs.source_url_hash != ?2 OR collector_jobs.collector_id != ?3 OR collector_jobs.paused = 0 OR ?6 = 1`)
        .bind(sub.id, hash, sub.collectorId, sub.url, now, resume ? 1 : 0).run();
    return result.meta.changes ? { success: true, queued: true, serverCacheOnly: true }
        : { success: false, error: 'collector-paused-or-source-changed' };
}

export async function collectorSourceStatus(env, sub) {
    const db = getBinding(env, 'MISUB_DB');
    const row = await db.prepare(`SELECT requested_at, next_attempt_at, paused, error_code, claim_token,
        (SELECT lock_until FROM subscription_cache WHERE source_id = ?1 AND format = 'lease' AND source_url_hash = ?2) AS lock_until
        FROM collector_jobs WHERE source_id = ?1 AND source_url_hash = ?2 AND collector_id = ?3`)
        .bind(sub.id, await sourceUrlHash(sub.url), sub.collectorId).first();
    return { id: sub.collectorId, queued: row?.requested_at != null, refreshing: Boolean(row?.claim_token && row.lock_until > Date.now()), paused: row?.paused === 1,
        nextAttemptAt: row?.next_attempt_at || null, error: row?.error_code || null };
}

async function claim(db, config, subs, id, now) {
    const store = new D1SourceCacheStore(db, { enforceSourceUrl: true, collectorId: id });
    const candidates = [];
    for (const sub of subs.filter(sub => configuredSource(sub, id))) {
        const hash = await sourceUrlHash(sub.url);
        let job = await db.prepare('SELECT * FROM collector_jobs WHERE source_id = ?1').bind(sub.id).first();
        if (job?.source_url_hash !== hash || job?.collector_id !== id) job = null;
        if (job?.paused || (config.sourceCacheEnabled !== true && job?.requested_at == null)) continue;
        if (job?.next_attempt_at > now && (job.requested_at == null || job.error_code)) continue;
        candidates.push({ sub, hash, job });
    }
    candidates.sort((a, b) => Number(b.job?.requested_at != null) - Number(a.job?.requested_at != null)
        || (a.job?.next_attempt_at || 0) - (b.job?.next_attempt_at || 0));
    for (const { sub, hash } of candidates) {
        const token = await store.lock(sub.id, hash, now, false, sub.url);
        if (!token) continue;
        const accepted = await db.prepare(`INSERT INTO collector_jobs
            (source_id, source_url_hash, collector_id, claim_token, next_attempt_at) SELECT ?1, ?2, ?3, ?5, ?7 WHERE ${CURRENT}
            ON CONFLICT(source_id) DO UPDATE SET source_url_hash = ?2, collector_id = ?3, claim_token = ?5,
                paused = 0, error_code = NULL, next_attempt_at = ?7,
                requested_at = CASE WHEN collector_jobs.source_url_hash = ?2 AND collector_jobs.collector_id = ?3 AND collector_jobs.requested_at > ?6 THEN collector_jobs.requested_at ELSE NULL END
            WHERE ${CURRENT}`)
            .bind(sub.id, hash, id, sub.url, token, now, now + CACHE_TIMING.retry).run();
        if (!accepted.meta.changes) continue;
        return [{ sourceId: sub.id, url: sub.url, urlHash: hash, leaseToken: token,
            leaseUntil: now + CACHE_TIMING.lock, formats: FORMATS, timeoutSeconds: 10 }];
    }
    return [];
}

function normalizeSnapshot(snapshot, format, decode) {
    if (!snapshot || typeof snapshot !== 'object') throw httpError('invalid-snapshot', 400);
    if (snapshot.failure) {
        if (!ERROR.test(snapshot.failure)) throw httpError('invalid-error-code', 400);
        return { text: '', count: 0, failure: snapshot.failure,
            retryAfterSeconds: Math.min(7 * 86400, Math.max(0, Number(snapshot.retryAfterSeconds) || 0)) };
    }
    if (typeof snapshot.text !== 'string' || encoder.encode(snapshot.text).length > MAX_SNAPSHOT_BYTES) throw httpError('invalid-snapshot-size', 400);
    const text = decode(snapshot.text);
    if (encoder.encode(text).length > MAX_SNAPSHOT_BYTES) throw httpError('invalid-snapshot-size', 400);
    const count = format === 'clash' ? (parseClashProxyList(text)?.length || 0) : countUniversalNodes(text);
    if (!count) return { text: '', count: 0, failure: 'unsupported-or-empty-response' };
    const userInfo = {};
    for (const key of ['upload', 'download', 'total', 'expire']) {
        const value = snapshot.userInfo?.[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) userInfo[key] = value;
    }
    return { text, count, userInfo: Object.keys(userInfo).length ? userInfo : null };
}

async function complete(db, subs, id, body, decode, now) {
    const sub = subs.find(sub => sub.id === body.sourceId && configuredSource(sub, id));
    if (!sub || await sourceUrlHash(sub.url) !== body.urlHash || typeof body.leaseToken !== 'string') throw httpError('stale-job', 409);
    const snapshots = Object.fromEntries(FORMATS.map(format => [format, normalizeSnapshot(body.snapshots?.[format], format, decode)]));
    const failures = Object.values(snapshots).filter(snapshot => snapshot.failure);
    const paused = failures.some(snapshot => ['provider-blocked', 'http-401', 'http-403'].includes(snapshot.failure));
    const delay = failures.length ? Math.max(CACHE_TIMING.retry, ...failures.map(snapshot => snapshot.retryAfterSeconds * 1000 || 0)) : CACHE_TIMING.fresh;
    const error = failures.find(snapshot => ['provider-blocked', 'http-401', 'http-403'].includes(snapshot.failure))?.failure || failures[0]?.failure || null;
    const update = db.prepare(`UPDATE collector_jobs SET next_attempt_at = ?6, paused = ?7, error_code = ?8, claim_token = NULL
        WHERE source_id = ?1 AND source_url_hash = ?2 AND collector_id = ?3 AND claim_token = ?5 AND ${CURRENT}
            AND EXISTS (SELECT 1 FROM subscription_cache WHERE source_id = ?1 AND format = 'lease' AND source_url_hash = ?2 AND lock_token = ?5 AND lock_until > ?9)`)
        .bind(sub.id, body.urlHash, id, sub.url, body.leaseToken, now + delay, paused ? 1 : 0, error, now);
    const published = await new D1SourceCacheStore(db, { enforceSourceUrl: true, collectorId: id })
        .publish(sub.id, body.urlHash, body.leaseToken, snapshots, now, sub.url, [update]);
    if (!published) throw httpError('stale-job', 409);
    return { success: true, paused, nextAttemptAt: now + delay };
}

export async function handleCollectorRequest(request, env, { decode, now = Date.now() } = {}) {
    try {
        const path = new URL(request.url).pathname;
        if (!['/api/collector/tasks', '/api/collector/results'].includes(path)) return reply({ error: 'not-found' }, 404);
        if (request.method !== 'POST') return reply({ error: 'method-not-allowed' }, 405);
        const db = getBinding(env, 'MISUB_DB');
        if (!db || !Object.keys(collectorRegistry(env)).length) return reply({ error: 'collector-not-configured' }, 503);
        const raw = await readLimited(request, path.endsWith('/tasks') ? 4096 : 3 * 1024 * 1024);
        const id = await authenticate(request, env, raw.bytes, db, now);
        const body = JSON.parse(raw.text || '{}');
        const { config, subs } = await loadConfig(db);
        return reply(path.endsWith('/tasks') ? { tasks: await claim(db, config, subs, id, now), nextPollSeconds: 60 }
            : await complete(db, subs, id, body, decode, now));
    } catch (error) {
        return reply({ error: error.status ? error.message : 'collector-request-failed' }, error.status || 503);
    }
}
