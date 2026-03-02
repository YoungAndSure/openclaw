# OpenClaw 沙箱浏览器配置问题排查记录

## 目标

配置 OpenClaw 使用内置浏览器沙箱，让 Agent 可以在隔离环境中操作浏览器。

---

## 核心概念：沙箱模式与浏览器的关系

**沙箱浏览器必须依赖沙箱模式**，两者是紧密耦合的。

### 代码逻辑

```typescript
// src/agents/sandbox/context.ts
const runtime = resolveSandboxRuntimeStatus({ cfg, sessionKey });
if (!runtime.sandboxed) {
  return null;  // ← 沙箱关闭时，直接返回，不创建沙箱浏览器
}

// ... 只有沙箱开启时才会执行 ...
const containerName = await ensureSandboxContainer(...);  // 创建 Agent 工具沙箱
const browser = await ensureSandboxBrowser(...);         // 创建浏览器沙箱
```

### 模式对照表

| 沙箱模式 (`sandbox.mode`) | Agent 工具执行位置     | 浏览器类型                             |
| ------------------------- | ---------------------- | -------------------------------------- |
| `off`                     | 主机直接执行           | 主机浏览器（Chrome 扩展/托管 profile） |
| `non-main`                | 非主会话在 Docker 沙箱 | Docker 沙箱浏览器容器                  |
| `all`                     | 所有会话在 Docker 沙箱 | Docker 沙箱浏览器容器                  |

### 设计原因

沙箱浏览器需要与 Agent 沙箱共享：

- 相同的 Docker 网络
- 相同的 workspace 挂载配置
- 相同的 scope（session/agent/shared）

这确保了隔离的一致性 —— 如果 Agent 工具在沙箱中执行，浏览器也应该在沙箱中，防止通过浏览器逃逸。

---

## 架构概述

```
┌─────────────────────────────────────────────────────────────────┐
│                         主机 (Host)                              │
│                                                                  │
│   ┌─────────────────────┐                                       │
│   │  OpenClaw Gateway   │  ← 始终在主机运行                      │
│   │  (端口 18789)        │                                       │
│   └─────────────────────┘                                       │
│            │                                                     │
│            ▼                                                     │
│   ┌─────────────────────┐    ┌─────────────────────────────┐   │
│   │ 沙箱容器 1           │    │ 沙箱容器 2 (浏览器)          │   │
│   │ (Agent 工具执行)     │───▶│ Chromium + Xvfb            │   │
│   │ exec, read, write...│    │ (单独容器)                   │   │
│   └─────────────────────┘    └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 沙箱浏览器容器内部

```
Docker Container (openclaw-sandbox-browser:bookworm-slim)
├── Xvfb :1              # 虚拟显示器
├── Chromium             # 浏览器，连接 CDP 端口
├── socat                # 转发 CDP 端口到容器外
├── x11vnc               # VNC 服务（可选）
└── noVNC/websockify     # Web VNC 访问（可选）
```

---

## 问题 1: Docker 权限错误

### 现象

```
Failed to inspect sandbox image: permission denied while trying to connect
to the docker API at unix:///var/run/docker.sock
```

### 原因

Gateway 进程没有 docker 组权限。即使用户在 docker 组中，通过 `nohup` 或后台启动的进程可能不会继承组权限。

### 排查方法

```bash
# 检查 gateway 进程的组
GWPID=$(pgrep -o -f openclaw-gateway)
cat /proc/$GWPID/status | grep Groups
# 应该包含 998 (docker 组 GID)

# 检查 docker socket 权限
ls -la /var/run/docker.sock
# srw-rw---- 1 root docker ... 表示只有 root 和 docker 组可访问
```

### 解决方案

**方案 A: 修改 docker socket 权限（简单但不够安全）**

```bash
sudo chmod 666 /var/run/docker.sock
```

**方案 B: 使用 sg docker 启动 gateway**

```bash
sg docker -c 'openclaw gateway run --bind loopback --port 18789'
```

**方案 C: 重新登录系统**

用户加入 docker 组后需要重新登录，所有新进程才会继承组权限。

---

## 问题 2: Chromium 沙箱启动失败

### 现象

容器日志显示：

```
[ERROR:zygote_host_impl_linux.cc:128] No usable sandbox!
If you are running on Ubuntu 23.10+ or another Linux distro that has
disabled unprivileged user namespaces with AppArmor, see
https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
```

容器退出码 1，CDP 端口无法连接。

### 原因

**两层沙箱冲突**：

1. **Chromium 内置沙箱**: 使用 Linux 用户命名空间隔离渲染进程
2. **Docker 容器沙箱**: 限制进程的系统访问

Ubuntu 23.10+ 通过 AppArmor 禁用了非特权用户命名空间，导致 Chromium 的内置沙箱无法在 Docker 容器内创建。

### 解决方案

在容器内使用 `--no-sandbox` 参数启动 Chromium。这在 Docker 环境中是安全的，因为容器本身已提供隔离。

**修改 `src/agents/sandbox/browser.ts`**：

```typescript
// 添加环境变量让容器内的 Chromium 使用 --no-sandbox
args.push("-e", "OPENCLAW_BROWSER_NO_SANDBOX=1");
```

**容器入口脚本 `scripts/sandbox-browser-entrypoint.sh` 已支持**：

```bash
ALLOW_NO_SANDBOX="${OPENCLAW_BROWSER_NO_SANDBOX:-0}"
if [[ "${ALLOW_NO_SANDBOX}" == "1" ]]; then
  CHROME_ARGS+=(
    "--no-sandbox"
    "--disable-setuid-sandbox"
  )
