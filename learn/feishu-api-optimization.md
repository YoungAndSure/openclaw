# 飞书 API 调用优化指南

## 问题描述

飞书后台统计显示 API 调用次数（如 30,000+ 次）远高于实际收到的消息数量。

## 根本原因

### 1. Streaming Cards（流式卡片）- 主要原因

OpenClaw 默认启用飞书的流式输出功能，让 AI 回复像 ChatGPT 一样逐字显示。但这会产生大量 API 调用：

```
单次 AI 回复的 API 调用：
├── 1x Token 刷新 (/auth/v3/tenant_access_token/internal)
├── 1x 创建卡片实体 (POST /cardkit/v1/cards)
├── 1x 发送卡片消息 (im.message.create)
├── Nx 更新卡片内容 (PUT /cardkit/v1/cards/{cardId}/elements/content/content)
│   └── 每 100ms 更新一次，10 秒回复 = ~100 次调用
└── 1x 关闭流式模式 (PATCH /cardkit/v1/cards/{cardId}/settings)

总计：一条消息可能产生 50-150+ 次 API 调用
```

### 2. 其他 API 调用来源

| 功能       | 每次消息的 API 调用 | 说明                        |
| ---------- | ------------------- | --------------------------- |
| 输入指示器 | 2 次                | 添加 + 移除 typing 表情     |
| 媒体上传   | 2+ 次               | 上传 + 发送                 |
| 工具调用   | 1-3+ 次             | doc/wiki/drive/bitable 操作 |
| Token 刷新 | 0-1 次              | 缓存约 2 小时               |

## 解决方案

### 关闭流式输出

编辑配置文件 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "feishu": {
      "appId": "your_app_id",
      "appSecret": "your_app_secret",
      "enabled": true,
      "connectionMode": "websocket",
      "streaming": false // 添加此行
    }
  }
}
```

或使用 CLI 命令：

```bash
openclaw config set channels.feishu.streaming false
```

### 重启 Gateway

```bash
# 停止现有进程
pkill -9 -f openclaw-gateway

# 重新启动
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &

# 验证
tail -f /tmp/openclaw-gateway.log
```

## 效果对比

| 配置                     | 每条回复 API 调用 | 用户体验               |
| ------------------------ | ----------------- | ---------------------- |
| `streaming: true` (默认) | 50-150+ 次        | 文字逐字出现，实时感强 |
| `streaming: false`       | 1-2 次            | 等待完成后一次性显示   |

**预期优化效果**：API 调用量降低 50-100 倍

## Streaming Cards 工作原理

```
用户发送消息
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  1. 创建流式卡片                                         │
│     POST /cardkit/v1/cards                              │
│     { streaming_mode: true, content: "⏳ Thinking..." } │
└─────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  2. 发送卡片到聊天                                       │
│     im.message.create                                    │
└─────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  3. AI 生成中... 每 100ms 更新卡片内容                   │
│     PUT /cardkit/v1/cards/{cardId}/elements/content     │
│     ↺ 循环直到生成完成                                   │
└─────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  4. 关闭流式模式                                         │
│     PATCH /cardkit/v1/cards/{cardId}/settings           │
│     { streaming_mode: false }                            │
└─────────────────────────────────────────────────────────┘
```

## 相关代码位置

- 流式卡片实现：`extensions/feishu/src/streaming-card.ts`
- 回复调度器：`extensions/feishu/src/reply-dispatcher.ts`
- 配置判断：`account.config?.streaming !== false && renderMode !== "raw"`

## 其他优化建议

1. **调整更新频率**（需改代码）：将 `updateThrottleMs` 从 100ms 改为 500ms
2. **使用 raw 模式**：设置 `renderMode: "raw"` 禁用卡片格式
3. **审查工具使用**：减少不必要的 doc/wiki/drive 操作
