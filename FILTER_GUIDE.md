# 节点筛选功能使用指南

## 🎯 功能说明

现在支持在代理组中使用 `filter` 字段来筛选节点，无需依赖 proxy-providers！

## 📝 使用方法

### 基本语法

在模板的 `proxy-groups` 中添加 `filter` 字段：

```yaml
proxy-groups:
  - name: 香港节点
    type: select
    filter: "(?i)香港|HK|Hong"  # 正则表达式筛选
    proxies:
      - __AUTO_INSERT_NODES__  # 筛选后的节点插入到这里
      - 直连
```

### 工作原理

1. 生成器读取 `filter` 字段的正则表达式
2. 用正则匹配所有节点名称
3. 将匹配的节点插入到 `__AUTO_INSERT_NODES__` 位置
4. 删除 `filter` 字段（因为 Clash Meta 不认识这个字段）
5. 生成最终的 YAML 配置

## 📋 实际示例

### 示例 1：按关键词筛选

```yaml
# 只包含名称含"自建"的节点
- name: Proxies
  type: select
  filter: "自建"
  proxies:
    - __AUTO_INSERT_NODES__
    - 直连
```

生成后：
```yaml
- name: Proxies
  type: select
  proxies:
    - 自建-香港-01
    - 自建-新加坡-01
    - 自建-日本-01
    - 直连
```

### 示例 2：按地区筛选

```yaml
# 筛选所有香港节点
- name: 香港节点
  type: url-test
  filter: "(?i)香港|HK|Hong"  # 不区分大小写
  url: http://www.gstatic.com/generate_204
  interval: 300
  proxies:
    - __AUTO_INSERT_NODES__
```

生成后会包含所有名称含 "香港"、"HK"、"Hong" 的节点（不区分大小写）。

### 示例 3：按订阅源筛选

```yaml
# 只包含名称含"备用"的节点（假设机场订阅名为"备用"）
- name: 备用
  type: select
  filter: "备用"
  proxies:
    - __AUTO_INSERT_NODES__
```

### 示例 4：包含所有节点（不筛选）

```yaml
# 不使用 filter 字段，包含所有节点
- name: 所有节点
  type: select
  proxies:
    - __AUTO_INSERT_NODES__
    - 直连
```

### 示例 5：排除某些节点

```yaml
# 排除"过期"或"已满"的节点
- name: 可用节点
  type: select
  filter: "^(?!.*(过期|已满|expire)).*$"  # 负向前瞻
  proxies:
    - __AUTO_INSERT_NODES__
```

## 🎨 正则表达式速查

| 模式 | 说明 | 示例 |
|------|------|------|
| `香港` | 精确匹配"香港" | 匹配：香港节点、备用香港 |
| `(?i)hk` | 不区分大小写的"hk" | 匹配：HK、hk、Hk |
| `香港\|HK` | 匹配"香港"或"HK" | 匹配：香港节点、HK-01 |
| `^香港` | 以"香港"开头 | 匹配：香港-01，不匹配：备用香港 |
| `香港$` | 以"香港"结尾 | 匹配：备用香港，不匹配：香港-01 |
| `.*` | 匹配所有 | 匹配所有节点 |
| `\d+` | 匹配数字 | 匹配：节点01、节点02 |
| `^(?!.*过期)` | 不包含"过期" | 排除所有含"过期"的节点 |

## 📌 你的配置对应关系

### 原 INI 配置 → 新 YAML 配置

#### 1. Proxies 组
**INI:**
```ini
custom_proxy_group=Proxies select (自建) []备用 []直连
```

**YAML:**
```yaml
- name: Proxies
  type: select
  filter: "自建"  # 筛选包含"自建"的节点
  proxies:
    - 备用
    - __AUTO_INSERT_NODES__  # 筛选后的节点
    - 直连
```

#### 2. 备用组
**INI:**
```ini
custom_proxy_group=备用 select 备用
```

**YAML:**
```yaml
- name: 备用
  type: select
  filter: "备用"  # 筛选包含"备用"的节点
  proxies:
    - __AUTO_INSERT_NODES__
```

#### 3. 其他组（包含所有节点）
**INI:**
```ini
custom_proxy_group=AI平台 select []Proxies []备用 .* []直连
```