fi
```

**需要重建镜像**：

```bash
docker build --no-cache -t openclaw-sandbox-browser:bookworm-slim -f Dockerfile.sandbox-browser .
```

---

## 问题 3: Gateway 使用全局安装版本

### 现象

修改了源代码但不生效。检查 gateway 工作目录：

```bash
GWPID=$(pgrep -o -f openclaw-gateway)
readlink /proc/$GWPID/cwd
# 显示 /home/youngsure 而不是 /home/youngsure/Code/openclaw
```

### 原因

系统同时安装了全局版本 (`~/.npm-global/bin/openclaw`) 和开发版本。直接运行 `openclaw` 命令使用的是全局版本。

### 解决方案

使用开发模式启动 gateway：

```bash
cd /home/youngsure/Code/openclaw
node --import tsx openclaw.mjs gateway run --bind loopback --port 18789
```

或使用 pnpm：

```bash
pnpm openclaw gateway run --bind loopback --port 18789
```

---

## 替代方案: Chrome 扩展模式

如果沙箱浏览器配置复杂，可以使用 Chrome 扩展方式：

### 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         主机 (Host)                              │
│                                                                  │
│   ┌─────────────────────┐        ┌─────────────────────────┐   │
│   │  OpenClaw Gateway   │        │   Chrome 浏览器          │   │
│   │  ├─ Browser Bridge  │◄──────▶│   ├─ OpenClaw 扩展      │   │
│   │  └─ Relay :18792    │  CDP   │   └─ 你的标签页          │   │
│   └─────────────────────┘        └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 配置步骤

1. 关闭沙箱模式：

   ```bash
   openclaw config set agents.defaults.sandbox.mode off
   ```

2. 安装 Chrome 浏览器

3. 安装扩展：

   ```bash
   openclaw browser extension install
   openclaw browser extension path  # 获取扩展目录
   ```

4. Chrome → `chrome://extensions` → 加载已解压的扩展

5. 配置扩展 Options：
   - Port: 18792
   - Gateway token: `openclaw config get gateway.auth.token --show-secrets`

6. 点击扩展图标连接标签页

---

## 配置参考

### 沙箱浏览器配置 (`~/.openclaw/openclaw.json`)

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "session",
        "workspaceAccess": "none",
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "containerPrefix": "openclaw-sbx-browser-",
          "cdpPort": 9222,
          "vncPort": 5900,
          "noVncPort": 6080,
          "headless": false,
          "enableNoVnc": true,
          "allowHostControl": false,
          "autoStart": true,
          "autoStartTimeoutMs": 12000
        }
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "image",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "subagents",
          "session_status",
          "browser"
        ],
        "deny": [
          "canvas",
          "nodes",
          "cron",
          "gateway",
          "telegram",
          "whatsapp",
          "discord",
          "irc",
          "googlechat",
          "slack",
          "signal",
          "imessage"
        ]
      }
    }
  }
}
```

### 常用命令

```bash
# 查看沙箱状态
openclaw sandbox explain

# 列出沙箱浏览器容器
openclaw sandbox list --browser

# 查看容器日志
docker logs <container-name>

# 重建浏览器沙箱镜像
./scripts/sandbox-browser-setup.sh

# 强制重建（不使用缓存）
docker build --no-cache -t openclaw-sandbox-browser:bookworm-slim -f Dockerfile.sandbox-browser .
```

---

## 总结

| 问题              | 原因                       | 解决方案                                        |
| ----------------- | -------------------------- | ----------------------------------------------- |
| Docker 权限错误   | Gateway 进程没有 docker 组 | `chmod 666 /var/run/docker.sock` 或 `sg docker` |
| Chromium 沙箱失败 | Ubuntu 禁用用户命名空间    | 添加 `OPENCLAW_BROWSER_NO_SANDBOX=1` 环境变量   |
| 代码修改不生效    | 使用全局安装版本           | 用 `node --import tsx` 或 `pnpm` 启动开发版本   |
| 配置复杂          | 沙箱浏览器依赖多           | 改用 Chrome 扩展模式                            |

**推荐**：对于个人开发/测试环境，Chrome 扩展模式更简单可靠。沙箱浏览器适合需要完全隔离的生产环境。
