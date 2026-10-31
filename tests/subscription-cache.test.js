import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import yaml from 'js-yaml';
import { CACHE_TIMING, SourceCache, D1SourceCacheStore, sourceUrlHash, createSourceCache } from '../functions/subscription-cache.js';
import { onRequest } from '../functions/[[path]].js';

let mf, db;
const link = 'trojan://fixture-password@edge.example:443?sni=tls.example#Fixture';
const native = yaml.dump({
    hosts: { 'edge.example': '203.0.113.10' },
    proxies: [{ name: 'Fixture', type: 'ss', server: 'edge.example', port: 443,
        cipher: 'aes-128-gcm', password: 'fixture', plugin: 'shadow-tls',
        'plugin-opts': { host: 'tls.example', password: 'fixture-plugin', version: 3 } }],
});
const decode = text => text.startsWith('fixture64:') ? Buffer.from(text.slice(10), 'base64').toString('utf8') : text;
const source = id => ({ id, url: `https://${id}.example/sub`, enabled: true, fetchPolicy: 'cache-first' });
const goodFetch = async request => new Response(request.headers.get('User-Agent').includes('Clash')
    ? native : 'fixture64:' + Buffer.from(link).toString('base64'),
{ headers: { 'subscription-userinfo': 'upload=1; download=2; total=1000' } });
const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

before(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2024-06-13', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await db.prepare(await readFile(new URL('../migrations/0001_subscription_cache.sql', import.meta.url), 'utf8')).run();
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.split(';').filter(s => s.trim())) await db.prepare(statement).run();
});
after(async () => { await mf?.dispose(); });

test('cold snapshots preserve complete native YAML and universal links separately; fresh reads do not fetch or write', async () => {
    const sub = source('formats');
    let now = 1_000_000, calls = 0;
    const cache = new SourceCache(new D1SourceCacheStore(db), { decode, now: () => now,
        fetchImpl: request => { calls++; return goodFetch(request); } });
    assert.equal((await cache.read(sub, 'clash')).text, native);
    assert.equal((await cache.read(sub, 'universal')).text, link);
    assert.equal(calls, 2);
    const beforeRows = await cache.store.rows(sub.id, await sourceUrlHash(sub.url));
    now += CACHE_TIMING.fresh - 1;
    await cache.read(sub, 'clash');
    assert.equal(calls, 2);
    assert.deepEqual(await cache.store.rows(sub.id, await sourceUrlHash(sub.url)), beforeRows);
    const status = await cache.status(sub);
    assert.equal(status.clash.count, 1);
    assert.equal(status.universal.count, 1);
    assert.deepEqual(status.clash.userInfo, { upload: 1, download: 2, total: 1000 });
    assert.ok(!JSON.stringify(status).includes('fixture-password'));
    assert.ok(!JSON.stringify(status).includes(sub.url));
});

test('stale reads return before upstream completes, share one background refresh, and retain independent good formats', async () => {
    const sub = source('stale');
    let now = 2_000_000;
    const cache = new SourceCache(new D1SourceCacheStore(db), { decode, now: () => now, fetchImpl: goodFetch });
    await cache.read(sub, 'clash');
    now += CACHE_TIMING.fresh;
    const gate = deferred();
    let calls = 0;
    cache.fetchImpl = async request => {
        calls++;
        await gate.promise;
        return new Response(request.headers.get('User-Agent').includes('Clash') ? '<html>error</html>' : link + '\n' + link);
    };
    const pending = [], context = { waitUntil: promise => pending.push(promise) };
    const results = await Promise.all(Array.from({ length: 8 }, () => cache.read(sub, 'clash', context)));
    assert.ok(results.every(r => r.text === native));
    // These requests have already returned while the provider is still waiting.
    gate.resolve();
    await Promise.all(pending);
    assert.equal(calls, 2, 'one lease covers both format requests');
    const status = await cache.status(sub);
    assert.equal(status.clash.error, 'unsupported-or-empty-response');
    assert.equal(status.clash.lastSuccessAt, now - CACHE_TIMING.fresh);
    assert.equal(status.universal.count, 2);
    assert.equal(status.universal.lastSuccessAt, now);
    const retryTasks = [];
    await cache.read(sub, 'clash', { waitUntil: p => retryTasks.push(p) });
    await Promise.all(retryTasks);
    assert.equal(calls, 2, 'failure backoff prevents immediate refresh');
    now += CACHE_TIMING.retry;
    await cache.read(sub, 'clash', { waitUntil: p => retryTasks.push(p) });
    await Promise.all(retryTasks);
    assert.equal(calls, 4);
});

