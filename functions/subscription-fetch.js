// Fetch a universal share-link subscription, independently of the consuming client.
// Forwarding a Clash UA makes many providers return YAML, which the link pipeline
// cannot consume. Keep this consistent with the node-count/cache updater.
export const SUBSCRIPTION_USER_AGENT = 'SubscriptionFetcher/1.0';
export const CLASH_PROXY_HOSTS = Symbol('clash-proxy-hosts');
export const CLASH_PROXY_SOURCE = Symbol('clash-proxy-source');
export const CLASH_PROXY_ORIGINAL_NAME = Symbol('clash-proxy-original-name');

// Import only individual proxies. Airport DNS, rules and policy groups must not
// replace the administrator's aggregation template.
export function parseClashProxyList(text) {
    try {
        const config = yaml.load(text);
        if (!config || !Array.isArray(config.proxies)) return null;
        const proxies = config.proxies.filter(proxy => proxy && typeof proxy === 'object'
            && typeof proxy.type === 'string' && typeof proxy.server === 'string'
            && Number.isInteger(Number(proxy.port)) && Number(proxy.port) > 0 && Number(proxy.port) <= 65535);
        // Some airports deliberately give entry domains unusable public DNS
        // answers and supply the actual endpoints through hosts aliases. Retain
        // only mappings needed by these proxies, including alias chains.
        const hosts = config.hosts && typeof config.hosts === 'object' ? config.hosts : {};
        const source = {};
        for (const proxy of proxies) {
            proxy[CLASH_PROXY_SOURCE] = source;
            proxy[CLASH_PROXY_ORIGINAL_NAME] = proxy.name;
            const required = {};
            const pending = [proxy.server];
            const seen = new Set();
            while (pending.length) {
                const host = pending.pop();
                if (seen.has(host) || !Object.hasOwn(hosts, host)) continue;
                seen.add(host);
                const value = hosts[host];
                const targets = Array.isArray(value) ? value : [value];
                if (!targets.length || !targets.every(target => typeof target === 'string')) continue;
                required[host] = value;
                pending.push(...targets);
            }
            proxy[CLASH_PROXY_HOSTS] = required;
        }
        return proxies.length ? proxies : null;
    } catch {
        return null;
    }
}

export async function fetchSubscriptionText(sub, {
    decode,
    isUsable,
    fetchImpl = fetch,
    timeoutMs = 10000,
    preferClash = false,
    includeMetadata = false,
} = {}) {
    const cacheMatchesUrl = !sub.cachedFromUrl || sub.cachedFromUrl === sub.url;
    const cached = cacheMatchesUrl ? decode(sub.cachedRaw || '') : '';
    const fallback = (failure) => ({
        text: isUsable(cached) ? cached : '',
        usedSource: 'cache',
        failure,
    });
    if (sub.realtimeFetch === false) return fallback(null);

    const controller = new AbortController();
    let timer;
    try {
        const live = (async () => {
            const response = await fetchImpl(new Request(sub.url, {
                headers: { 'User-Agent': preferClash ? 'ClashMeta/1.19.32' : SUBSCRIPTION_USER_AGENT },
                redirect: 'follow',
                signal: controller.signal,
                cf: { insecureSkipVerify: true },
            }));
            if (!response.ok) return fallback(`http-${response.status}`);
            const text = decode(await response.text());
            const userInfo = {};
            for (const part of (response.headers.get('subscription-userinfo') || '').split(';')) {
                const [key, value] = part.trim().split('=');
                if (['upload', 'download', 'total', 'expire'].includes(key) && /^\d+$/.test(value)) userInfo[key] = Number(value);
            }
            return isUsable(text)
                ? { text, usedSource: 'live', failure: null, ...(includeMetadata ? {
                    userInfo: Object.keys(userInfo).length ? userInfo : null, headers: response.headers,
                } : {}) }
                : fallback('unsupported-or-empty-response');
        })();
        const deadline = new Promise((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                resolve(fallback('timeout'));
            }, timeoutMs);
        });
        return await Promise.race([live, deadline]);
    } catch {
        return fallback(controller.signal.aborted ? 'timeout' : 'fetch-failed');
    } finally {
        clearTimeout(timer);
    }
}
import yaml from 'js-yaml';

