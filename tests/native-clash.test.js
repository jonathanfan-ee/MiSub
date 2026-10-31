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
    assert.equal(config.proxies[0].server, 'edge.example');
    assert.equal(config.proxies[0].sni, 'entry.example');
    assert.deepEqual(config.hosts['edge.example'], ['192.0.2.10', '192.0.2.11']);
    assert.ok(!Object.hasOwn(config.hosts, 'unrelated.example'));
    assert.ok(!yaml.dump(config).includes('clash-proxy-hosts'));
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
