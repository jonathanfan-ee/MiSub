import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { parseClashProxyList } from '../functions/subscription-fetch.js';
import { generateClashMetaYAML } from '../functions/clash-meta-generator.js';

const fixture = {
    proxies: [{ name: 'Native', type: 'trojan', server: 'entry.example', port: 443, password: 'test-password' }],
    hosts: { 'entry.example': 'edge.example', 'edge.example': ['192.0.2.10', '192.0.2.11'], 'unrelated.example': '192.0.2.12' },
};

test('materializes airport endpoint aliases while retaining address lists and TLS identity', async () => {
    const nodes = parseClashProxyList(yaml.dump(fixture));
    const config = yaml.load(await generateClashMetaYAML(nodes));
    assert.match(config.proxies[0].server, /^misub-.*\.invalid$/);
    assert.equal(config.proxies[0].sni, 'entry.example');
    assert.deepEqual(config.hosts[config.proxies[0].server], ['192.0.2.10', '192.0.2.11']);
    assert.ok(!Object.hasOwn(config.hosts, 'unrelated.example'));
    assert.ok(!yaml.dump(config).includes('clash-proxy-hosts'));
});

test('isolates same-name entry mappings from different airports', async () => {
    const first = parseClashProxyList(yaml.dump({ ...fixture, hosts: { 'entry.example': '192.0.2.1' } }));
    const second = parseClashProxyList(yaml.dump({ ...fixture, hosts: { 'entry.example': '192.0.2.2' } }));
    const config = yaml.load(await generateClashMetaYAML([...first, ...second]));
    assert.equal(config.proxies.length, 2);
    assert.notEqual(config.proxies[0].server, config.proxies[1].server);
    assert.equal(config.hosts[config.proxies[0].server], '192.0.2.1');
    assert.equal(config.hosts[config.proxies[1].server], '192.0.2.2');
    assert.equal(config.proxies[0].sni, 'entry.example');
    assert.equal(config.proxies[1].sni, 'entry.example');
});

test('rewrites local upstream references after prefixing and name deduplication', async () => {
    const makeSource = () => parseClashProxyList(yaml.dump({ proxies: [
        { name: 'Hop', type: 'socks5', server: 'hop.example', port: 1080 },
        { name: 'Child', type: 'trojan', server: 'child.example', port: 443, password: 'test-password', 'dialer-proxy': 'Hop' },
    ] }));
    const first = makeSource().map(node => ({ ...node, name: `Airport - ${node.name}` }));
    const second = makeSource().map(node => ({ ...node, name: `Airport - ${node.name}` }));
    const config = yaml.load(await generateClashMetaYAML([...first, ...second]));
    assert.equal(config.proxies[1]['dialer-proxy'], config.proxies[0].name);
    assert.equal(config.proxies[3]['dialer-proxy'], config.proxies[2].name);
    assert.notEqual(config.proxies[0].name, config.proxies[2].name);
});

test('omits nodes whose subscription-local upstream was filtered out', async () => {
    const nodes = parseClashProxyList(yaml.dump({ proxies: [
        { name: 'Available', type: 'socks5', server: 'hop.example', port: 1080 },
        { name: 'MissingHop', type: 'trojan', server: 'child.example', port: 443, password: 'test-password', 'dialer-proxy': 'FilteredOut' },
        { name: 'Dependent', type: 'trojan', server: 'child.example', port: 443, password: 'test-password', 'dialer-proxy': 'MissingHop' },
    ] }));
    const config = yaml.load(await generateClashMetaYAML(nodes));
    assert.deepEqual(config.proxies.map(proxy => proxy.name), ['Available']);
});

test('administrator template hosts take precedence over airport host mappings', async () => {
    const nodes = parseClashProxyList(yaml.dump(fixture));
    const config = yaml.load(await generateClashMetaYAML(nodes, {
        hosts: { 'entry.example': '192.0.2.20' },
        'proxy-groups': [{ name: 'Select', type: 'select', proxies: ['__AUTO_INSERT_NODES__'] }],
        rules: ['MATCH,Select'],
    }));
    assert.equal(config.proxies[0].server, 'entry.example');
    assert.equal(config.hosts['entry.example'], '192.0.2.20');
});

test('preserves HTTPS proxy verification identity and explicit SNI', async () => {
    for (const sni of [undefined, 'explicit-tls.example']) {
        const nodes = parseClashProxyList(yaml.dump({
            proxies: [{ name: 'HTTPS', type: 'http', server: 'entry.example', port: 443, tls: true, ...(sni ? { sni } : {}) }],
            hosts: { 'entry.example': '192.0.2.10' },
        }));
        const config = yaml.load(await generateClashMetaYAML(nodes));
        assert.notEqual(config.proxies[0].server, 'entry.example');
        assert.equal(config.proxies[0].sni, sni || 'entry.example');
        assert.ok(!config.proxies[0]['skip-cert-verify']);
    }
});

test('preserves implicit and explicit WebSocket Host, path and TLS identity', async () => {
    for (const headers of [{}, { hOsT: 'explicit-ws.example' }]) {
        const nodes = parseClashProxyList(yaml.dump({
            proxies: [{ name: 'WS', type: 'vmess', server: 'entry.example', port: 443, tls: true,
                network: 'ws', uuid: '00000000-0000-0000-0000-000000000001',
                'ws-opts': { path: '/websocket', headers } }],
            hosts: { 'entry.example': '192.0.2.10' },
        }));
        const config = yaml.load(await generateClashMetaYAML(nodes));
        const proxy = config.proxies[0];
        assert.equal(proxy['ws-opts'].path, '/websocket');
        assert.deepEqual(proxy['ws-opts'].headers, Object.keys(headers).length ? headers : { Host: 'entry.example' });
        assert.equal(proxy.servername, headers.hOsT || 'entry.example');
    }
});

test('preserves implicit HTTP transport Host without changing an explicit header', async () => {
    for (const headers of [{}, { Host: ['explicit-http.example'] }]) {
        const nodes = parseClashProxyList(yaml.dump({
            proxies: [{ name: 'HTTP transport', type: 'vmess', server: 'entry.example', port: 443, tls: true,
                network: 'http', uuid: '00000000-0000-0000-0000-000000000001', 'http-opts': { path: ['/transport'], headers } }],
            hosts: { 'entry.example': '192.0.2.10' },
        }));
        const config = yaml.load(await generateClashMetaYAML(nodes));
        assert.deepEqual(config.proxies[0]['http-opts'].headers, Object.keys(headers).length ? headers : { Host: ['entry.example'] });
        assert.equal(config.proxies[0].servername, 'entry.example');
    }
});
