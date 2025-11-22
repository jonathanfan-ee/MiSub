# Clash Meta 直接生成模式使用指南

## 📖 概述

MiSub 现在支持**直接生成 Clash Meta YAML 配置**，无需依赖 subconverter 后端。这对于 Clash Meta 内核用户来说有以下优势：

✅ **更好的兼容性** - 完整支持 Clash Meta 的所有新特性  
✅ **更快的响应** - 无需第三方服务转换  
✅ **完全控制** - 使用自己的配置模板  
✅ **无依赖** - 不受 subconverter 服务可用性影响  

## 🚀 快速开始

### 第一步：启用直接生成模式

1. 登录 MiSub 管理界面
2. 进入"设置"页面
3. 找到以下选项并配置：

```yaml
启用 Clash Meta 直接生成模式: ☑️ 开启
Clash Meta 模板 URL: (留空使用默认模板，或填入你的模板地址)
自动插入节点到选择组: ☑️ 开启
```

4. 点击"保存设置"

### 第二步：配置你的模板

有两种方式使用配置模板：

#### 方式一：使用内置默认模板（推荐新手）

直接留空"Clash Meta 模板 URL"，系统会使用内置的优化模板，包含：
- 完整的 DNS 配置（DoH、Fake-IP）
- 流量嗅探
- 分流规则（AI、流媒体、工作学习等）
- 去广告

#### 方式二：使用自定义模板（推荐进阶用户）

1. 将项目中的 `clash-meta-template.yaml` 上传到 GitHub Gist 或其他托管服务
2. 获取原始文件 URL
3. 在设置中填入这个 URL

**模板 URL 示例：**
```
https://gist.githubusercontent.com/你的用户名/gist-id/raw/clash-meta-template.yaml
```

### 第三步：获取订阅

订阅链接格式保持不变，系统会自动识别并使用直接生成模式：

```
https://你的域名/你的token
https://你的域名/profiles/你的profile-id
```

## 📝 自定义模板

### 模板结构

你的 YAML 模板应该包含以下部分：

```yaml
# 基础配置
mixed-port: 7890
mode: rule
# ... 其他基础配置

# DNS 配置
dns:
  enable: true
  # ... DNS 设置

# 代理节点（留空，会自动填充）
proxies: []

# 代理组
proxy-groups:
  - name: Proxies
    type: select
    proxies:
      # 节点会自动插入到这里
      - 直连

# 分流规则
rules:
  - GEOSITE,cn,直连
  - MATCH,Proxies
```

### 节点自动插入

系统会自动将聚合的节点插入到代理组中。有两种方式：

#### 1. 使用占位符（精确控制）

在你想插入节点的位置使用 `__AUTO_INSERT_NODES__` 占位符：

```yaml
proxy-groups:
  - name: 自动选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies:
      - __AUTO_INSERT_NODES__  # 所有节点会插入到这里
```

#### 2. 自动插入到 select 组（推荐）

如果启用了"自动插入节点到选择组"，系统会自动将节点追加到所有 `type: select` 的代理组中：

```yaml
proxy-groups:
  - name: Proxies
    type: select
    proxies:
      - 直连
      # 节点会自动追加到这里
```

### 完整示例模板

参考项目中的 `clash-meta-template.yaml` 文件，它包含：

- ✅ 完整的 Clash Meta 配置
- ✅ 优化的 DNS 设置（支持分流）
- ✅ 流量嗅探配置
- ✅ 完整的分流规则（基于你的 INI 规则转换）
- ✅ 代理组设置
- ✅ GEO 数据源配置

## 🔧 配置选项说明

### 在 MiSub 设置中

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `useDirectClashMeta` | 是否启用直接生成模式 | `false` |
| `clashMetaTemplateUrl` | 自定义模板的 URL 地址 | 空（使用内置模板）|
| `autoInsertToSelect` | 是否自动将节点插入到 select 类型的代理组 | `true` |

### 在 Profile 设置中

每个 Profile 可以单独配置是否使用直接生成模式，这样可以：
- 部分订阅使用 subconverter
- 部分订阅直接生成 Clash Meta 配置

## ❓ 常见问题

### Q1: 是否还需要配置 subConverter 地址？

如果启用了直接生成模式，访问 Clash 订阅时会跳过 subconverter，直接返回 YAML 配置。但建议保留配置作为降级方案。

