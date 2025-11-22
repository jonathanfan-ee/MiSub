# Clash Meta 直接生成 - 快速设置指南

## 🎯 5 分钟完成配置

### 步骤 1：上传模板文件

1. **Fork 本项目**或者直接复制 `clash-meta-template.yaml` 文件

2. **创建 GitHub Gist**
   - 访问 https://gist.github.com
   - 新建一个 Gist
   - 文件名：`clash-meta-template.yaml`
   - 将 `clash-meta-template.yaml` 的内容粘贴进去
   - 点击 "Create public gist"

3. **获取 Raw URL**
   - 点击 Gist 中的 "Raw" 按钮
   - 复制浏览器地址栏的 URL
   - 格式类似：`https://gist.githubusercontent.com/你的用户名/xxx/raw/xxx/clash-meta-template.yaml`

### 步骤 2：配置 MiSub

1. **登录 MiSub 管理界面**
   ```
   https://你的域名
   ```

2. **进入设置页面**

3. **配置以下选项**：

   | 选项 | 设置值 |
   |------|--------|
   | 启用 Clash Meta 直接生成模式 | ☑️ **勾选** |
   | Clash Meta 模板 URL | **粘贴你的 Gist Raw URL** |
   | 自动插入节点到选择组 | ☑️ **勾选** |

4. **保存设置**

### 步骤 3：测试订阅

1. **复制你的订阅链接**
   ```
   https://你的域名/你的token
   ```

2. **在 Clash Verge 中导入**
   - 打开 Clash Verge
   - 订阅 → 新建 → 导入
   - 粘贴订阅链接
   - 更新订阅

3. **验证配置**
   - 检查节点是否正确显示
   - 检查代理组是否包含所有节点
   - 测试连接

## ✅ 完成！

现在你的 MiSub 会直接生成适配 Clash Meta 的 YAML 配置，无需 subconverter！

## 🔍 如何验证直接生成模式已启用

### 方法 1：查看响应速度
直接生成模式响应更快（通常 < 1 秒）

### 方法 2：使用调试模式
访问：
```
https://你的域名/你的token?__debug
```

输出中会显示：
```
Direct Clash Meta Mode: ON
```

### 方法 3：查看返回的配置
直接在浏览器访问订阅链接，如果返回的是完整的 YAML 配置（而不是回调），说明直接生成模式已启用。

## 🎨 自定义你的模板

### 修改代理组

编辑你的 Gist 中的 `proxy-groups` 部分：

```yaml
proxy-groups:
  # 添加你自己的代理组
  - name: 香港节点
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    filter: "(?i)香港|HK|Hong"
    proxies:
      - __AUTO_INSERT_NODES__
  
  - name: 新加坡节点
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    filter: "(?i)新加坡|狮城|SG|Singapore"
    proxies:
      - __AUTO_INSERT_NODES__
```

### 修改分流规则

在 `rules` 部分添加或修改规则：

```yaml
rules:
  # 你的自定义规则
  - DOMAIN-SUFFIX,example.com,Proxies
  - DOMAIN-KEYWORD,google,Google
  
  # 保留原有规则
  - GEOSITE,cn,直连
  - MATCH,Final
```

### 修改 DNS 设置

```yaml
dns:
  enable: true
  nameserver:
    # 使用你喜欢的 DNS
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query
    # 或者使用其他 DNS
    - https://1.1.1.1/dns-query
```

修改后，在 MiSub 中**更新订阅**即可生效！

## 🚨 常见问题解决

### 问题 1：节点没有显示

**原因：** 可能是节点解析失败

**解决：**
1. 访问调试模式查看节点是否正常聚合
2. 检查节点链接格式是否正确
3. 查看浏览器控制台是否有错误信息

### 问题 2：代理组为空

**原因：** 节点没有正确插入到代理组

**解决：**
1. 确认模板中使用了 `__AUTO_INSERT_NODES__` 占位符
2. 或者确保启用了"自动插入节点到选择组"
3. 检查代理组的 `proxies` 列表格式是否正确

### 问题 3：规则不生效

**原因：** 规则顺序或格式问题

**解决：**
1. 检查规则语法是否正确
2. 确保规则顺序合理（精确规则在前，通配规则在后）
3. 检查 GEO 数据源是否正常

### 问题 4：模板无法加载

**原因：** URL 无法访问或格式错误

**解决：**
1. 确认 Gist URL 是 Raw 格式
2. 测试 URL 在浏览器中是否可访问
3. 检查是否使用了正确的 HTTPS 协议
4. 如果仍然失败，留空模板 URL 使用内置默认模板

## 📱 推荐客户端

这个配置专门为 **Clash Meta** 内核优化，推荐使用：

- ✅ **Clash Verge** (Windows/macOS/Linux)
- ✅ **Clash Verge Rev** (增强版)
- ✅ **Clash Meta for Android** (Android)
- ✅ **ClashX Meta** (macOS)

## 💡 高级提示

### 使用 GitHub 仓库管理模板

如果你经常修改配置，可以：

1. 创建一个 GitHub 仓库
2. 将模板文件放在仓库中
3. 使用 GitHub Raw URL
4. 通过 Git 管理版本

**示例 URL：**
```
https://raw.githubusercontent.com/你的用户名/仓库名/main/clash-meta-template.yaml
```

### 使用 CDN 加速（可选）

如果访问 GitHub 较慢，可以使用镜像：

```
https://mirror.ghproxy.com/https://raw.githubusercontent.com/你的用户名/仓库名/main/clash-meta-template.yaml
```

## 📞 需要帮助？

- 查看完整文档：`CLASH_META_DIRECT_MODE.md`
- 参考模板：`clash-meta-template.yaml`
- Clash Meta 文档：https://wiki.metacubex.one

---

**享受更快、更稳定的 Clash Meta 体验！** 🚀

