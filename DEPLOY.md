# 部署指南

本文覆盖两件事：

1. **更新已有部署**（你自己在用的那个站点）
2. **新开一个完全独立的部署**（给客户用，数据与你自己的互不相通）

---

## 一、更新已有部署

现有站点 **https://misub.hjagi.cc**（Pages 项目 `misub`）通过 **Git 连接自动部署**：
代码推到 `main` 分支后 Cloudflare Pages 会自动构建并上线，不需要手动操作。

```bash
git push origin main
```

推送后到 Cloudflare 控制台 → `Workers & Pages` → 你的项目 → `部署` 里能看到新的构建。
构建约 1–2 分钟。

### 本次更新后需要检查的两项配置

**1）确认环境变量都已设置**（这次加了强校验，缺失时会明确报错而不再放行）

控制台 → 你的项目 → `设置` → `环境变量`，确认**生产环境**存在：

| 变量名 | 说明 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `COOKIE_SECRET` | 会话签名密钥，用 `openssl rand -hex 32` 生成 |

> ⚠️ 以前如果没设 `ADMIN_PASSWORD`，任何人不填密码就能登录（`undefined === undefined` 成立）。
> 现在缺失时后端会直接返回 503 并提示去设置，不会再放行。

**2）设置里新增了两个通知开关，默认都是关闭**

- **订阅被访问时通知**：默认**关**。以前每次客户端自动更新订阅都会推一条 Telegram 消息，
  非常吵。需要排查问题时再打开。
- **保存设置时通知**：默认**关**。

### 关于定时刷新

Cloudflare Pages Functions **不支持** cron 触发器 —— `wrangler.toml` 里原来的 `[triggers]`
配置从未真正执行过，所以流量和到期时间一直不会自动刷新。

现在仪表盘右上角提供了 **「刷新全部」** 按钮，一次性重新拉取所有已启用订阅的流量与节点数。

如果确实需要自动刷新，可以用外部定时服务（例如 cron-job.org）每隔几小时访问一次你的订阅链接。

---

## 二、给客户新开一个独立部署

目标：**完全独立的 KV + D1**，客户的数据和你自己的互不影响。

### 本次要开的这一套（实际取值）

| 项目 | 你自己的（已存在） | 客户版（要新建） |
| --- | --- | --- |
| Pages 项目名 | `misub` | **`misubfu`** |
| 访问域名 | `misub.hjagi.cc` | **`misubfu.hjagi.cc`** |
| KV 命名空间 | `MISUB_KV` | **`MISUBFU_KV`** |
| D1 数据库 | `misub-database` | **`misubfu-database`** |
| 绑定变量名 | `MISUB_KV` / `MISUB_DB` | `MISUB_KV` / `MISUB_DB` ← **两边一样，代码里读的就是这两个名字** |
| `ADMIN_PASSWORD` | 你自己的 | **另设一个** |
| `COOKIE_SECRET` | 你自己的 | **另生成一个** |

> 关键点：**绑定的「变量名」两边必须相同**（`MISUB_KV` / `MISUB_DB`），
> 区分两套部署的是「变量名指向哪个资源」。这一点很容易搞反。

下面每一步都要用**和现有项目不同的资源名**，避免混淆。

### 步骤 1：创建独立的 KV 命名空间

两种做法都行，选一种：

**做法 A：命令行**

```bash
npx wrangler login          # 首次使用需要授权（会打开浏览器）
npx wrangler kv namespace create MISUBFU_KV
```

记下输出的 `id`。

**做法 B：控制台**

`Workers & Pages` → 左侧 `KV` → `创建命名空间` → 名称填 `MISUBFU_KV`。

### 步骤 2：创建独立的 D1 数据库并建表

**做法 A：命令行**

```bash
npx wrangler d1 create misubfu-database

# 初始化表结构 —— 必须带 --remote，否则只会写到本地 sqlite 文件，线上数据库还是空的
npx wrangler d1 execute misubfu-database --file=schema.sql --remote

# 验证
npx wrangler d1 execute misubfu-database --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table';"
```

应当看到 `subscriptions`、`profiles`、`settings` 三张表。

**做法 B：控制台**

