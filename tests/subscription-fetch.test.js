import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSubscriptionText, SUBSCRIPTION_USER_AGENT } from '../functions/subscription-fetch.js';

const link = 'trojan://test-password@proxy.example:443?sni=example.com#HongKong';
const cachedLink = 'ss://YWVzLTEyOC1nY206dGVzdA@backup.example:443#备用';
const sub = { url: 'https://subscription.example/list', cachedRaw: cachedLink };
const decode = text => text.startsWith('base64:') ? Buffer.from(text.slice(7), 'base64').toString('utf8') : text;
const isUsable = text => /^(?:trojan|ss):\/\//m.test(text);
const load = (overrides, options) => fetchSubscriptionText({ ...sub, ...overrides }, { decode, isUsable, ...options });

test('requests universal links instead of triggering provider Clash YAML negotiation', async () => {
    const result = await load({}, {
        fetchImpl: async request => {
            const ua = request.headers.get('User-Agent');
            assert.equal(ua, SUBSCRIPTION_USER_AGENT);
            return new Response(ua.includes('Clash') ? 'proxies: []' : link);
        },
    });
    assert.deepEqual(result, { text: link, usedSource: 'live', failure: null });
});

test('decodes live and cache-only base64 without changing node parameters', async () => {
    const encoded = 'base64:' + Buffer.from(cachedLink).toString('base64');
    const live = await load({}, { fetchImpl: async () => new Response(encoded) });
    const cached = await load({ realtimeFetch: false, cachedRaw: encoded }, {
        fetchImpl: () => assert.fail('cache-only subscriptions must not fetch'),
    });
    assert.equal(live.text, cachedLink);
    assert.equal(cached.text, cachedLink);
    assert.equal(cached.usedSource, 'cache');
});

test('falls back to working cached links on HTTP errors and network rejection', async () => {
    for (const fetchImpl of [async () => new Response('', { status: 503 }), async () => { throw new Error('network failure'); }]) {
        const result = await load({}, { fetchImpl });
        assert.equal(result.text, cachedLink);
        assert.equal(result.usedSource, 'cache');
        assert.ok(result.failure);
    }
});

test('a successful HTTP response containing YAML or HTML does not erase cached nodes', async () => {
    for (const content of ['proxies:\n  - name: YAML-only', '<html>Provider unavailable</html>', '']) {
        const result = await load({}, { fetchImpl: async () => new Response(content) });
        assert.deepEqual(result, { text: cachedLink, usedSource: 'cache', failure: 'unsupported-or-empty-response' });
    }
});

test('timeout covers both fetch headers and a stalled response body, and aborts the request', async () => {
    for (const stallBody of [false, true]) {
        let signal;
        const result = await load({}, {
            timeoutMs: 10,
            fetchImpl: async request => {
                signal = request.signal;
                if (stallBody) return { ok: true, text: () => new Promise(() => {}) };
                return new Promise(() => {});
            },
        });
        assert.equal(result.text, cachedLink);
        assert.equal(result.failure, 'timeout');
        assert.equal(signal.aborted, true);
    }
});

test('does not reuse another URL cache or return unparseable cached content', async () => {
    for (const overrides of [{ cachedFromUrl: 'https://previous.example/list' }, { cachedRaw: '<html>not a node</html>' }]) {
        const result = await load(overrides, { fetchImpl: async () => new Response('', { status: 502 }) });
        assert.equal(result.text, '');
    }
});
