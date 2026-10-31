import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import yaml from 'js-yaml';
import { handleCollectorRequest, collectorSigningText, queueCollectorSource, publicCollectors, MAX_SNAPSHOT_BYTES } from '../functions/collector-api.js';
import { D1SourceCacheStore, sourceUrlHash, CACHE_TIMING } from '../functions/subscription-cache.js';
import { onRequest } from '../functions/[[path]].js';

const secret = 'fixture-collector-secret-for-tests-only-123456789';
const ip = '203.0.113.10';
const link = 'trojan://fixture-password@edge.example:443?sni=tls.example#Fixture';
const native = yaml.dump({ hosts: { 'edge.example': '203.0.113.99' }, proxies: [
    { name: 'Fixture', type: 'ss', server: 'edge.example', port: 443, cipher: 'aes-128-gcm', password: 'fixture',
        plugin: 'shadow-tls', 'plugin-opts': { host: 'tls.example', password: 'fixture-plugin', version: 3 } },
] });
const snapshots = () => ({ clash: { text: native, userInfo: { total: 1024, upload: 0, download: 0 } }, universal: { text: link } });
const decode = text => /^(?:[a-z\d+/]{4})+(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/i.test(text.trim())
    ? Buffer.from(text.trim(), 'base64').toString('utf8') : text;
let mf, db, serial = 0;

before(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2024-06-13', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').filter(s => s.trim())) await db.prepare(statement).run();
});
after(async () => { await mf?.dispose(); });

function source(id = `source-${++serial}`, overrides = {}) {
    return { id, name: 'Fixture Airport', url: `https://${id}.example/sub?token=fixture`, enabled: true,
        fetchPolicy: 'cache-first', refreshVia: 'collector', collectorId: 'agent-a', realtimeFetch: false, ...overrides };
}
async function setup(sources = [source()], settings = {}) {
    const env = { MISUB_DB: db, COOKIE_SECRET: 'fixture-cookie-secret',
        MISUB_COLLECTORS: JSON.stringify({ 'agent-a': { secret, expectedIpv4: ip }, 'agent-b': { secret: secret + '-b', expectedIpv4: ip } }) };
    await db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('main',?1)")
        .bind(JSON.stringify({ storageType: 'd1', sourceCacheEnabled: true, useDirectClashMeta: true,
            profileToken: 'fixture-token', showTrafficRemainingNode: false, ...settings })).run();
    await db.prepare("INSERT OR REPLACE INTO subscriptions(id,data) VALUES ('main',?1)").bind(JSON.stringify(sources)).run();
    await db.prepare("INSERT OR REPLACE INTO profiles(id,data) VALUES ('main',?1)")
        .bind(JSON.stringify([{ id: 'self', name: 'Fixture', enabled: true, subscriptions: sources.map(s => s.id), manualNodes: [] }])).run();
    return env;
}
async function signed(env, path = '/api/collector/tasks', value = {}, { now = Date.now(), id = 'agent-a', nonce = crypto.randomUUID(), ...headers } = {}) {
    const body = JSON.stringify(value), timestamp = String(now);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JSON.parse(env.MISUB_COLLECTORS)[id]?.secret || secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(await collectorSigningText('POST', path, timestamp, nonce, body)))).toString('hex');
    return new Request('https://misub.example' + path, { method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'X-Collector-Id': id,
            'X-Collector-Timestamp': timestamp, 'X-Collector-Nonce': nonce, 'X-Collector-Signature': signature, ...headers } });
}
async function call(env, path, body, options = {}) {
    const request = await signed(env, path, body, options);
    const response = await handleCollectorRequest(request, env, { decode, now: options.now || Date.now() });
    return { status: response.status, ...await response.json() };
}
const claim = (env, now = Date.now(), options = {}) => call(env, '/api/collector/tasks', {}, { now, ...options });
const upload = (env, task, value = snapshots(), now = Date.now(), options = {}) => call(env, '/api/collector/results', {
    sourceId: task.sourceId, urlHash: task.urlHash, leaseToken: task.leaseToken, snapshots: value,
}, { now, ...options });
const client = env => onRequest({ env, request: new Request('https://misub.example/fixture-token/self?target=clash'), waitUntil() {} });
async function admin(env, endpoint, value) {
    const timestamp = String(Date.now());
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp))).toString('hex');
    return onRequest({ env, request: new Request('https://misub.example/api/' + endpoint,
        { method: value ? 'POST' : 'GET', headers: { Cookie: `auth_session=${timestamp}.${signature}`, 'Content-Type': 'application/json' },
            ...(value ? { body: JSON.stringify(value) } : {}) }), waitUntil() {} });
}

