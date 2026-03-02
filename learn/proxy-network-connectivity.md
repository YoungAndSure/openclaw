# 代理网络连接问题排查与解决

## 问题现象

Discord channel 和飞书无法连接，日志报错：

```
[ws] unable to get local issuer certificate
[discord] channel exited: Failed to resolve Discord application id
AxiosError: unable to get local issuer certificate
```

Gateway 持续自动重启尝试连接，但始终失败。

## 问题原因

1. **网络层面**：Discord 和部分海外服务在中国大陆被屏蔽，需要通过代理访问
2. **环境变量缺失**：虽然系统代理已开启（浏览器能正常访问 Google），但终端和 Node.js 进程没有设置代理环境变量
3. **LaunchAgent 隔离**：通过 launchd 启动的 gateway 进程不会继承用户 shell 的环境变量

## 诊断步骤

### 1. 检查 Gateway 状态

```bash
ps aux | grep openclaw-gateway
```

### 2. 检查日志

```bash
tail -50 ~/.openclaw/logs/gateway.err.log
tail -50 ~/.openclaw/logs/gateway.log | grep -i "discord\|error"
```

### 3. 检查系统代理设置

```bash
networksetup -getwebproxy Wi-Fi
networksetup -getsecurewebproxy Wi-Fi
```

### 4. 检查终端代理环境变量

```bash
env | grep -i proxy
```

### 5. 测试网络连通性

```bash
# 不带代理测试（预期超时）
curl -v --connect-timeout 5 https://discord.com

# 带代理测试（预期成功）
curl -x http://127.0.0.1:17890 -I --connect-timeout 5 https://www.google.com
```

## 解决方案

### 方案一：临时解决（手动启动）

```bash
# 停止当前 gateway
openclaw gateway stop

# 设置代理环境变量并启动
export http_proxy=http://127.0.0.1:17890
export https_proxy=http://127.0.0.1:17890
export all_proxy=socks5://127.0.0.1:17890
export NODE_TLS_REJECT_UNAUTHORIZED=0

openclaw gateway
```

### 方案二：永久解决

#### 1. 添加代理到 shell 配置

编辑 `~/.zshrc`，添加：

```bash
# Proxy settings for openclaw gateway
export http_proxy=http://127.0.0.1:17890
export https_proxy=http://127.0.0.1:17890
export HTTP_PROXY=http://127.0.0.1:17890
export HTTPS_PROXY=http://127.0.0.1:17890
export all_proxy=socks5://127.0.0.1:17890
export ALL_PROXY=socks5://127.0.0.1:17890
export NO_PROXY=localhost,127.0.0.1,::1
```

#### 2. 修改 LaunchAgent 配置

编辑 `~/Library/LaunchAgents/ai.openclaw.gateway.plist`，在 `<dict>` 的 `EnvironmentVariables` 部分添加：

```xml
<key>http_proxy</key>
<string>http://127.0.0.1:17890</string>
<key>https_proxy</key>
<string>http://127.0.0.1:17890</string>
<key>HTTP_PROXY</key>
<string>http://127.0.0.1:17890</string>
<key>HTTPS_PROXY</key>
<string>http://127.0.0.1:17890</string>
<key>all_proxy</key>
<string>socks5://127.0.0.1:17890</string>
<key>ALL_PROXY</key>
<string>socks5://127.0.0.1:17890</string>
<key>NO_PROXY</key>
<string>localhost,127.0.0.1,::1</string>
<key>NODE_TLS_REJECT_UNAUTHORIZED</key>
<string>0</string>
```

#### 3. 重新加载 LaunchAgent

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

## 验证

检查连接状态：

```bash
tail -30 ~/.openclaw/logs/gateway.log | grep -E "discord|feishu|logged|ready"
```

预期输出：

```
[feishu] feishu[main]: bot open_id resolved: ...
[ws] ws client ready
[discord] rest proxy enabled
[discord] gateway proxy enabled
[discord] logged in to discord as ...
```

## 注意事项

1. **代理端口**：示例中使用 `17890`，请根据你的代理软件实际端口修改（常见端口：7890、1080、17890）
2. **NODE_TLS_REJECT_UNAUTHORIZED=0**：会禁用 SSL 证书验证，存在安全风险，仅在代理环境下使用
3. **代理软件需保持运行**：确保 Clash/V2Ray 等代理软件在 gateway 启动前已运行

## 相关文件

- Gateway 日志：`~/.openclaw/logs/gateway.log`
- 错误日志：`~/.openclaw/logs/gateway.err.log`
- LaunchAgent 配置：`~/Library/LaunchAgents/ai.openclaw.gateway.plist`
- Shell 配置：`~/.zshrc`