test('failed, empty, HTML and timed-out responses retain the last successful snapshots and warn after 24h', async () => {
    const sub = source('failures');
    let now = 3_000_000;
    const cache = new SourceCache(new D1SourceCacheStore(db), { decode, now: () => now, timeoutMs: 15, fetchImpl: goodFetch });
    await cache.read(sub, 'clash');
    const success = now;
    for (const fetchImpl of [
        async () => new Response('', { status: 503 }), async () => new Response(''),
        async () => new Response('<html>unavailable</html>'), async () => { throw new Error('secret URL must not leak'); },
        async () => ({ ok: true, text: () => new Promise(() => {}) }),
    ]) {
        now += CACHE_TIMING.retry;
        cache.fetchImpl = fetchImpl;
        await cache.refresh(sub, { force: true });
        const rows = await cache.store.rows(sub.id, await sourceUrlHash(sub.url));
        assert.equal(rows.find(r => r.format === 'clash').payload, native);
        assert.equal(rows.find(r => r.format === 'universal').payload, link);
        assert.equal((await cache.status(sub)).clash.lastSuccessAt, success);
    }
    now = success + CACHE_TIMING.warning;
    const status = await cache.status(sub);
    assert.equal(status.clash.warning, true);
    assert.equal(status.clash.error, 'timeout');
    const tasks = [];
    assert.equal((await cache.read(sub, 'clash', { waitUntil: p => tasks.push(p) })).text, native);
    await Promise.all(tasks);
});

test('URL changes ignore old snapshots and fence late jobs; expired leases cannot overwrite newer snapshots', async () => {
    const store = new D1SourceCacheStore(db), sub = source('fencing');
    const oldHash = await sourceUrlHash(sub.url), newHash = await sourceUrlHash(sub.url + '?changed');
    const oldToken = await store.lock(sub.id, oldHash, 10_000, false);
    const newerToken = await store.lock(sub.id, newHash, 10_001, false);
    const snapshots = { clash: { text: native, count: 1 }, universal: { text: link, count: 1 } };
    await store.publish(sub.id, newHash, newerToken, snapshots, 10_002);
    await store.publish(sub.id, oldHash, oldToken, { clash: { text: 'old' }, universal: { text: 'old' } }, 10_003);
    assert.equal((await store.rows(sub.id, oldHash)).length, 0);
    assert.equal((await store.rows(sub.id, newHash)).find(r => r.format === 'clash').payload, native);
    const token = await store.lock(sub.id, newHash, 20_000, true);
    assert.equal(await store.lock(sub.id, newHash, 20_001, true), null, 'manual refresh respects active lease');
    const replacement = await store.lock(sub.id, newHash, 20_000 + CACHE_TIMING.lock, true);
    await store.publish(sub.id, newHash, replacement, snapshots, 20_001 + CACHE_TIMING.lock);
    await store.publish(sub.id, newHash, token, { clash: { text: 'late' }, universal: { text: 'late' } }, 20_002 + CACHE_TIMING.lock);
    assert.equal((await store.rows(sub.id, newHash)).find(r => r.format === 'clash').payload, native);
});

test('a changed source URL never serves the previous URL snapshot when the replacement fails', async () => {
    const sub = source('change');
    const cache = new SourceCache(new D1SourceCacheStore(db), { decode, fetchImpl: goodFetch });
    await cache.read(sub, 'clash');
    sub.url += '?replacement';
    cache.fetchImpl = async () => new Response('', { status: 503 });
    assert.equal((await cache.read(sub, 'clash')).text, '');
    assert.equal((await cache.status(sub)).clash.lastSuccessAt, null);
});

test('concurrent cold requests share a source refresh', async () => {
    const sub = source('cold-concurrent');
    let calls = 0;
    const cache = new SourceCache(new D1SourceCacheStore(db), { decode,
        fetchImpl: async request => { calls++; await new Promise(r => setTimeout(r, 20)); return goodFetch(request); } });
    const results = await Promise.all(Array.from({ length: 6 }, () => cache.read(sub, 'clash')));
    assert.equal(calls, 2);
    assert.ok(results.every(result => result.text === native));
});