test('collector authentication binds signature, body, timestamp, nonce and registered IPv4; replay is rejected', async () => {
    const env = await setup();
    const before = await db.prepare('SELECT COUNT(*) AS count FROM collector_nonces').first('count');
    for (const headers of [{ 'CF-Connecting-IP': '203.0.113.11' }, { 'X-Collector-Signature': '0'.repeat(64) },
        { 'X-Collector-Timestamp': String(Date.now() - 600_000) }, { 'X-Collector-Id': 'unknown' }, { 'X-Collector-Id': 'toString' }]) {
        assert.equal((await call(env, '/api/collector/tasks', {}, headers)).status, 401);
    }
    assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM collector_nonces').first('count'), before);
    const request = await signed(env);
    assert.equal((await onRequest({ env, request: request.clone(), waitUntil() {} })).status, 200);
    assert.equal((await onRequest({ env, request, waitUntil() {} })).status, 409);
    const tampered = await signed(env);
    const replaced = new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: '{"tampered":true}' });
    assert.equal((await handleCollectorRequest(replaced, env, { decode })).status, 401);
    const bom = await signed(env);
    const bomBody = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]);
    assert.equal((await handleCollectorRequest(new Request(bom.url, { method: 'POST', headers: bom.headers, body: bomBody }), env, { decode })).status, 401,
        'signature covers exact bytes, including a prepended BOM');
    assert.equal((await handleCollectorRequest(new Request('https://misub.example/api/collector/tasks'), env, { decode })).status, 405);
    const oversized = new Request('https://misub.example/api/collector/tasks', { method: 'POST', body: 'x'.repeat(4097) });
    assert.equal((await handleCollectorRequest(oversized, env, { decode })).status, 413);
});

test('only assigned, enabled fixed sources are claimed; concurrent polls share one lease', async () => {
    const a = source(), b = source(undefined, { collectorId: 'agent-b' });
    const env = await setup([a, b, source(undefined, { enabled: false }), source(undefined, { refreshVia: 'pages' })]);
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(env, now)));
    assert.ok(results.every(result => result.status === 200));
    const tasks = results.flatMap(result => result.tasks);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].sourceId, a.id);
    assert.equal(tasks[0].url, a.url);
    const bTask = (await claim(env, now, { id: 'agent-b' })).tasks[0];
    assert.equal(bTask.sourceId, b.id);
    assert.equal((await upload(env, bTask, snapshots(), now + 1)).status, 409, 'another collector cannot upload this source');
});