`Workers & Pages` → 左侧 `D1 SQL 数据库` → `创建` → 名称填 `misubfu-database`。
建好后进入该数据库 → `控制台` 标签页，把 [schema.sql](./schema.sql) 的内容整段粘贴进去执行：

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_at ON subscriptions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
CREATE INDEX IF NOT EXISTS idx_settings_updated_at ON settings(updated_at);
```

全部是 `CREATE TABLE IF NOT EXISTS`，重复执行是安全的。

> ⚠️ 这一步一定要做。如果 D1 里没有这三张表，在设置里切到「D1 数据库」会因为
> 建表缺失而中止（数据是安全的，但切不过去）。

### 步骤 3：创建第二个 Pages 项目

Cloudflare 控制台 → `Workers & Pages` → `创建应用程序` → `Pages` → `连接到 Git`：

- **仓库**：选同一个仓库 `jonathanfan-ee/MiSub`（两个 Pages 项目可以共用一个仓库，各自独立构建）
- **项目名称**：`misubfu`
- **生产分支**：`main`
- **框架预设**：`Vue`
- **构建命令**：`npm run build`
- **构建输出目录**：`dist`

> 共用仓库意味着以后推一次 `main`，两个站点都会自动更新 —— 这通常正是想要的。

### 步骤 4：绑定 KV 和 D1

进入 `misubfu` 项目 → `设置` → `绑定` → `添加`：

| 绑定类型 | 变量名（必须完全一致） | 选择的资源 |
| --- | --- | --- |
| KV 命名空间 | `MISUB_KV` | 步骤 1 创建的 **`MISUBFU_KV`** |
| D1 数据库 | `MISUB_DB` | 步骤 2 创建的 **`misubfu-database`** |

> 变量名必须是 `MISUB_KV` 和 `MISUB_DB` —— 代码里读的就是这两个名字。
> 「选择的资源」那一列才是区分客户与你自己的关键。
> 对照你自己的 `misub` 项目：变量名相同，但资源分别是 `MISUB_KV` / `misub-database`。

### 步骤 5：设置环境变量

`设置` → `变量和密钥` → `添加`，类型选 **密钥（Secret）**，**生产环境和预览环境都要加**：

| 变量名 | 值 |
| --- | --- |
| `ADMIN_PASSWORD` | 给客户的管理员密码（**不要和你自己的相同**） |
| `COOKIE_SECRET` | 新生成一个：`openssl rand -hex 32`（**不要和你自己的相同**） |

> 两点务必注意：
> 1. 预览环境如果不设，预览部署将无法登录（新版会返回 503 并提示缺哪个变量）。
> 2. `COOKIE_SECRET` 必须和你自己站点的**不同**。相同的话，一个站点签发的会话
>    Cookie 在另一个站点也会被判为有效。

### 步骤 6：绑定自定义域名 `misubfu.hjagi.cc`

`misubfu` 项目 → `自定义域` → `设置自定义域` → 填 `misubfu.hjagi.cc` → `激活域`。

因为 `hjagi.cc` 已经在你的 Cloudflare 账号里，CNAME 记录会自动创建，通常一两分钟生效。
证书签发可能再等几分钟。

验证：

```bash
curl -sI https://misubfu.hjagi.cc | head -1
```

### 步骤 7：重新部署并初始化

回到 `部署` 选项卡点一次「重试部署」，让绑定生效。

> ⚠️ **这一步不能跳过，而且很容易被误判。** Cloudflare Pages 的两类配置生效方式不一致：
>
> | 配置 | 是否需要重新部署 |
> | --- | --- |
> | 变量和密钥（`ADMIN_PASSWORD` / `COOKIE_SECRET`） | **不需要**，即时生效 |
> | 绑定（`MISUB_KV` / `MISUB_DB`） | **需要**，否则运行时读到的 `env.MISUB_DB` 仍是 undefined |
>
> 结果就是：你能正常登录（密钥已生效），但在设置里切换到 D1 会报
> 「未绑定 D1 数据库（MISUB_DB）」—— 而面板里明明已经绑好了。
> 这不是配置错误，只是还没重新部署。以后每次改动绑定都要记得重新部署一次。

然后打开站点并登录，进入 **设置**：

1. **数据存储类型** 选 `D1 数据库`（新部署建议直接用 D1，没有 KV 的写入频率限制）。
   保存时系统会自动把现有数据同步到目标存储。
2. **自定义订阅Token**：改成一个随机字符串。
   > ⚠️ 默认值是 `auto`，意味着 `https://你的域名/auto` 会直接返回全部节点。
   > 务必改掉。
