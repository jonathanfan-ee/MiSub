import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import yaml from 'js-yaml';
import { onRequest } from '../functions/[[path]].js';

function agent(fixture) {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', ['-B', fileURLToPath(new URL('../collector/tests/run_integration_fixture.py', import.meta.url))]);
        const output = [], errors = [];
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture collector timed out')); }, 20000);
        child.stdout.on('data', chunk => output.push(chunk));
        child.stderr.on('data', chunk => errors.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            clearTimeout(timer);
            if (code) return reject(new Error(Buffer.concat(errors).toString()));
            resolve(JSON.parse(Buffer.concat(output).toString()));
        });
        child.stdin.end(JSON.stringify(fixture));
    });
}

test('Python collector negotiates both fixtures, signs requests, writes real local D1 and serves native Clash without any Pages upstream fetch', async () => {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2024-06-13', d1Databases: ['DB'] });
    const directory = await mkdtemp(join(tmpdir(), 'misub-collector-e2e-'));
    let server, originalFetch = globalThis.fetch;
    try {
        const db = await mf.getD1Database('DB');
        const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
        for (const statement of schema.split(';').filter(s => s.trim())) await db.prepare(statement).run();
        const secret = 'fixture-e2e-secret-for-tests-only-123456789';
        const env = { MISUB_DB: db, MISUB_COLLECTORS: JSON.stringify({ fixture: { secret, expectedIpv4: '203.0.113.10' } }) };
        await db.prepare("INSERT INTO settings(key,value) VALUES ('main',?1)").bind(JSON.stringify({ storageType: 'd1', sourceCacheEnabled: true,
            profileToken: 'fixture-token', useDirectClashMeta: true, showTrafficRemainingNode: false })).run();
        await db.prepare("INSERT INTO subscriptions(id,data) VALUES ('main',?1)").bind(JSON.stringify([
            { id: 'airport', name: 'Airport', enabled: true, fetchPolicy: 'cache-first', refreshVia: 'collector', collectorId: 'fixture', realtimeFetch: false,
                url: 'https://airport.example/sub?token=fixture-only' },
        ])).run();
        await db.prepare("INSERT INTO profiles(id,data) VALUES ('main',?1)").bind(JSON.stringify([
            { id: 'self', name: 'Fixture', enabled: true, subscriptions: ['airport'], manualNodes: [] },
        ])).run();
        const native = yaml.dump({ hosts: { 'edge.example': '203.0.113.99' }, proxies: [
            { name: 'HK', type: 'ss', server: 'edge.example', port: 443, cipher: 'aes-128-gcm', password: 'fixture',
                plugin: 'shadow-tls', 'plugin-opts': { version: 3, host: 'tls.example', password: 'fixture-plugin' } },
        ] });
        let airportRequests = 0;
        server = createServer(async (incoming, outgoing) => {
            try {
                if (incoming.url === '/fixture-airport') {
                    airportRequests++;
                    outgoing.writeHead(200, { 'subscription-userinfo': 'total=4096; upload=0; download=1024', 'Content-Type': 'text/plain' });
                    outgoing.end(incoming.headers['user-agent'].includes('Clash') ? native : Buffer.from('trojan://fixture@edge.example:443#Fixture').toString('base64'));
                    return;
                }
                const chunks = [];
                for await (const chunk of incoming) chunks.push(chunk);
                const request = new Request('https://misub.example' + incoming.url, { method: incoming.method,
                    headers: { ...incoming.headers, 'CF-Connecting-IP': '203.0.113.10' }, body: Buffer.concat(chunks) });
                const response = await onRequest({ env, request, waitUntil() {} });
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                outgoing.end(await response.text());
            } catch {
                outgoing.writeHead(500);
                outgoing.end('fixture handler failed');
            }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        globalThis.fetch = () => assert.fail('Pages must not contact upstream');
        const fixture = { config: { misubUrl: 'https://misub.example', id: 'fixture', secret }, port: server.address().port, stateDir: directory, clockOffsetSeconds: 60 };
        assert.equal((await agent(fixture)).status, 'uploaded');
        assert.equal(airportRequests, 2);
        assert.equal((await agent(fixture)).status, 'idle');
        for (let i = 0; i < 3; i++) {
            const response = await onRequest({ env, request: new Request('https://misub.example/fixture-token/self?target=clash'), waitUntil() {} });
            assert.equal(response.status, 200);
            const config = yaml.load(await response.text());
            assert.equal(config.proxies[0].plugin, 'shadow-tls');
            assert.equal(config.proxies[0]['plugin-opts'].version, 3);
            assert.equal(config.hosts[config.proxies[0].server], '203.0.113.99');
        }
        assert.equal(airportRequests, 2, 'client requests never trigger new upstream pulls');
        assert.equal((await stat(join(directory, 'rate.json'))).mode & 0o777, 0o600);
    } finally {
        globalThis.fetch = originalFetch;
        if (server) await new Promise(resolve => server.close(resolve));
        await mf.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});