test('validated snapshots preserve native fields and universal text, schedule 30min, and cannot be replayed', async () => {
    const sub = source(), env = await setup([sub]), now = Date.now();
    const before = await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data');
    const task = (await claim(env, now)).tasks[0];
    const value = snapshots();
    value.universal.text = Buffer.from(link).toString('base64');
    const result = await upload(env, task, value, now + 10);
    assert.equal(result.status, 200);
    assert.equal(result.nextAttemptAt, now + 10 + CACHE_TIMING.fresh);
    const rows = await new D1SourceCacheStore(db).rows(sub.id, await sourceUrlHash(sub.url));
    assert.equal(rows.find(row => row.format === 'clash').payload, native);
    assert.equal(rows.find(row => row.format === 'universal').payload, link);
    assert.equal((await upload(env, task, snapshots(), now + 11)).status, 409);
    assert.equal(await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data'), before);
    assert.equal((await claim(env, now + 60_000)).tasks.length, 0);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('fixed sources must never fetch on Pages');
    try {
        const response = await client(env);
        assert.equal(response.status, 200);
        const config = yaml.load(await response.text());
        assert.equal(config.proxies[0].plugin, 'shadow-tls');
        assert.equal(config.proxies[0]['plugin-opts'].version, 3);
        assert.equal(config.hosts[config.proxies[0].server], '203.0.113.99');
    } finally { globalThis.fetch = originalFetch; }
});

test('403 pauses collection, failures preserve good snapshots, normal refresh cannot unpause, explicit resume queues work', async () => {
    const sub = source(), env = await setup([sub]);
    let now = Date.now();
    await upload(env, (await claim(env, now)).tasks[0], snapshots(), now + 1);
    now += CACHE_TIMING.fresh + 2;
    const task = (await claim(env, now)).tasks[0];
    const failed = { clash: { failure: 'provider-blocked' }, universal: { failure: 'http-403' } };
    assert.equal((await upload(env, task, failed, now + 1)).paused, true);
    assert.equal((await claim(env, now + 2 * CACHE_TIMING.fresh)).tasks.length, 0);
    assert.equal((await queueCollectorSource(env, sub, { now: now + 2 })).success, false);
    assert.equal((await queueCollectorSource(env, sub, { resume: true, now: now + 3 })).queued, true);
    assert.equal((await claim(env, now + CACHE_TIMING.retry + 2)).tasks.length, 1);
    const rows = await new D1SourceCacheStore(db).rows(sub.id, await sourceUrlHash(sub.url));
    assert.equal(rows.find(row => row.format === 'clash').payload, native);
    assert.equal(rows.find(row => row.format === 'universal').payload, link);
});

test('429 Retry-After and the five-minute cooldown apply to manual refreshes as well', async () => {
    const sub = source(), env = await setup([sub]);
    const now = Date.now(), task = (await claim(env, now)).tasks[0];
    await upload(env, task, { clash: { failure: 'http-429', retryAfterSeconds: 3600 }, universal: { text: link } }, now + 1);
    await queueCollectorSource(env, sub, { now: now + 2 });
    assert.equal((await claim(env, now + 30 * 60_000)).tasks.length, 0);
    assert.equal((await claim(env, now + 3600_002)).tasks.length, 1);
});

test('an abandoned job is recovered after cooldown and late or reassigned uploads are fenced', async () => {
    const sub = source(), env = await setup([sub]);
    const now = Date.now(), old = (await claim(env, now)).tasks[0];
    assert.equal((await claim(env, now + 60_000)).tasks.length, 0);
    const next = (await claim(env, now + CACHE_TIMING.retry)).tasks[0];
    assert.ok(next);
    assert.notEqual(next.leaseToken, old.leaseToken);
    assert.equal((await upload(env, old, snapshots(), now + CACHE_TIMING.retry + 1)).status, 409);
    await setup([{ ...sub, collectorId: 'agent-b' }]);
    assert.equal((await upload(env, next, snapshots(), now + CACHE_TIMING.retry + 2)).status, 409);
});

test('URL edits invalidate old uploads and disabled sources cannot accept uploads', async () => {
    const sub = source(), env = await setup([sub]), now = Date.now();
    const task = (await claim(env, now)).tasks[0];
    await setup([{ ...sub, url: sub.url + '&changed=1' }]);
    assert.equal((await upload(env, task, snapshots(), now + 1)).status, 409);
    const newTask = (await claim(env, now + 2)).tasks[0];
    await setup([{ ...sub, url: sub.url + '&changed=1', enabled: false }]);
    assert.equal((await upload(env, newTask, snapshots(), now + 3)).status, 409);
});

test('invalid or oversized payloads cannot overwrite last good native snapshots', async () => {
    const sub = source(), env = await setup([sub]);
    let now = Date.now();
    await upload(env, (await claim(env, now)).tasks[0], snapshots(), now + 1);
    now += CACHE_TIMING.fresh + 2;
    const task = (await claim(env, now)).tasks[0];
    assert.equal((await upload(env, task, { clash: { text: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1) }, universal: { text: link } }, now + 1)).status, 400);
    const result = await upload(env, task, { clash: { text: '<html>error</html>' }, universal: { text: link + '\n' + link } }, now + 2);
    assert.equal(result.status, 200);
    const rows = await new D1SourceCacheStore(db).rows(sub.id, await sourceUrlHash(sub.url));
    assert.equal(rows.find(row => row.format === 'clash').payload, native);
    assert.equal(rows.find(row => row.format === 'clash').error_code, 'unsupported-or-empty-response');
    assert.equal(rows.find(row => row.format === 'universal').node_count, 2);
});