async function setupRoute({ flag = true, profile = {}, url = 'https://route.example/sub' } = {}) {
    const settings = { storageType: 'd1', sourceCacheEnabled: flag, useDirectClashMeta: true,
        profileToken: 'test-token', showTrafficRemainingNode: false };
    const sub = { ...source('route'), name: 'Airport', url };
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('main', ?1)").bind(JSON.stringify(settings)).run();
    await db.prepare("INSERT OR REPLACE INTO subscriptions (id, data) VALUES ('main', ?1)").bind(JSON.stringify([sub])).run();
    await db.prepare("INSERT OR REPLACE INTO profiles (id, data) VALUES ('main', ?1)").bind(JSON.stringify([
        { id: 'self', name: 'Self', enabled: true, subscriptions: [sub.id], manualNodes: [], ...profile },
    ])).run();
    return { MISUB_DB: db, COOKIE_SECRET: 'fixture-cookie-secret' };
}
const route = (env, token = 'test-token') => onRequest({ env, waitUntil() {},
    request: new Request(`https://misub.example/${token}/self`, { headers: { 'User-Agent': 'ClashMeta/1.19.32' } }) });

test('aggregation uses cached native fields and hosts without rewriting the subscription list', async () => {
    const env = await setupRoute();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = goodFetch;
    try {
        const before = await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data');
        const first = await route(env);
        assert.equal(first.status, 200);
        globalThis.fetch = () => assert.fail('fresh snapshot must avoid upstream');
        const config = yaml.load(await (await route(env)).text());
        assert.equal(config.proxies[0].plugin, 'shadow-tls');
        assert.equal(config.proxies[0]['plugin-opts'].version, 3);
        assert.equal(config.hosts[config.proxies[0].server], '203.0.113.10');
        assert.equal(await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data'), before);
    } finally { globalThis.fetch = originalFetch; }
});

test('a request holding an obsolete source configuration cannot acquire a new lease or publish after a URL edit', async () => {
    const env = await setupRoute({ url: 'https://before-edit.example/sub' });
    const cache = createSourceCache(env, { sourceCacheEnabled: true, storageType: 'd1' }, decode);
    const oldSub = { ...source('route'), url: 'https://before-edit.example/sub' };
    const oldHash = await sourceUrlHash(oldSub.url);
    const token = await cache.store.lock('route', oldHash, 10_000, false, oldSub.url);
    assert.ok(token);
    await setupRoute({ url: 'https://after-edit.example/sub' });
    const snapshots = { clash: { text: native, count: 1 }, universal: { text: link, count: 1 } };
    await cache.store.publish('route', oldHash, token, snapshots, 10_001, oldSub.url);
    assert.ok(!(await cache.store.rows('route', oldHash)).some(row => row.payload));
    assert.equal(await cache.store.lock('route', oldHash, 20_000, true, oldSub.url), null);
});

test('disabled, expired and invalid profile tokens never read the source cache or fetch the source', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('unauthorized/expired profile must not fetch');
    try {
        for (const options of [{ profile: { enabled: false } }, { profile: { expiresAt: '2000-01-01' } }, {}]) {
            const env = await setupRoute(options);
            let cacheQueries = 0;
            const wrapped = { ...env, MISUB_DB: { prepare(sql) {
                if (sql.includes('subscription_cache')) cacheQueries++;
                return db.prepare(sql);
            } } };
            const response = await route(wrapped, Object.keys(options).length ? 'test-token' : 'invalid-token');
            assert.ok([200, 403, 404].includes(response.status));
            assert.equal(cacheQueries, 0);
        }
    } finally { globalThis.fetch = originalFetch; }
});

test('global flag off never queries the cache table and retains the realtime and cache-only modes', async () => {
    assert.equal(createSourceCache({ MISUB_DB: db }, { storageType: 'd1', sourceCacheEnabled: false }, decode), null);
    const env = await setupRoute({ flag: false });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = request => { calls++; return goodFetch(request); };
    const wrapped = { ...env, MISUB_DB: { prepare(sql) {
        assert.ok(!sql.includes('subscription_cache'));
        return db.prepare(sql);
    } } };
    try {
        await route(wrapped);
        await route(wrapped);
        assert.equal(calls, 2);
        await db.prepare("UPDATE subscriptions SET data = ?1 WHERE id = 'main'").bind(JSON.stringify([
            { ...source('route'), realtimeFetch: false, cachedRaw: link, cachedFromUrl: 'https://route.example/sub' },
        ])).run();
        assert.equal((await route(wrapped)).status, 200);
        assert.equal(calls, 2);
    } finally { globalThis.fetch = originalFetch; }
});