### Q2: 如何判断是否使用了直接生成模式？

可以通过以下方式验证：

1. **查看响应速度** - 直接生成模式响应更快
2. **使用调试模式** - 访问订阅时添加 `?__debug` 参数：
   ```
   https://你的域名/你的token?__debug
   ```
   输出中会显示 `Direct Clash Meta Mode: ON`

### Q3: 节点没有正确插入到代理组？

检查以下几点：
1. 确认启用了"自动插入节点到选择组"
2. 在模板中使用 `__AUTO_INSERT_NODES__` 占位符
3. 确认节点成功聚合（使用调试模式查看）

### Q4: 模板无法加载？

- 检查模板 URL 是否可访问
- 确认 URL 返回的是纯文本 YAML 格式
- 如果使用 GitHub Gist，确保使用 Raw 链接
- 模板加载失败时，系统会自动使用内置默认模板

### Q5: Base64 订阅还能用吗？

可以！Base64 订阅不受影响，系统会自动识别：
- Clash Meta 客户端 → 直接生成 YAML
- 其他客户端请求 Base64 → 返回 Base64 编码的节点列表

### Q6: 还需要拦截 QUIC 吗？

**不需要！** Clash Meta 已完整支持 QUIC/UDP 转发，拦截反而会：
- 降低性能（HTTP/3 降级到 HTTP/2）
- 影响 YouTube、Google 等服务体验
- 不符合现代网络使用习惯

项目中的默认模板已经移除了 QUIC 拦截规则。

## 🎯 最佳实践

### 1. 模板管理

- 将模板托管在 GitHub Gist 或 GitHub 仓库
- 使用版本控制管理模板变更
- 定期更新 GEO 数据源地址

### 2. 规则优化

- 高频规则放在前面（如局域网、去广告）
- 使用 `no-resolve` 提升性能
- 合理使用 `GEOSITE` 和 `GEOIP` 规则

### 3. DNS 配置

- 国内网站使用国内 DNS（如 DoH.pub、AliDNS）
- 保留 `fake-ip-filter` 确保特殊服务正常工作
- 启用 IPv6（如果你的网络支持）

### 4. 代理组设置

```yaml
# 推荐的代理组结构
proxy-groups:
  # 主选择组
  - name: Proxies
    type: select
    proxies:
      - 自动选择
      - 直连
  
  # 自动测速组
  - name: 自动选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
      - __AUTO_INSERT_NODES__
  
  # 负载均衡组（可选）
  - name: 负载均衡
    type: load-balance
    url: http://www.gstatic.com/generate_204
    interval: 300
    strategy: consistent-hashing
    proxies:
      - __AUTO_INSERT_NODES__
```

## 📚 参考资源

- [Clash Meta 官方文档](https://wiki.metacubex.one)
- [参考配置 (liuran001)](https://gist.github.com/liuran001/5ca84f7def53c70b554d3f765ff86a33)
- [Meta Rules DAT (GEO 数据源)](https://github.com/MetaCubeX/meta-rules-dat)

## 🔄 从 subconverter 迁移

如果你之前使用 subconverter，迁移步骤：

1. ✅ 保存你现有的 subconverter 配置规则
2. ✅ 将规则转换为 Clash Meta YAML 格式（参考本项目的模板）
3. ✅ 在 MiSub 设置中启用直接生成模式
4. ✅ 测试订阅是否正常工作
5. ✅ 根据需要调整模板配置

## 💡 技术原理

直接生成模式的工作流程：

```
用户请求订阅
    ↓
MiSub 聚合节点
    ↓
检测到直接生成模式已启用
    ↓
获取 YAML 模板（URL 或内置）
    ↓
解析节点链接为 Clash Meta 代理对象
    ↓
将节点插入到代理组
    ↓
生成完整的 YAML 配置
    ↓
直接返回给客户端
```

对比 subconverter 模式：

```
用户请求订阅
    ↓
MiSub 聚合节点
    ↓
生成回调 URL
    ↓
请求 subconverter
    ↓
subconverter 回调获取节点
    ↓
subconverter 应用配置规则
    ↓
返回 YAML 配置
```

直接模式少了两次网络往返，响应更快！

## 🤝 贡献

如果你有更好的模板或规则配置，欢迎分享！