test('global automatic refresh off permits explicit prewarm but never makes Pages fetch, even without a snapshot or table', async () => {
    const sub = source(), env = await setup([sub], { sourceCacheEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('fixed source must not fall back to realtime');
    try {
        assert.equal((await client(env)).status, 503);
        assert.equal((await claim(env)).tasks.length, 0);
        assert.equal((await queueCollectorSource(env, sub)).success, true);
        const task = (await claim(env)).tasks[0];
        assert.ok(task, 'manual prewarm works with automatic collection off');
        assert.equal((await upload(env, task)).status, 200);
        assert.equal((await client(env)).status, 200);
        const unavailable = { ...env, MISUB_DB: { prepare(sql) {
            if (sql.includes('subscription_cache')) throw new Error('cache table unavailable');
            return db.prepare(sql);
        } } };
        assert.equal((await client(unavailable)).status, 503);
        const unavailableExternal = await admin(unavailable, 'fetch_external_url', { url: sub.url });
        assert.equal(unavailableExternal.status, 503);
        assert.ok(!(await unavailableExternal.text()).includes(sub.url));
        const count = await (await admin(env, 'node_count', { id: sub.id, url: sub.url })).json();
        assert.equal(count.queued, true);
        const external = await admin(env, 'fetch_external_url', { url: sub.url });
        assert.equal(external.status, 200);
        const cron = await onRequest({ env, request: new Request('https://misub.example/', { headers: { 'cf-cron': 'fixture' } }), waitUntil() {} });
        assert.equal(cron.status, 200);
    } finally { globalThis.fetch = originalFetch; }
});

test('unsaved fixed-source selection cannot accidentally trigger legacy single or batch pulls', async () => {
    const sub = source(undefined, { refreshVia: 'pages', fetchPolicy: 'legacy', realtimeFetch: true });
    const env = await setup([sub]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('save first, never perform an unexpected direct pull');
    try {
        const single = await (await admin(env, 'node_count', { id: sub.id, url: sub.url, refreshVia: 'collector' })).json();
        assert.equal(single.error, 'save-collector-source-first');
        const batch = await (await admin(env, 'batch_update_nodes', { subscriptionIds: [sub.id], collectorSourceIds: [sub.id] })).json();
        assert.equal(batch.results[0].error, 'save-collector-source-first');
    } finally { globalThis.fetch = originalFetch; }
});

test('admin status exposes counts and collector state but never machine credentials, job tokens or raw snapshots', async () => {
    const sub = source(), env = await setup([sub]);
    const safe = publicCollectors(env);
    assert.deepEqual(safe[0], { id: 'agent-a', expectedIpv4: ip });
    const response = await (await admin(env, 'data')).json();
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('leaseToken'));
    assert.ok(!serialized.includes(native));
    assert.equal(response.misubs[0].cacheStatus.collector.id, 'agent-a');
    const status = await admin(env, 'collector_status', { sourceId: sub.id, urlHash: await sourceUrlHash(sub.url) });
    assert.equal(status.status, 200);
    assert.equal((await admin(env, 'collector_status', { sourceId: sub.id, urlHash: 'old' })).status, 409);
});