3. **订阅组分享Token**：同样改成一个随机字符串，这是分发给客户的链接所用的凭证。

### 步骤 8：交付给客户

在仪表盘右侧「生成订阅链接」面板：

1. **选择订阅内容** —— 选具体的订阅组（不要用「默认订阅」，那是全部节点）
2. **选择格式** —— 一般给「通用格式」，它会自动识别客户端类型
3. 点复制按钮，或点 **「显示二维码」** 让客户用手机客户端扫码导入

面板下方会显示这个格式适配哪些客户端，可以直接转述给客户。

---

## 三、独立性检查清单

新部署完成后，逐项确认两个站点互不影响：

| 检查项 | `misub`（你自己） | `misubfu`（客户） | 必须 |
| --- | --- | --- | --- |
| KV 绑定指向的命名空间 | `MISUB_KV` | `MISUBFU_KV` | 不同 |
| D1 绑定指向的数据库 | `misub-database` | `misubfu-database` | 不同 |
| `ADMIN_PASSWORD` | — | — | 不同 |
| `COOKIE_SECRET` | — | — | **不同** |
| 设置里的 `mytoken` | — | — | 不同 |
| 设置里的 `profileToken` | — | — | 不同 |

最后做一次实测，这是最可靠的验证：

- [ ] 在 `misubfu.hjagi.cc` 加一条订阅并保存
- [ ] 刷新 `misub.hjagi.cc`，确认**没有**出现这条订阅
- [ ] 反向再试一次

如果两边数据串了，八成是 KV 或 D1 绑定选到了同一个资源 —— 回到步骤 4 检查
「选择的资源」那一列（变量名相同是正确的，资源必须不同）。

---

## 四、本地开发

```bash
npm install

# 准备本地密钥
cp .dev.vars.example .dev.vars   # 然后填入自己的值

# 终端 1：前端（带热更新）
npm run dev

# 终端 2：后端 API（本地 KV / D1，数据存在 .wrangler 目录下）
npm run build && npm run dev:api
```

前端开发服务器会把 `/api` 和 `/sub` 代理到 `127.0.0.1:8787`。

> `wrangler.toml` 只用于本地开发，线上的绑定在控制台配置。
> 特别注意：**不要**给 `wrangler.toml` 添加 `pages_build_output_dir` —— 一旦加上，
> Pages 会改用该文件作为权威配置并忽略控制台里的绑定，导致线上 KV/D1 全部失效。

---

## 五、常见问题

**登录提示「服务端未配置管理员密码」**
→ 环境变量 `ADMIN_PASSWORD` 没设，或设完没有重新部署。

**登录提示「尝试次数过多」**
→ 连续 8 次密码错误会锁定 15 分钟（按来源 IP）。等待或换网络。

**页面开着过夜，操作时提示登录已过期**
→ 现在会弹出「就地重新登录」对话框，输入密码即可继续，**未保存的修改不会丢失**。
  同时会话已改为滑动续期：持续使用不会被动登出。

**切换存储类型后数据不见了**
→ 已修复。现在切换时会先把现有数据同步到目标存储，再切换设置；
  同步失败会中止并保留原设置。

**客户反馈订阅链接打不开**
→ 用浏览器打开该链接，现在会显示中文提示页说明具体原因
  （凭证错误 / 订阅组已停用 / 转换后端不可用）。

**Clash Meta 直接生成模式下节点变少**
→ 已修复多个解析问题：`anytls://`、`socks5://` 以前会被静默丢弃；
  SIP002 base64url 的 `ss://` 会解析出空加密方式导致整份配置被 mihomo 拒绝；
  代理组的 `filter` 用 Go 风格的 `(?i)` 会抛异常并退回 subconverter。
