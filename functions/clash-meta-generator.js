/**
 * Clash Meta YAML 配置生成器
 * 直接生成适配 Clash Meta 内核的配置，无需 subconverter
 */

import yaml from 'js-yaml';

/**
 * 将节点链接数组转换为 Clash Meta 代理对象数组
 */
export async function convertLinksToClashProxies(nodeLinks) {
    const proxies = [];
    const nameCountMap = new Map(); // 用于处理重名节点

    for (const link of nodeLinks) {
        const trimmed = link.trim();
        if (!trimmed) continue;

        try {
            let proxy = null;

            if (trimmed.startsWith('vmess://')) {
                proxy = parseVmess(trimmed);
            } else if (trimmed.startsWith('vless://')) {
                proxy = parseVless(trimmed);
            } else if (trimmed.startsWith('trojan://')) {
                proxy = parseTrojan(trimmed);
            } else if (trimmed.startsWith('ss://')) {
                proxy = parseShadowsocks(trimmed);
            } else if (trimmed.startsWith('ssr://')) {
                proxy = parseShadowsocksR(trimmed);
            } else if (trimmed.startsWith('hysteria2://') || trimmed.startsWith('hy2://')) {
                proxy = parseHysteria2(trimmed);
            } else if (trimmed.startsWith('hysteria://') || trimmed.startsWith('hy://')) {
                proxy = parseHysteria(trimmed);
            }

            if (proxy) {
                // 处理重名节点：在名称后添加序号
                const baseName = proxy.name;
                const count = nameCountMap.get(baseName) || 0;
                if (count > 0) {
                    proxy.name = `${baseName} [${count + 1}]`;
                }
                nameCountMap.set(baseName, count + 1);

                proxies.push(proxy);
            }
        } catch (error) {
            console.error(`Failed to parse proxy link: ${trimmed.substring(0, 50)}...`, error);
        }
    }

    return proxies;
}

/**
 * 生成完整的 Clash Meta YAML 配置
 */
