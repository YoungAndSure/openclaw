# 飞书 TLS 证书验证失败问题排查

## 问题描述

OpenClaw 无法接收飞书消息，错误日志显示：

```
AxiosError: unable to get local issuer certificate
    url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
    cause: Error: unable to get local issuer certificate
```

WebSocket 连接也失败：

```
[error]: [ '[ws]', 'unable to get local issuer certificate' ]
```

## 问题原因

### 根本原因

系统运行了 **Ant Link (Clash 代理)**，使用了 `fake-ip` DNS 模式。这导致：

1. Clash 劫持了所有 DNS 查询，返回 fake-ip 地址
2. 飞书域名 `*.feishu.cn` 没有配置为直连（DIRECT），流量走了代理
3. Node.js 使用的证书存储与系统不同，无法验证经过代理的 HTTPS 连接证书链

### 为什么 curl 正常但 Node.js 失败？

| 工具 | 证书存储 | 结果 |
|-----|---------|------|
| curl | 使用系统 CA 证书 `/etc/ssl/cert.pem` | ✅ 正常 |
| Node.js | 使用内置证书存储 | ❌ 证书验证失败 |

## 诊断过程

### 1. 检查错误日志

```bash
tail -100 ~/.openclaw/logs/gateway.err.log | grep -i "certificate\|feishu"
```

### 2. 验证 curl 可以正常连接

```bash
curl -v https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal 2>&1 | head -40
# 显示: SSL certificate verify ok
```

### 3. 验证 Node.js 无法连接

```bash
node -e "const https = require('https'); https.get('https://open.feishu.cn', (res) => console.log('OK:', res.statusCode)).on('error', (e) => console.log('Error:', e.message));"
# 输出: Error: unable to get local issuer certificate
```

### 4. 使用系统证书测试 Node.js

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node -e "const https = require('https'); https.get('https://open.feishu.cn', (res) => console.log('OK:', res.statusCode)).on('error', (e) => console.log('Error:', e.message));"
# 输出: OK: 200
```

### 5. 检查代理软件

```bash
ps aux | grep -E "Clash|clash|proxy|Proxy"
# 发现 Ant Link (Clash) 正在运行
```

## 解决方案

### 方案一：Clash 配置添加飞书直连规则（推荐）

编辑 `~/Library/Application Support/ant/config.yaml`，在 `rules:` 最前面添加：

```yaml
rules:
  - DOMAIN-SUFFIX,feishu.cn,DIRECT
  - DOMAIN-SUFFIX,larksuite.com,DIRECT
  - DOMAIN-SUFFIX,lark.com,DIRECT
  # ... 其他规则
```

重新加载配置：

```bash
curl -X PUT http://127.0.0.1:8765/configs -H "Content-Type: application/json" \
  -d '{"path": "/Users/yangshuo/Library/Application Support/ant/config.yaml"}'
```

### 方案二：配置 Node.js 使用系统证书

编辑 LaunchAgent plist 文件 `~/Library/LaunchAgents/ai.openclaw.gateway.plist`，在 `<dict>` 的 `EnvironmentVariables` 中添加：

```xml
<key>NODE_EXTRA_CA_CERTS</key>
<string>/etc/ssl/cert.pem</string>
```

重新加载服务：

```bash
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### 方案三：Shell 环境变量（命令行启动时生效）

在 `~/.zshrc` 中添加：

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
```

## 验证修复

检查日志确认飞书连接成功：

```bash
tail -30 ~/.openclaw/logs/gateway.log | grep feishu
```

应该看到：

```
[feishu] starting feishu[main] (mode: websocket)
[feishu] feishu[main]: bot open_id resolved: ou_xxx
[feishu] feishu[main]: WebSocket client started
[info]: [ '[ws]', 'ws client ready' ]
```

## 相关文件

| 文件 | 用途 |
|-----|------|
| `~/.openclaw/logs/gateway.log` | Gateway 主日志 |
| `~/.openclaw/logs/gateway.err.log` | Gateway 错误日志 |
| `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | 详细 JSON 格式日志 |
| `~/Library/LaunchAgents/ai.openclaw.gateway.plist` | Gateway LaunchAgent 配置 |
| `~/Library/Application Support/ant/config.yaml` | Clash 代理配置 |

## 经验总结

1. **代理软件 + fake-ip DNS** 是常见的 TLS 证书问题来源
2. **curl 和 Node.js 使用不同的证书存储**，诊断时需要分别测试
3. 国内服务（飞书、微信等）通常应配置为直连，避免代理干扰
4. `NODE_EXTRA_CA_CERTS` 环境变量可以让 Node.js 使用系统证书

---

*记录时间：2026-03-02*