async function adminRequest(env, path, body) {
    const timestamp = String(Date.now());
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp));
    const hex = Buffer.from(signature).toString('hex');
    return onRequest({ env, request: new Request('https://misub.example/api/' + path, {
        method: body ? 'POST' : 'GET', headers: { Cookie: `auth_session=${timestamp}.${hex}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    }), waitUntil() {} });
}

test('single and batch legacy refreshes preserve successful inline caches when providers fail or return invalid data', async () => {
    const env = await setupRoute({ flag: false });
    const sub = { ...source('route'), realtimeFetch: false, cachedRaw: link, cachedAt: 1234, nodeCount: 1 };
    await db.prepare("UPDATE subscriptions SET data = ?1 WHERE id = 'main'").bind(JSON.stringify([sub])).run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>unavailable</html>');
    try {
        const before = await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data');
        const single = await (await adminRequest(env, 'node_count', { id: sub.id, url: sub.url })).json();
        assert.equal(single.success, false);
        const batch = await (await adminRequest(env, 'batch_update_nodes', { subscriptionIds: [sub.id] })).json();
        assert.equal(batch.results[0].success, false);
        assert.equal(await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data'), before);
    } finally { globalThis.fetch = originalFetch; }
});

test('pilot manual refresh writes only cache rows, and the dashboard exposes metadata without snapshot payloads', async () => {
    const env = await setupRoute();
    await db.prepare("DELETE FROM subscription_cache WHERE source_id = 'route'").run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = goodFetch;
    try {
        const before = await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data');
        const result = await (await adminRequest(env, 'node_count', { id: 'route', url: 'https://route.example/sub' })).json();
        assert.equal(result.serverCacheOnly, true);
        assert.equal(result.success, true);
        assert.equal(result.cacheStatus.clash.count, 1);
        assert.equal(await db.prepare("SELECT data FROM subscriptions WHERE id = 'main'").first('data'), before);
        const dashboard = await (await adminRequest(env, 'data')).json();
        assert.equal(dashboard.misubs[0].cacheStatus.clash.count, 1);
        assert.ok(!JSON.stringify(dashboard.misubs[0].cacheStatus).includes('payload'));
    } finally { globalThis.fetch = originalFetch; }
});

test('a provider with only universal links still works in direct Clash output without promoting URI text to native YAML', async () => {
    const env = await setupRoute({ url: 'https://uri-only.example/sub' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(link);
    try {
        const config = yaml.load(await (await route(env)).text());
        assert.equal(config.proxies[0].type, 'trojan');
        const rows = await new D1SourceCacheStore(db).rows('route', await sourceUrlHash('https://uri-only.example/sub'));
        assert.equal(rows.find(row => row.format === 'clash').payload, '');
        assert.equal(rows.find(row => row.format === 'universal').payload, link);
    } finally { globalThis.fetch = originalFetch; }
});

test('manual refresh observes the shared cooldown rather than repeatedly requesting both upstream formats', async () => {
    const env = await setupRoute({ url: 'https://manual-cooldown.example/sub' });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = request => { calls++; return goodFetch(request); };
    try {
        const body = { id: 'route', url: 'https://manual-cooldown.example/sub' };
        assert.equal((await (await adminRequest(env, 'node_count', body)).json()).success, true);
        const result = await (await adminRequest(env, 'node_count', body)).json();
        assert.equal(result.success, false);
        assert.equal(result.error, 'refresh-in-progress-or-cooldown');
        assert.equal(calls, 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('missing migration falls back to realtime reads but refuses enabling the feature in settings', async () => {
    const env = await setupRoute();
    const noCacheDb = { ...env, MISUB_DB: { prepare(sql) {
        if (sql.includes('subscription_cache')) throw new Error('no such table');
        return db.prepare(sql);
    } } };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = goodFetch;
    try {
        assert.equal((await route(noCacheDb)).status, 200);
        const response = await adminRequest(noCacheDb, 'settings', { sourceCacheEnabled: true });
        assert.equal(response.status, 400);
    } finally { globalThis.fetch = originalFetch; }
});