export async function generateClashMetaYAML(nodeLinks, templateConfig, settings = {}) {
    try {
        // 1. 转换节点
        const proxies = await convertLinksToClashProxies(nodeLinks);
        
        if (proxies.length === 0) {
            throw new Error('没有有效的代理节点');
        }

        // 2. 获取所有节点名称
        const proxyNames = proxies.map(p => p.name);

        // 3. 构建基础配置（使用模板或默认配置）
        const config = templateConfig || getDefaultClashMetaConfig();

        // 4. 设置代理列表
        config.proxies = proxies;

        // 5. 自动插入节点到代理组
        if (config['proxy-groups']) {
            config['proxy-groups'].forEach(group => {
                if (group.proxies) {
                    // 替换占位符或自动插入
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
            });
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
    const password = decodeURIComponent(url.username);
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const name = url.hash ? decodeURIComponent(url.hash.substring(1)) : `${server}:${port}`;

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
    if (params.get('alpn')) {
        const alpn = params.get('alpn');
        proxy.alpn = alpn.includes(',') ? alpn.split(',') : [alpn];
    }
    if (params.get('allowInsecure') === '1' || params.get('allowinsecure') === '1') {
        proxy['skip-cert-verify'] = true;
    }

    // 解析传输层
    const network = params.get('type') || params.get('network');
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
    }

    return proxy;
}

/**
 * 解析 VLESS 链接
 */
function parseVless(link) {
    const url = new URL(link);
    const uuid = decodeURIComponent(url.username);
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const name = url.hash ? decodeURIComponent(url.hash.substring(1)) : `${server}:${port}`;

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
    const security = params.get('security') || params.get('encryption');
    if (security === 'tls' || security === 'reality') {
        proxy.tls = true;
        
        if (params.get('sni')) proxy.servername = params.get('sni');
        if (params.get('alpn')) {
            const alpn = params.get('alpn');
            proxy.alpn = alpn.includes(',') ? alpn.split(',') : [alpn];
        }
        if (params.get('allowInsecure') === '1') {
            proxy['skip-cert-verify'] = true;
        }

        // Reality
        if (security === 'reality') {
            proxy['reality-opts'] = {};
            if (params.get('pbk')) proxy['reality-opts']['public-key'] = params.get('pbk');
            if (params.get('sid')) proxy['reality-opts']['short-id'] = params.get('sid');
        }

        // fingerprint
        if (params.get('fp')) {
            proxy['client-fingerprint'] = params.get('fp');
        }
    }

    // 传输层
    const network = params.get('type') || 'tcp';
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
    const base64Part = link.substring('vmess://'.length);
    const binaryString = atob(base64Part);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const jsonString = new TextDecoder('utf-8').decode(bytes);
    const config = JSON.parse(jsonString);

    const proxy = {
        name: config.ps || config.add || 'VMess',
        type: 'vmess',
        server: config.add,
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
            proxy.alpn = Array.isArray(config.alpn) ? config.alpn : [config.alpn];
        }
        if (config.skip_cert_verify || config['skip-cert-verify']) {
            proxy['skip-cert-verify'] = true;
        }
    }

    // 传输层
    const network = config.net || config.type || 'tcp';
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
    // 或 ss://base64(method:password)@server:port#name
    
    let server, port, method, password, name;
    
    const hashIndex = link.indexOf('#');
    name = hashIndex !== -1 ? decodeURIComponent(link.substring(hashIndex + 1)) : '';
    const mainPart = hashIndex !== -1 ? link.substring(5, hashIndex) : link.substring(5);
    
    const atIndex = mainPart.indexOf('@');
    
    if (atIndex !== -1) {
        // 格式: method:password@server:port 或 base64@server:port
        const authPart = mainPart.substring(0, atIndex);
        const serverPart = mainPart.substring(atIndex + 1);
        
        const colonIndex = serverPart.lastIndexOf(':');
        server = serverPart.substring(0, colonIndex);
        port = parseInt(serverPart.substring(colonIndex + 1));
        
        // 尝试 base64 解码
        try {
            const decoded = atob(authPart);
            const decodedColonIndex = decoded.indexOf(':');
            method = decoded.substring(0, decodedColonIndex);
            password = decoded.substring(decodedColonIndex + 1);
        } catch {
            // 如果不是 base64，直接解析
            const authColonIndex = authPart.indexOf(':');
            method = authPart.substring(0, authColonIndex);
            password = decodeURIComponent(authPart.substring(authColonIndex + 1));
        }
    } else {
        // 全部 base64 编码
        const decoded = atob(mainPart);
        const parts = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
        if (!parts) throw new Error('Invalid SS link format');
        
        method = parts[1];
        password = parts[2];
        server = parts[3];
        port = parseInt(parts[4]);
    }
    
    if (!name) name = `${server}:${port}`;

    return {
        name,
        type: 'ss',
        server,
        port,
        cipher: method,
        password,
        udp: true
    };
}

/**
 * 解析 ShadowsocksR 链接
 */
function parseShadowsocksR(link) {
    // ssr://base64(server:port:protocol:method:obfs:base64pass/?obfsparam=base64&protoparam=base64&remarks=base64&group=base64)
    
    const base64Part = link.substring(6);
    let decoded;
    try {
        decoded = atob(base64Part);
    } catch {
        // 处理 padding
        const padded = base64Part + '='.repeat((4 - base64Part.length % 4) % 4);
        decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    }
    
    const mainPart = decoded.split('/?')[0];
    const queryPart = decoded.split('/?')[1] || '';
    
    const parts = mainPart.split(':');
    const server = parts[0];
    const port = parseInt(parts[1]);
    const protocol = parts[2];
    const method = parts[3];
    const obfs = parts[4];
    const passwordBase64 = parts[5];
    
    // 解码密码
    let password;
    try {
        password = atob(passwordBase64.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
        password = passwordBase64;
    }
    
    // 解析查询参数
    const params = new URLSearchParams(queryPart);
    let name = `${server}:${port}`;
    
    if (params.get('remarks')) {
        try {
            name = atob(params.get('remarks').replace(/-/g, '+').replace(/_/g, '/'));
        } catch {
            name = params.get('remarks');
        }
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
        try {
            proxy['obfs-param'] = atob(params.get('obfsparam').replace(/-/g, '+').replace(/_/g, '/'));
        } catch {
            proxy['obfs-param'] = params.get('obfsparam');
        }
    }
    
    if (params.get('protoparam')) {
        try {
            proxy['protocol-param'] = atob(params.get('protoparam').replace(/-/g, '+').replace(/_/g, '/'));
        } catch {
            proxy['protocol-param'] = params.get('protoparam');
        }
    }

    return proxy;
}

/**
 * 解析 Hysteria2 链接
 */
function parseHysteria2(link) {
    const url = new URL(link.replace('hy2://', 'hysteria2://'));
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const password = url.username ? decodeURIComponent(url.username) : '';
    const name = url.hash ? decodeURIComponent(url.hash.substring(1)) : `${server}:${port}`;

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
    if (params.get('obfs-password')) proxy['obfs-password'] = params.get('obfs-password');
    if (params.get('insecure') === '1') proxy['skip-cert-verify'] = true;

    return proxy;
}

/**
 * 解析 Hysteria 链接
 */
function parseHysteria(link) {
    const url = new URL(link.replace('hy://', 'hysteria://'));
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const name = url.hash ? decodeURIComponent(url.hash.substring(1)) : `${server}:${port}`;

    const params = url.searchParams;

    const proxy = {
        name,
        type: 'hysteria',
        server,
        port,
        udp: true
    };

    if (params.get('auth')) proxy.auth_str = params.get('auth');
    if (params.get('peer')) proxy.sni = params.get('peer');
    if (params.get('insecure') === '1') proxy['skip-cert-verify'] = true;
    if (params.get('upmbps')) proxy.up = params.get('upmbps');
    if (params.get('downmbps')) proxy.down = params.get('downmbps');
    if (params.get('obfs')) proxy.obfs = params.get('obfs');

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

