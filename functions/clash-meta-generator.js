/**
 * Clash Meta YAML 配置生成器
 * 直接生成适配 Clash Meta 内核的配置，无需 subconverter
 */

import yaml from 'js-yaml';

// mihomo 的保留名称：节点名不能和它们冲突，否则代理组引用会指向错误的目标
const RESERVED_PROXY_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE']);

/** base64 / base64url 解码为 UTF-8 字符串（自动补 padding）。失败返回 null。 */
function b64ToUtf8(input) {
    if (input === undefined || input === null) return null;
    try {
        const normalized = String(input).trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!normalized) return null;
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const binaryString = atob(padded);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return null;
    }
}

/** 安全的 URI 解码：名称里带裸 '%' 时 decodeURIComponent 会抛 URIError，退回原文而不是丢掉整个节点。 */
function safeDecode(value) {
    if (!value) return '';
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** 把 IPv6 字面量外层的方括号去掉：mihomo 的 server 字段要裸地址。 */
function cleanHost(host) {
    return String(host || '').replace(/^\[|\]$/g, '');
}

/** 各家分享链接对「跳过证书校验」的写法五花八门，统一判定。 */
function isTruthyFlag(value) {
    if (value === null || value === undefined) return false;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readInsecure(params) {
    return isTruthyFlag(params.get('insecure'))
        || isTruthyFlag(params.get('allowInsecure'))
        || isTruthyFlag(params.get('allowinsecure'))
        || isTruthyFlag(params.get('allow_insecure'))
        || isTruthyFlag(params.get('skip-cert-verify'))
        || isTruthyFlag(params.get('skip_cert_verify'));
}

/** alpn 参数可能是 "h3" 或 "h2,http/1.1"，mihomo 需要数组。 */
function parseAlpn(value) {
    if (!value) return null;
    const list = String(value).split(',').map(s => s.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
}

/**
 * 将节点链接数组转换为 Clash Meta 代理对象数组
 * @param {string[]} nodeLinks 节点链接
 * @param {{groupNames?: Set<string>}} [options] groupNames 用于避免节点名和代理组同名
 * @returns {Promise<{proxies: object[], skipped: {link: string, reason: string}[]}>}
 */
export async function convertLinksToClashProxies(nodeLinks, options = {}) {
    const proxies = [];
    const skipped = [];
    // 只用一个「已占用名称」集合。
    // 之前用 name -> count 的写法会自己造出重名：例如输入 A、A、A [2] 时，
    // 第二个 A 被改成 "A [2]"，和后面真实存在的 "A [2]" 撞车，而 mihomo 会
    // 因为 proxies 里有重复 name 直接拒绝整份配置。
    const usedNames = new Set(options.groupNames ? Array.from(options.groupNames) : []);

    const parsers = [
        ['vmess://', parseVmess],
        ['vless://', parseVless],
        ['trojan://', parseTrojan],
        ['ssr://', parseShadowsocksR],   // 必须排在 ss:// 之前，否则 ssr:// 会被 ss:// 前缀吃掉
        ['ss://', parseShadowsocks],
        ['hysteria2://', parseHysteria2],
        ['hy2://', parseHysteria2],
        ['hysteria://', parseHysteria],
        ['hy://', parseHysteria],
        ['tuic://', parseTuic],
        ['anytls://', parseAnyTls],
        ['socks5://', parseSocks5],
    ];

    for (const link of nodeLinks) {
        const trimmed = String(link || '').trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();

        const entry = parsers.find(([prefix]) => lower.startsWith(prefix));
        if (!entry) {
            skipped.push({ link: trimmed.substring(0, 60), reason: '不支持的协议' });
            continue;
        }

        try {
            const proxy = entry[1](trimmed);
            if (!proxy || !proxy.server || !proxy.port) {
                skipped.push({ link: trimmed.substring(0, 60), reason: '缺少 server/port' });
                continue;
            }

            // 名称去重：包含与代理组、与 DIRECT/REJECT 等保留名的冲突
            let baseName = String(proxy.name || `${proxy.server}:${proxy.port}`).trim() || `${proxy.server}:${proxy.port}`;
            if (RESERVED_PROXY_NAMES.has(baseName.toUpperCase())) baseName = `${baseName} (节点)`;
            let candidate = baseName;
            let suffix = 1;
            while (usedNames.has(candidate)) {
                suffix += 1;
                candidate = `${baseName} [${suffix}]`;
            }
            usedNames.add(candidate);
            proxy.name = candidate;

            proxies.push(proxy);
        } catch (error) {
            skipped.push({ link: trimmed.substring(0, 60), reason: error.message });
            console.error(`Failed to parse proxy link: ${trimmed.substring(0, 50)}...`, error);
        }
    }

    return { proxies, skipped };
}

/**
 * 生成完整的 Clash Meta YAML 配置
 */
/**
 * 编译代理组的 filter 表达式。
 * mihomo 用的是 Go 的 regexp，行内标志写法 `(?i)` 在 JavaScript 的 RegExp 里是语法错误
 * （项目自己的文档 QUICK_SETUP_CLASH_META.md 里给的示例正是这种写法）。
 * 这里把行内标志翻译成 JS 的 flags，并且编译失败时返回 null 而不是抛异常 ——
 * 否则一个组的 filter 写错会让整份 Clash Meta 配置生成失败、静默退回 subconverter。
 * @param {string} filter
 * @returns {RegExp|null}
 */
function compileGroupFilter(filter) {
    let pattern = String(filter);
    let flags = 'i'; // 保持原有的默认忽略大小写行为
    // 允许开头连续出现多个行内标志，例如 (?i)(?s)
    const inlineFlag = /^\(\?([imsU]+)\)/;
    let match;
    while ((match = pattern.match(inlineFlag))) {
        for (const f of match[1]) {
            if (f === 'i' && !flags.includes('i')) flags += 'i';
            if (f === 's' && !flags.includes('s')) flags += 's';
            if (f === 'm' && !flags.includes('m')) flags += 'm';
            // Go 的 U（非贪婪反转）在 JS 里没有对应项，忽略
        }
        pattern = pattern.slice(match[0].length);
    }
    try {
        return new RegExp(pattern, flags);
    } catch (e) {
        console.warn(`[ClashMeta] 代理组 filter 无法编译，已忽略该筛选条件: ${filter} (${e.message})`);
        return null;
    }
}

export async function generateClashMetaYAML(nodeLinks, templateConfig, settings = {}) {
    try {
        // 3. 先构建基础配置（使用模板或默认配置），这样解析节点时就能避开代理组同名
        const config = templateConfig ? JSON.parse(JSON.stringify(templateConfig)) : getDefaultClashMetaConfig();
        const groupNames = new Set(
            Array.isArray(config['proxy-groups'])
                ? config['proxy-groups'].map(g => g && g.name).filter(Boolean)
                : []
        );

        // 1. 转换节点
        const { proxies, skipped } = await convertLinksToClashProxies(nodeLinks, { groupNames });

        if (skipped.length > 0) {
            // 不静默丢弃：把跳过的节点写进日志，方便在 Cloudflare 日志里定位
            console.warn(`[ClashMeta] 有 ${skipped.length} 个节点未能转换：`,
                skipped.slice(0, 10).map(s => `${s.reason} <- ${s.link}`).join(' | '));
        }

        if (proxies.length === 0) {
            throw new Error('没有有效的代理节点');
        }

        // 2. 获取所有节点名称
        const proxyNames = proxies.map(p => p.name);

        // 4. 设置代理列表
        config.proxies = proxies;

        // 5. 处理代理组 - 支持 filter 字段的智能筛选
        if (Array.isArray(config['proxy-groups'])) {
            config['proxy-groups'].forEach(group => {
                if (!group || typeof group !== 'object') return;

                // 如果组定义了 filter 字段，使用筛选逻辑
                if (group.filter) {
                    const filterRegex = compileGroupFilter(group.filter);
                    // filter 编译失败时退回「全部节点」，而不是产出一个空组
                    const filteredNodes = filterRegex ? proxyNames.filter(name => filterRegex.test(name)) : [...proxyNames];

                    if (Array.isArray(group.proxies)) {
                        const index = group.proxies.indexOf('__AUTO_INSERT_NODES__');
                        if (index !== -1) {
                            group.proxies.splice(index, 1, ...filteredNodes);
                        } else {
                            // 如果没有占位符，追加到末尾
                            group.proxies.push(...filteredNodes);
                        }
                    } else {
                        // 如果没有 proxies 字段，创建一个
                        group.proxies = filteredNodes;
                    }

                    // 移除 filter 字段（Clash Meta 不支持在 proxies 模式下使用）
                    delete group.filter;
                } else {
                    // 没有 filter 字段，使用原有的占位符逻辑
                    if (Array.isArray(group.proxies)) {
                        const index = group.proxies.indexOf('__AUTO_INSERT_NODES__');
                        if (index !== -1) {
                            group.proxies.splice(index, 1, ...proxyNames);
                        } else if (settings.autoInsertToSelect && group.type === 'select') {
                            // 在 select 类型的组中自动插入节点（在固定选项之后）
                            const fixedOptions = ['DIRECT', 'REJECT'];
                            const lastFixedIndex = Math.max(
                                ...fixedOptions.map(opt => group.proxies.indexOf(opt))
                            );
                            if (lastFixedIndex >= 0) {
                                group.proxies.splice(lastFixedIndex + 1, 0, ...proxyNames);
                            } else {
                                group.proxies.push(...proxyNames);
                            }
                        }
                    }
                }
            });

            // 5b. 清理：删掉残留的占位符，并处理「空组」。
            // mihomo 遇到 proxies 为空的代理组会直接拒绝加载整份配置 ——
            // 只要有一个 filter 没匹配到任何节点，客户端就完全用不了。
            config['proxy-groups'].forEach(group => {
                if (!group || !Array.isArray(group.proxies)) return;
                group.proxies = group.proxies.filter(p => p !== '__AUTO_INSERT_NODES__');
            });

            const removedGroups = new Set();
            let changed = true;
            // 反复清理：删掉一个空组后，引用它的组可能也变空
            while (changed) {
                changed = false;
                config['proxy-groups'].forEach(group => {
                    if (!group || !Array.isArray(group.proxies) || removedGroups.has(group.name)) return;
                    group.proxies = group.proxies.filter(p => !removedGroups.has(p));
                    if (group.proxies.length === 0) {
                        removedGroups.add(group.name);
                        changed = true;
                    }
                });
            }
            if (removedGroups.size > 0) {
                console.warn(`[ClashMeta] 以下代理组没有匹配到任何节点，已移除以保证配置可加载: ${Array.from(removedGroups).join(', ')}`);
                config['proxy-groups'] = config['proxy-groups'].filter(g => g && !removedGroups.has(g.name));
                // 规则里引用了被删除的组时，改指向兜底目标，避免 mihomo 报 "rule target not found"
                const fallback = config['proxy-groups'].find(g => g && g.name)?.name || 'DIRECT';
                if (Array.isArray(config.rules)) {
                    config.rules = config.rules.map(rule => {
                        if (typeof rule !== 'string') return rule;
                        const parts = rule.split(',');
                        // 规则形如 TYPE,VALUE,TARGET[,no-resolve]；target 通常是第 3 段，MATCH 只有 2 段
                        const targetIndex = parts[0].trim().toUpperCase() === 'MATCH' ? 1 : 2;
                        if (parts.length > targetIndex && removedGroups.has(parts[targetIndex].trim())) {
                            parts[targetIndex] = fallback;
                            return parts.join(',');
                        }
                        return rule;
                    });
                }
            }
        }

        // 6. 生成 YAML
        const yamlStr = yaml.dump(config, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            sortKeys: false,
            flowLevel: -1
        });

        return yamlStr;

    } catch (error) {
        console.error('[generateClashMetaYAML] Error:', error);
        throw error;
    }
}

/**
 * 解析 Trojan 链接
 */
function parseTrojan(link) {
    const url = new URL(link);
    const password = safeDecode(url.username);
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 443;
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;

    const proxy = {
        name,
        type: 'trojan',
        server,
        port,
        password,
        udp: true,
        'skip-cert-verify': false
    };

    // 解析查询参数
    const params = url.searchParams;

    if (params.get('sni')) proxy.sni = params.get('sni');
    const alpn = parseAlpn(params.get('alpn'));
    if (alpn) proxy.alpn = alpn;
    if (readInsecure(params)) {
        proxy['skip-cert-verify'] = true;
    }

    // 解析传输层。只放行 mihomo 对 trojan 真正支持的传输方式，
    // 其余（kcp/quic/xhttp 等）直接按 tcp 处理 —— 原样写进配置只会产生连不上的死节点。
    const rawNetwork = (params.get('type') || params.get('network') || '').toLowerCase();
    const network = ['ws', 'grpc', 'h2', 'http'].includes(rawNetwork) ? rawNetwork : 'tcp';
    if (rawNetwork && network === 'tcp' && rawNetwork !== 'tcp') {
        console.warn(`[ClashMeta] trojan 节点「${name}」使用了不支持的传输方式 ${rawNetwork}，已按 tcp 处理`);
    }
    if (network && network !== 'tcp') {
        proxy.network = network;

        if (network === 'ws') {
            proxy['ws-opts'] = {
                path: params.get('path') || '/'
            };
            const wsHost = params.get('host') || params.get('ws-host');
            if (wsHost) {
                proxy['ws-opts'].headers = { Host: wsHost };
            }
        } else if (network === 'grpc') {
            proxy['grpc-opts'] = {
                'grpc-service-name': params.get('serviceName') || params.get('path') || ''
            };
        } else if (network === 'h2' || network === 'http') {
            proxy.network = 'h2';
            proxy['h2-opts'] = {
                path: params.get('path') || '/'
            };
            const h2Host = params.get('host');
            if (h2Host) {
                proxy['h2-opts'].host = h2Host.includes(',') ? h2Host.split(',') : [h2Host];
            }
        }
        // mihomo 的 h2 传输必须走 TLS，缺少 tls 时该节点连不上
        if (proxy.network === 'h2') proxy.tls = true;
    }

    return proxy;
}

/**
 * 解析 VLESS 链接
 */
function parseVless(link) {
    const url = new URL(link);
    const uuid = safeDecode(url.username);
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 443;
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;

    const proxy = {
        name,
        type: 'vless',
        server,
        port,
        uuid,
        udp: true,
        'skip-cert-verify': false
    };

    const params = url.searchParams;

    // TLS
    const security = (params.get('security') || params.get('encryption') || '').toLowerCase();
    if (security === 'tls' || security === 'reality') {
        proxy.tls = true;

        if (params.get('sni')) proxy.servername = params.get('sni');
        const alpn = parseAlpn(params.get('alpn'));
        if (alpn) proxy.alpn = alpn;
        if (readInsecure(params)) {
            proxy['skip-cert-verify'] = true;
        }

        // Reality
        if (security === 'reality') {
            proxy['reality-opts'] = {};
            if (params.get('pbk')) proxy['reality-opts']['public-key'] = params.get('pbk');
            if (params.get('sid')) proxy['reality-opts']['short-id'] = params.get('sid');
            // reality 必须带 client-fingerprint，缺省时给一个 mihomo 认可的默认值
            if (!params.get('fp')) proxy['client-fingerprint'] = 'chrome';
        }

        // fingerprint
        if (params.get('fp')) {
            proxy['client-fingerprint'] = params.get('fp');
        }
    }

    // 传输层：只放行 mihomo 支持的几种，其余按 tcp 处理
    const rawNetwork = (params.get('type') || 'tcp').toLowerCase();
    const network = ['ws', 'grpc', 'h2', 'http'].includes(rawNetwork) ? rawNetwork : 'tcp';
    if (rawNetwork !== 'tcp' && network === 'tcp') {
        console.warn(`[ClashMeta] vless 节点「${name}」使用了不支持的传输方式 ${rawNetwork}，已按 tcp 处理`);
    }
    if (network !== 'tcp') {
        proxy.network = network;

        if (network === 'ws') {
            proxy['ws-opts'] = {
                path: params.get('path') || '/'
            };
            const wsHost = params.get('host');
            if (wsHost) {
                proxy['ws-opts'].headers = { Host: wsHost };
            }
        } else if (network === 'grpc') {
            proxy['grpc-opts'] = {
                'grpc-service-name': params.get('serviceName') || params.get('path') || ''
            };
        } else if (network === 'h2' || network === 'http') {
            proxy.network = 'h2';
            proxy['h2-opts'] = {
                path: params.get('path') || '/'
            };
            const h2Host = params.get('host');
            if (h2Host) {
                proxy['h2-opts'].host = h2Host.includes(',') ? h2Host.split(',') : [h2Host];
            }
        }
        // mihomo 的 h2 传输必须走 TLS
        if (proxy.network === 'h2') proxy.tls = true;
    }

    // Flow
    const flow = params.get('flow');
    if (flow) {
        proxy.flow = flow;
    }

    return proxy;
}

/**
 * 解析 VMess 链接
 */
function parseVmess(link) {
    // 用 b64ToUtf8：很多客户端导出的 vmess 链接没有 padding，裸 atob 会直接抛异常
    const jsonString = b64ToUtf8(link.substring('vmess://'.length));
    if (!jsonString) throw new Error('vmess 链接 base64 解码失败');
    const config = JSON.parse(jsonString);

    const proxy = {
        name: config.ps || config.add || 'VMess',
        type: 'vmess',
        server: cleanHost(config.add),
        port: parseInt(config.port),
        uuid: config.id,
        alterId: parseInt(config.aid) || 0,
        cipher: config.scy || 'auto',
        udp: true
    };

    // TLS
    if (config.tls === 'tls' || config.tls === true) {
        proxy.tls = true;
        if (config.sni) proxy.servername = config.sni;
        if (config.alpn) {
            proxy.alpn = Array.isArray(config.alpn) ? config.alpn : parseAlpn(config.alpn) || [config.alpn];
        }
        if (isTruthyFlag(config.skip_cert_verify) || isTruthyFlag(config['skip-cert-verify']) || config.skip_cert_verify === true || config['skip-cert-verify'] === true) {
            proxy['skip-cert-verify'] = true;
        }
    }

    // 传输层。
    // 注意：绝不能回退到 config.type —— 在 vmess 分享链接里 `type` 是 header 伪装类型
    // （例如 "none"/"http"），不是传输方式。之前把它当成 network 会生成 network: none
    // 这种 mihomo 无法识别的值。
    const rawNetwork = String(config.net || 'tcp').toLowerCase();
    const network = ['ws', 'grpc', 'h2', 'http'].includes(rawNetwork) ? rawNetwork : 'tcp';
    if (rawNetwork !== 'tcp' && network === 'tcp') {
        console.warn(`[ClashMeta] vmess 节点「${proxy.name}」使用了不支持的传输方式 ${rawNetwork}，已按 tcp 处理`);
    }
    if (network !== 'tcp') {
        proxy.network = network;

        if (network === 'ws') {
            proxy['ws-opts'] = {
                path: config.path || '/'
            };
            if (config.host) {
                proxy['ws-opts'].headers = { Host: config.host };
            }
        } else if (network === 'grpc') {
            proxy['grpc-opts'] = {
                'grpc-service-name': config.path || ''
            };
        } else if (network === 'h2' || network === 'http') {
            proxy.network = 'h2';
            proxy['h2-opts'] = {
                path: config.path || '/'
            };
            if (config.host) {
                const hosts = typeof config.host === 'string' 
                    ? config.host.split(',').map(h => h.trim())
                    : [config.host];
                proxy['h2-opts'].host = hosts;
            }
        }
    }

    return proxy;
}

/**
 * 解析 Shadowsocks 链接
 */
function parseShadowsocks(link) {
    // ss://method:password@server:port#name
    // 或 ss://base64(method:password)@server:port/?plugin=xxx#name
    
    let server, port, method, password, name;
    let pluginStr = '';

    // 提取 name (# 后面的部分)
    const hashIndex = link.indexOf('#');
    name = hashIndex !== -1 ? safeDecode(link.substring(hashIndex + 1)) : '';
    let linkWithoutName = hashIndex !== -1 ? link.substring(0, hashIndex) : link;

    // 提取查询参数。
    // 之前只找 '/?'，但 SIP002 允许直接写 '?'（`ss://...@host:port?plugin=...`），
    // 那种链接的 plugin/obfs 配置会被整段忽略，生成出来的节点连不上。
    const questionIndex = linkWithoutName.indexOf('?');
    if (questionIndex !== -1) {
        const queryString = linkWithoutName.substring(questionIndex + 1);
        linkWithoutName = linkWithoutName.substring(0, questionIndex).replace(/\/$/, '');
        const params = new URLSearchParams(queryString);
        pluginStr = safeDecode(params.get('plugin') || '');
    }

    // 移除 ss:// 前缀
    const mainPart = linkWithoutName.substring(5);
    // 用 lastIndexOf：密码里含 '@' 时（明文形式 ss://method:pa@ss@host:port 很常见）
    // 按第一个 '@' 切会把 server 解析成 "ss@host"、密码被截断，节点直接不可用。
    const atIndex = mainPart.lastIndexOf('@');

    if (atIndex !== -1) {
        // 格式: method:password@server:port 或 base64(method:password)@server:port
        const authPart = mainPart.substring(0, atIndex);
        const serverPart = mainPart.substring(atIndex + 1);

        // IPv6 形如 [::1]:8388，端口取最后一个冒号之后的部分
        const bracketEnd = serverPart.lastIndexOf(']');
        const colonIndex = serverPart.lastIndexOf(':');
        if (colonIndex > bracketEnd) {
            server = cleanHost(serverPart.substring(0, colonIndex));
            port = parseInt(serverPart.substring(colonIndex + 1));
        } else {
            server = cleanHost(serverPart);
            port = 0;
        }

        // 先尝试 base64（SIP002 用的是 base64url，必须先归一化再补 padding，
        // 否则 '-'/'_' 会让 atob 抛异常、method 变成空串，mihomo 会拒绝整份配置）
        const decoded = b64ToUtf8(authPart);
        if (decoded && decoded.includes(':')) {
            const decodedColonIndex = decoded.indexOf(':');
            method = decoded.substring(0, decodedColonIndex);
            password = decoded.substring(decodedColonIndex + 1);
        } else {
            // 明文 method:password
            const authColonIndex = authPart.indexOf(':');
            if (authColonIndex === -1) throw new Error('SS 链接缺少加密方式');
            method = safeDecode(authPart.substring(0, authColonIndex));
            password = safeDecode(authPart.substring(authColonIndex + 1));
        }
    } else {
        // 全部 base64 编码
        const decoded = b64ToUtf8(mainPart);
        if (!decoded) throw new Error('SS 链接 base64 解码失败');
        const parts = decoded.match(/^(.+?):(.*)@(.+):(\d+)$/);
        if (!parts) throw new Error('Invalid SS link format');

        method = parts[1];
        password = parts[2];
        server = cleanHost(parts[3]);
        port = parseInt(parts[4]);
    }

    if (!method) throw new Error('SS 链接缺少加密方式');
    if (!name) name = `${server}:${port}`;

    const proxy = {
        name,
        type: 'ss',
        server,
        port,
        cipher: method,
        password,
        udp: true
    };

    // 解析 plugin 参数
    if (pluginStr) {
        // plugin 格式: obfs-local;obfs=http;obfs-host=xxx
        // 或: v2ray-plugin;mode=websocket;tls;host=xxx
        const pluginParts = pluginStr.split(';');
        const pluginName = pluginParts[0];
        // 只在第一个 '=' 处切分：obfs-host / path 的值里可能含 '='
        const splitOnce = (part) => {
            const i = part.indexOf('=');
            return i === -1 ? [part, undefined] : [part.substring(0, i), part.substring(i + 1)];
        };

        if (pluginName.includes('obfs')) {
            // simple-obfs 插件
            proxy.plugin = 'obfs';
            proxy['plugin-opts'] = {};

            pluginParts.slice(1).forEach(part => {
                const [key, value] = splitOnce(part);
                if (key && value !== undefined) {
                    if (key === 'obfs') {
                        proxy['plugin-opts'].mode = value; // http 或 tls
                    } else if (key === 'obfs-host') {
                        proxy['plugin-opts'].host = value;
                    } else if (key === 'obfs-uri') {
                        proxy['plugin-opts'].path = value;
                    }
                }
            });
            // mihomo 要求 obfs 插件必须有 mode
            if (!proxy['plugin-opts'].mode) proxy['plugin-opts'].mode = 'http';
        } else if (pluginName.includes('v2ray')) {
            // v2ray-plugin 插件
            proxy.plugin = 'v2ray-plugin';
            proxy['plugin-opts'] = {};

            pluginParts.slice(1).forEach(part => {
                if (part === 'tls') {
                    proxy['plugin-opts'].tls = true;
                } else {
                    const [key, value] = splitOnce(part);
                    if (key && value !== undefined) {
                        if (key === 'mode') {
                            proxy['plugin-opts'].mode = value;
                        } else if (key === 'host') {
                            proxy['plugin-opts'].host = value;
                        } else if (key === 'path') {
                            proxy['plugin-opts'].path = value;
                        }
                    }
                }
            });
            if (!proxy['plugin-opts'].mode) proxy['plugin-opts'].mode = 'websocket';
        } else {
            console.warn(`[ClashMeta] SS 节点「${name}」使用了不支持的插件 ${pluginName}，已忽略插件配置`);
        }
    }

    return proxy;
}

/**
 * 解析 ShadowsocksR 链接
 */
function parseShadowsocksR(link) {
    // ssr://base64(server:port:protocol:method:obfs:base64pass/?obfsparam=base64&protoparam=base64&remarks=base64&group=base64)
    
    const base64Part = link.substring(6);
    // 统一走 b64ToUtf8：裸 atob 只产出 latin1，中文备注会变成乱码
    const decoded = b64ToUtf8(base64Part);
    if (!decoded) throw new Error('SSR 链接 base64 解码失败');

    const splitIndex = decoded.indexOf('/?');
    const mainPart = splitIndex === -1 ? decoded : decoded.substring(0, splitIndex);
    const queryPart = splitIndex === -1 ? '' : decoded.substring(splitIndex + 2);

    const parts = mainPart.split(':');
    if (parts.length < 6) throw new Error('SSR 链接格式不完整');
    const server = cleanHost(parts[0]);
    const port = parseInt(parts[1]);
    const protocol = parts[2];
    const method = parts[3];
    const obfs = parts[4];
    const passwordBase64 = parts[5];

    // 解码密码（同样需要 UTF-8 解码）
    const password = b64ToUtf8(passwordBase64) ?? passwordBase64;

    // 解析查询参数
    const params = new URLSearchParams(queryPart);
    let name = `${server}:${port}`;

    if (params.get('remarks')) {
        name = b64ToUtf8(params.get('remarks')) ?? params.get('remarks');
    }

    const proxy = {
        name,
        type: 'ssr',
        server,
        port,
        cipher: method,
        password,
        protocol,
        obfs,
        udp: true
    };

    if (params.get('obfsparam')) {
        proxy['obfs-param'] = b64ToUtf8(params.get('obfsparam')) ?? params.get('obfsparam');
    }

    if (params.get('protoparam')) {
        proxy['protocol-param'] = b64ToUtf8(params.get('protoparam')) ?? params.get('protoparam');
    }

    return proxy;
}

/**
 * 解析 AnyTLS 链接
 * anytls://password@server:port?sni=xxx&insecure=1#name
 * 之前完全没有这个分支：anytls:// 能通过聚合正则进入节点列表，
 * 但在直接生成 Clash Meta 模式下会被静默丢弃。
 */
function parseAnyTls(link) {
    const url = new URL(link.replace(/^anytls:\/\//i, 'https://'));
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 443;
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;
    // 密码可能写在 username 位（anytls://pw@host）或 user:pass 两段
    const password = safeDecode(url.password || url.username || '');
    const params = url.searchParams;

    const proxy = {
        name,
        type: 'anytls',
        server,
        port,
        password,
        udp: true
    };

    if (params.get('sni')) proxy.sni = params.get('sni');
    const alpn = parseAlpn(params.get('alpn'));
    if (alpn) proxy.alpn = alpn;
    if (params.get('fp')) proxy['client-fingerprint'] = params.get('fp');
    if (readInsecure(params)) proxy['skip-cert-verify'] = true;

    return proxy;
}

/**
 * 解析 SOCKS5 链接
 * socks5://user:pass@server:port#name
 * 同上：之前会被静默丢弃。
 */
function parseSocks5(link) {
    const url = new URL(link.replace(/^socks5:\/\//i, 'http://'));
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 1080;
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;
    const params = url.searchParams;

    const proxy = {
        name,
        type: 'socks5',
        server,
        port,
        udp: true
    };

    if (url.username) proxy.username = safeDecode(url.username);
    if (url.password) proxy.password = safeDecode(url.password);
    if (isTruthyFlag(params.get('tls'))) proxy.tls = true;
    if (readInsecure(params)) proxy['skip-cert-verify'] = true;

    return proxy;
}

/**
 * 解析 Hysteria2 链接
 */
function parseHysteria2(link) {
    const url = new URL(link.replace(/^hy2:\/\//i, 'hysteria2://'));
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 443;
    // hysteria2 的认证串本身可以含 ':'（形如 user:pass）。
    // 之前只取 url.username，冒号后半段被丢掉，认证必然失败。
    const password = url.password
        ? `${safeDecode(url.username)}:${safeDecode(url.password)}`
        : safeDecode(url.username || '');
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;

    const proxy = {
        name,
        type: 'hysteria2',
        server,
        port,
        password,
        udp: true
    };

    const params = url.searchParams;

    if (params.get('sni')) proxy.sni = params.get('sni');
    if (params.get('obfs')) proxy.obfs = params.get('obfs');
    const obfsPassword = params.get('obfs-password') || params.get('obfs_password');
    if (obfsPassword) proxy['obfs-password'] = obfsPassword;
    const alpn = parseAlpn(params.get('alpn'));
    if (alpn) proxy.alpn = alpn;
    if (params.get('up') || params.get('upmbps')) proxy.up = params.get('up') || params.get('upmbps');
    if (params.get('down') || params.get('downmbps')) proxy.down = params.get('down') || params.get('downmbps');
    // 之前只认 insecure=1，写 insecure=true 的链接会因证书校验失败而连不上
    if (readInsecure(params)) proxy['skip-cert-verify'] = true;

    return proxy;
}

/**
 * 解析 Hysteria 链接
 */
function parseHysteria(link) {
    const url = new URL(link.replace(/^hy:\/\//i, 'hysteria://'));
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 443;
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;

    const params = url.searchParams;

    const proxy = {
        name,
        type: 'hysteria',
        server,
        port,
        udp: true
    };

    // mihomo 的字段名是 auth-str（不是 auth_str）
    const auth = params.get('auth') || params.get('auth-str') || params.get('auth_str');
    if (auth) proxy['auth-str'] = auth;
    if (params.get('peer') || params.get('sni')) proxy.sni = params.get('peer') || params.get('sni');
    if (readInsecure(params)) proxy['skip-cert-verify'] = true;
    // hysteria v1 必填带宽字段，缺省时给一个合理默认值，否则 mihomo 会拒绝该节点
    proxy.up = params.get('up') || params.get('upmbps') || '50';
    proxy.down = params.get('down') || params.get('downmbps') || '200';
    if (params.get('protocol')) proxy.protocol = params.get('protocol');
    const alpn = parseAlpn(params.get('alpn'));
    if (alpn) proxy.alpn = alpn;
    // hysteria v1 里 obfs 参数的语义和 hysteria2 不同：
    // 分享链接的 obfs= 是「混淆协议名」，混淆口令写在 obfsParam=。
    // 之前把 obfs= 直接塞进 proxy.obfs（mihomo 视为混淆口令），并且完全丢掉了 obfsParam。
    const obfsParam = params.get('obfsParam') || params.get('obfsparam');
    if (obfsParam) {
        proxy.obfs = obfsParam;
        const obfsProtocol = params.get('obfs');
        if (obfsProtocol) proxy['obfs-protocol'] = obfsProtocol;
    } else if (params.get('obfs')) {
        proxy.obfs = params.get('obfs');
    }

    return proxy;
}

/**
 * 解析 TUIC 链接
 */
function parseTuic(link) {
    // tuic://uuid:password@server:port?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=example.com#name
    const url = new URL(link);
    const server = cleanHost(url.hostname);
    const port = parseInt(url.port) || 443;
    const name = url.hash ? safeDecode(url.hash.substring(1)) : `${server}:${port}`;

    // 解析 uuid 和 password
    // TUIC v5: tuic://uuid:password@server:port
    // TUIC v4: tuic://token@server:port     ← 没有 password 段，且 token 不是 UUID
    const userPart = url.username ? safeDecode(url.username) : '';
    const password = url.password ? safeDecode(url.password) : '';

    const params = url.searchParams;

    const proxy = {
        name,
        type: 'tuic',
        server,
        port,
        udp: true
    };

    const isUuidShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userPart);
    if (password || isUuidShaped) {
        // v5：uuid + password
        proxy.uuid = userPart;
        if (password) proxy.password = password;
    } else if (userPart) {
        // v4：整段是 token。之前无条件写进 uuid，mihomo 会因为 uuid 不合法而拒绝该节点。
        proxy.token = userPart;
    }

    // 可选参数
    if (params.get('congestion_control') || params.get('congestion-control')) {
        proxy['congestion-controller'] = params.get('congestion_control') || params.get('congestion-control');
    }
    
    if (params.get('udp_relay_mode') || params.get('udp-relay-mode')) {
        proxy['udp-relay-mode'] = params.get('udp_relay_mode') || params.get('udp-relay-mode');
    }
    
    const alpn = parseAlpn(params.get('alpn'));
    if (alpn) proxy.alpn = alpn;

    if (params.get('sni')) {
        proxy.sni = params.get('sni');
    }

    if (isTruthyFlag(params.get('disable_sni')) || isTruthyFlag(params.get('disable-sni'))) {
        proxy['disable-sni'] = true;
    }

    if (readInsecure(params)) {
        proxy['skip-cert-verify'] = true;
    }

    // TUIC v5 特有参数
    if (isTruthyFlag(params.get('reduce_rtt')) || isTruthyFlag(params.get('reduce-rtt'))) {
        proxy['reduce-rtt'] = true;
    }

    return proxy;
}

/**
 * 获取默认的 Clash Meta 配置模板
 * 基于你提供的 Gist 配置结构
 */
function getDefaultClashMetaConfig() {
    return {
        'mixed-port': 7890,
        'allow-lan': true,
        'bind-address': '*',
        'mode': 'rule',
        'log-level': 'info',
        'ipv6': true,
        'external-controller': '127.0.0.1:9090',
        'external-ui': 'ui',
        'external-ui-url': 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip',
        
        'geodata-mode': true,
        'geox-url': {
            'geoip': 'https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat',
            'geosite': 'https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
            'mmdb': 'https://mirror.ghproxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country-lite.mmdb',
            'asn': 'https://mirror.ghproxy.com/https://github.com/xishang0128/geoip/releases/download/latest/GeoLite2-ASN.mmdb'
        },
        
        'profile': {
            'store-selected': true,
            'store-fake-ip': true
        },

        'sniffer': {
            enable: true,
            'force-dns-mapping': true,
            'parse-pure-ip': true,
            sniff: {
                HTTP: {
                    ports: [80, '8080-8880'],
                    'override-destination': true
                },
                TLS: {
                    ports: [443, 8443]
                },
                QUIC: {
                    ports: [443, 8443]
                }
            }
        },

        'dns': {
            enable: true,
            'prefer-h3': true,
            listen: '0.0.0.0:1053',
            ipv6: true,
            'enhanced-mode': 'fake-ip',
            'fake-ip-range': '198.18.0.1/16',
            'fake-ip-filter': [
                '*.lan',
                '*.localdomain',
                '*.example',
                '*.invalid',
                '*.localhost',
                '*.test',
                '*.local',
                '*.home.arpa',
                '+.msftconnecttest.com',
                '+.msftncsi.com',
                'localhost.ptlogin2.qq.com',
                '+.srv.nintendo.net',
                '+.stun.playstation.net',
                'xbox.*.microsoft.com',
                '+.xboxlive.com',
                'stun.*',
                'global.turn.twilio.com',
                'global.stun.twilio.com',
                '+.qq.com',
                '+.music.163.com',
                '*.music.126.net'
            ],
            'default-nameserver': [
                '223.5.5.5',
                '119.29.29.29',
                'system'
            ],
            nameserver: [
                'https://doh.pub/dns-query',
                'https://dns.alidns.com/dns-query'
            ],
            'nameserver-policy': {
                'geosite:cn,private': [
                    'https://doh.pub/dns-query',
                    'https://dns.alidns.com/dns-query'
                ]
            }
        },

        proxies: [],

        'proxy-groups': [
            {
                name: 'Proxies',
                type: 'select',
                proxies: ['__AUTO_INSERT_NODES__', '直连']
            },
            {
                name: '备用',
                type: 'select',
                proxies: ['__AUTO_INSERT_NODES__']
            },
            {
                name: 'AI平台',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            },
            {
                name: 'Microsoft',
                type: 'select',
                proxies: ['直连', 'Proxies', '备用']
            },
            {
                name: 'Apple',
                type: 'select',
                proxies: ['直连', 'Proxies', '备用']
            },
            {
                name: 'Google',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            },
            {
                name: 'Tiktok',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            },
            {
                name: '流媒体',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            },
            {
                name: 'Steam',
                type: 'select',
                proxies: ['Proxies', '直连', '备用']
            },
            {
                name: 'Crypto',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            },
            {
                name: '领英',
                type: 'select',
                proxies: ['Proxies', '直连', '备用']
            },
            {
                name: '工作学习',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            },
            {
                name: '去广告',
                type: 'select',
                proxies: ['REJECT', '直连', 'Proxies']
            },
            {
                name: '直连',
                type: 'select',
                proxies: ['DIRECT']
            },
            {
                name: 'Final',
                type: 'select',
                proxies: ['Proxies', '备用', '直连']
            }
        ],

        rules: [
            // 局域网
            'DOMAIN-SUFFIX,local,直连',
            'DOMAIN-SUFFIX,localhost,直连',
            'DOMAIN-SUFFIX,lan,直连',
            'DOMAIN-SUFFIX,home.arpa,直连',
            'IP-CIDR,127.0.0.0/8,直连,no-resolve',
            'IP-CIDR,10.0.0.0/8,直连,no-resolve',
            'IP-CIDR,172.16.0.0/12,直连,no-resolve',
            'IP-CIDR,192.168.0.0/16,直连,no-resolve',
            'IP-CIDR,fe80::/10,直连,no-resolve',

            // 去广告
            'GEOSITE,category-ads-all,去广告',

            // AI 平台
            'GEOSITE,category-ai-chat-!cn,AI平台',

            // 工作学习
            'GEOSITE,github,工作学习',
            'GEOSITE,microsoft-dev,工作学习',
            'GEOSITE,onedrive,工作学习',
            'GEOSITE,xbox,工作学习',
            'DOMAIN-SUFFIX,yammer.com,工作学习',
            'DOMAIN-SUFFIX,kickstarter.com,工作学习',
            'DOMAIN-SUFFIX,metacdn.com,工作学习',

            // 流媒体
            'GEOSITE,netflix,流媒体',
            'DOMAIN-SUFFIX,cf.imetyou.top,流媒体',

            // 厂商/平台
            'GEOSITE,microsoft,Microsoft',
            'GEOSITE,apple,Apple',
            'GEOSITE,google,Google',
            'GEOSITE,tiktok,Tiktok',

            // 游戏
            'GEOSITE,steam,Steam',
            'DOMAIN-SUFFIX,linkedin.com,领英',
            'GEOSITE,category-cryptocurrency,Crypto',
            'DOMAIN-SUFFIX,four.meme,Crypto',

            // 国内直连
            'GEOSITE,cn,直连',
            'GEOIP,CN,直连',

            // 兜底
            'MATCH,Final'
        ]
    };
}

