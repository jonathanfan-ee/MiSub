import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { onRequest } from '../functions/[[path]].js';

test('Clash requests retain two negotiated airport subscriptions through the full aggregation route', async () => {
    const values = new Map([
        ['worker_settings_v1', { storageType: 'kv', profileToken: 'test-token', useDirectClashMeta: true, showTrafficRemainingNode: false }],
        ['misub_profiles_v1', [{ id: 'self', name: 'Self', enabled: true, subscriptions: ['ss-airport', 'trojan-airport'], manualNodes: [] }]],
        ['misub_subscriptions_v1', [
            { id: 'ss-airport', name: 'Airport SS', enabled: true, url: 'https://ss-airport.example/sub' },
            { id: 'trojan-airport', name: 'Airport Trojan', enabled: true, url: 'https://trojan-airport.example/sub' },
        ]],
    ]);
    const originals = {
        'ss-airport.example': 'ss://' + btoa('aes-128-gcm:test-password') + '@ss.example:443#HK',
        'trojan-airport.example': 'trojan://test-password@trojan.example:443?sni=tls.example#JP',
    };
    const shadowTls = {
        name: 'HK', type: 'ss', server: 'ss.example', port: 443,
        cipher: 'aes-128-gcm', password: 'test-password',
        plugin: 'shadow-tls', 'plugin-opts': { host: 'tls.example', password: 'plugin-test-password', version: 3 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async request => {
        const links = originals[new URL(request.url).hostname];
        assert.ok(links, 'aggregation must not need an external converter');
        const nativeClash = new URL(request.url).hostname === 'ss-airport.example'
            && request.headers.get('User-Agent').includes('Clash');
        return new Response(nativeClash ? yaml.dump({
            proxies: [shadowTls], dns: { nameserver: ['https://airport-only.example/dns-query'] }, rules: ['MATCH,REJECT'],
            hosts: { 'ss.example': 'edge.example', 'edge.example': '203.0.113.10', 'unrelated.example': '203.0.113.11' },
        }) : btoa(links));
    };
    try {
        const response = await onRequest({
            request: new Request('https://misub.example/test-token/self', { headers: { 'User-Agent': 'ClashMeta/1.19.32' } }),
            env: { MISUB_KV: { get: async key => structuredClone(values.get(key) ?? null) } },
            waitUntil() {},
        });
        assert.equal(response.status, 200);
        const config = yaml.load(await response.text());
        assert.equal(config.proxies.length, 2);
        assert.deepEqual(config.proxies.map(p => p.type), ['ss', 'trojan']);
        assert.equal(config.proxies[1].server, 'trojan.example');
        assert.equal(config.hosts[config.proxies[0].server], '203.0.113.10');
        assert.equal(config.proxies[0].cipher, 'aes-128-gcm');
        assert.equal(config.proxies[0].plugin, 'shadow-tls');
        assert.deepEqual(config.proxies[0]['plugin-opts'], shadowTls['plugin-opts']);
        assert.equal(config.proxies[0].name, 'Airport SS - HK');
        assert.ok(!config.dns.nameserver.includes('https://airport-only.example/dns-query'));
        assert.equal(Object.keys(config.hosts).length, 1);
        assert.notDeepEqual(config.rules, ['MATCH,REJECT']);
        assert.equal(config.proxies[1].sni, 'tls.example');
        assert.equal(config.proxies[1].password, 'test-password');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