**YAML:**
```yaml
- name: AI平台
  type: select
  # 不使用 filter，包含所有节点
  proxies:
    - Proxies
    - 备用
    - __AUTO_INSERT_NODES__  # 所有节点
    - 直连
```

## 🔧 高级用法

### 多条件筛选

```yaml
# 筛选香港或新加坡的高级节点
- name: 高级节点
  type: select
  filter: "(?i)(香港|新加坡|HK|SG).*(高级|Premium)"
  proxies:
    - __AUTO_INSERT_NODES__
```

### 按速度分组

```yaml
# 创建自动测速组，只包含特定地区
- name: 亚洲优选
  type: url-test
  filter: "(?i)香港|台湾|日本|新加坡|HK|TW|JP|SG"
  url: http://www.gstatic.com/generate_204
  interval: 300
  tolerance: 50
  proxies:
    - __AUTO_INSERT_NODES__
```

### 负载均衡

```yaml
# 负载均衡，使用所有可用节点
- name: 负载均衡
  type: load-balance
  strategy: consistent-hashing
  url: http://www.gstatic.com/generate_204
  interval: 300
  proxies:
    - __AUTO_INSERT_NODES__  # 不用 filter，包含所有节点
```

## 🚨 注意事项

### 1. Filter 字段的位置
`filter` 字段必须和 `proxies` 字段在同一个代理组中。

### 2. 大小写敏感
默认情况下，正则表达式是大小写敏感的。要不区分大小写，使用 `(?i)` 标志：
```yaml
filter: "(?i)香港|hk"  # 匹配：香港、HK、hk、Hk
```

### 3. 特殊字符转义
如果节点名包含特殊字符（如 `.`, `(`, `)`, `[`, `]`），需要转义：
```yaml
filter: "节点\\(1\\)"  # 匹配：节点(1)
```

### 4. Filter 优先级
- 如果设置了 `filter`，只有匹配的节点会被插入
- 如果没有设置 `filter`，所有节点都会被插入
- `filter` 字段在生成后会被删除，不会出现在最终配置中

### 5. 测试你的正则
可以使用在线工具测试正则表达式：
- https://regex101.com/
- 选择 "ECMAScript (JavaScript)" 模式
- 输入你的节点名称测试匹配

## 📊 实际效果

### 生成前（模板）
```yaml
proxy-groups:
  - name: Proxies
    type: select
    filter: "自建"
    proxies:
      - __AUTO_INSERT_NODES__
      - 直连
```

### 生成后（最终配置）
```yaml
proxy-groups:
  - name: Proxies
    type: select
    proxies:
      - 自建-香港-IPLC
      - 自建-新加坡-BGP
      - 自建-日本-CN2
      - 直连
```

## 💡 最佳实践

1. **命名规范**：给节点使用清晰的命名规则
   - ✅ `自建-香港-01`
   - ✅ `备用-新加坡-A`
   - ❌ `节点1`、`节点2`

2. **订阅前缀**：在 MiSub 中启用"为机场订阅添加前缀"
   - 这样可以通过订阅名筛选：`filter: "机场A"`

3. **地区标识**：确保节点名包含地区信息
   - 便于按地区筛选：`filter: "(?i)香港|HK"`

4. **测试筛选**：使用调试模式验证
   ```
   https://你的域名/token?__debug
   ```

5. **备份模板**：修改前备份模板到 Git

## 🆘 问题排查

### 问题 1：筛选后没有节点
**原因**：filter 正则不匹配任何节点名  
**解决**：
1. 检查节点命名
2. 使用 `?__debug` 查看所有节点名
3. 调整正则表达式

### 问题 2：筛选了不该筛选的节点
**原因**：正则表达式太宽泛  
**解决**：使用更精确的正则，如 `^香港` 而不是 `香港`

### 问题 3：Clash 报错
**原因**：生成的配置语法错误  
**解决**：
1. 检查 filter 正则是否有语法错误
2. 确保有 `__AUTO_INSERT_NODES__` 占位符
3. 查看生成的 YAML 是否有语法问题

---

**提示**：这个功能让你可以像使用 subconverter 的 INI 配置一样灵活地筛选节点，但速度更快，无需外部服务！🚀

