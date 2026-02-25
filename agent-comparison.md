# OpenClaw Agent 执行器 vs 常见 Agent 实现对比

## 1. 架构定位不同

| 特性 | 常见 Agent (OpenCode/Claude Code) | OpenClaw Agent |
|------|----------------------------------|----------------|
| **核心定位** | 代码执行助手 | **设备管理中枢** |
| **运行模式** | 本地单机运行 | 分布式（Gateway + Node） |
| **连接方式** | 直接调用 API | WebSocket 长连接 + 协议封装 |
| **设备支持** | 仅本地机器 | 多节点（iOS/Android/macOS/Headless） |

## 2. Agent 运行时架构对比

### 常见 Agent（以 OpenCode 为例）

```
┌─────────────────────────────────────┐
│           OpenCode Agent            │
│  ┌─────────┐  ┌─────────────────┐    │
│  │  LLM API │←→│  Tool Executor  │    │
│  │ (Claude) │  │ (本地文件/exec) │    │
│  └─────────┘  └─────────────────┘    │
└─────────────────────────────────────┘
              │
              ▼
        本地文件系统
```

### OpenClaw Agent

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                      │
│  ┌─────────────┐      ┌─────────────────────────────┐   │
│  │  pi-agent   │←────→│     Agent 执行器            │   │
│  │   runtime   │      │  (pi-embedded-runner.ts)    │   │
│  │             │      │                             │   │
│  │ • 流式处理  │      │ • 工具注册 (20+ tools)      │   │
│  │ • 消息队列  │      │ • 会话管理                  │   │
│  │ • 队列控制  │      │ • 节点调度                  │   │
│  └─────────────┘      └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
           │                           │
           │    WebSocket 控制平面      │
           │                           │
     ┌─────┴──────┐  ┌────────┐  ┌────┴────┐
     │ 本地机器    │  │ iOS    │  │ Android │
     │ (Node Host)│  │ (Node) │  │ (Node)  │
     └────────────┘  └────────┘  └─────────┘
```

## 3. 关键技术差异

### A. 基于 pi-mono 的嵌入式运行时

OpenClaw 使用 `@mariozechner/pi-coding-agent` 作为底层 Agent 运行时（源自 **pi-mono** 项目）：

```typescript
// OpenClaw 的 Agent 工具创建
import {
  codingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

export function createOpenClawCodingTools(options?: {
  agentId?: string;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  sandbox?: SandboxContext | null;
  // ... 更多选项
}): AnyAgentTool[] {
  // 组合基础工具 + OpenClaw 特有工具
  const tools = [
    ...codingTools,  // pi-coding-agent 基础工具
    createOpenClawTools(options),  // OpenClaw 扩展工具
  ];
}
```

这与常见 Agent 直接调用 LLM API 不同，OpenClaw 封装了一个完整的 Agent 运行时环境。

### B. 引导文件系统（Bootstrap Files）

OpenClaw 独特的 **Markdown 引导文件**机制：

| 文件 | 用途 | 传统 Agent 对比 |
|------|------|----------------|
| `AGENTS.md` | 操作指令 + 记忆 | 通常是系统提示的一部分 |
| `SOUL.md` | 人设、边界、语音 | 硬编码的 personality |
| `TOOLS.md` | 用户维护的工具说明 | 代码中的 tool 定义 |
| `IDENTITY.md` | 身份识别 | 通常不存在 |
| `USER.md` | 用户信息 | 通常不存在 |

这些文件在首次运行时**自动注入**到 Agent 上下文，用户可以编辑，而不是硬编码在代码中。

### C. 工具执行的多层抽象

**常见 Agent 的工具调用：**
```javascript
// 直接执行
const result = await executeTool("read_file", { path: "/tmp/test.txt" });
```

**OpenClaw 的工具调用（多层封装）：**
```typescript
// 1. 工具策略管道
const toolWithPolicy = applyToolPolicyPipeline(tool, {
  steps: buildDefaultToolPolicyPipelineSteps(),
});

// 2. 权限检查
const toolWithGuard = wrapToolWorkspaceRootGuard(toolWithPolicy, {
  allowedRoots: [workspaceDir],
});

// 3. 钩子包装
const toolWithHook = wrapToolWithBeforeToolCallHook(toolWithGuard, {
  hookRunner: getGlobalHookRunner(),
});

// 4. 中止信号支持
const finalTool = wrapToolWithAbortSignal(toolWithHook, abortSignal);

// 执行
const result = await finalTool.execute(params);
```

### D. 节点（Node）调度能力

这是 OpenClaw 最大的差异化特性：

```typescript
// OpenClaw 可以调度远程节点执行工具
const result = await nodes.invoke({
  node: "iPhone-Node",
  command: "camera.snap",
  params: { facing: "back" }
});

// 或在远程节点执行 bash
const result = await nodes.run({
  node: "Build-Server",
  command: ["npm", "build"]
});
```

常见 Agent 只能在本地执行，OpenClaw 可以跨设备调度。

### E. 流式处理与消息队列

OpenClaw 内置了复杂的**消息队列机制**：

```typescript
// 来自 pi-embedded-subscribe.handlers.ts
switch (evt.type) {
  case "tool_execution_start":
    handleToolExecutionStart(ctx, evt);  // 异步，不阻塞
    return;
  case "tool_execution_end":
    handleToolExecutionEnd(ctx, evt);    // 异步，best-effort
    return;
  case "message_update":
    handleMessageUpdate(ctx, evt);        // 流式更新
    return;
}
```

支持：
- **steer/followup/collect** 模式（队列控制）
- **实时流式传输**（分块合并）
- **工具执行中的消息插入**

## 4. 与 OpenCode 的具体对比

| 维度 | OpenCode | OpenClaw |
|------|----------|----------|
| **Agent 核心** | 直接调用 Claude API | 嵌入式 pi-agent 运行时 |
| **工具数量** | 4-5 个核心工具 | 20+ 内置工具 + 插件扩展 |
| **设备支持** | 仅本地 | 本地 + 远程节点（手机/服务器） |
| **会话管理** | 简单的历史记录 | 复杂的 session-key 路由 + 持久化 |
| **消息渠道** | 仅 CLI | CLI + Telegram + Discord + Slack + ... |
| **工作区** | 当前目录 | 统一工作区 + 沙箱隔离 |
| **扩展机制** | 有限 | 完整的插件系统（extensions） |
| **流式处理** | 简单流式 | 队列控制 + 消息插入 + 分段合并 |

## 5. 总结

**常见 Agent（OpenCode/Claude Code）** 的定位是：
> "一个帮你写代码的 AI 助手"

**OpenClaw Agent** 的定位是：
> "一个分布式 AI 设备管理中枢，可以调度多节点、多渠道、多工具完成复杂任务"

OpenClaw 的 Agent 执行器更像是一个**"Agent 的操作系统"**，提供了：
1. **进程管理**（会话生命周期）
2. **设备驱动**（Node 节点）
3. **消息总线**（多渠道路由）
4. **插件架构**（扩展系统）
5. **文件系统**（引导文件 + 工作区）

而常见 Agent 更像是一个**"单一应用程序"**，专注于特定任务（如编码）。

---

## 待讨论问题

1. **架构定位** - 为什么 OpenClaw 选择分布式架构而不是单机架构？
2. **pi-mono 运行时** - 嵌入式运行时的优势和劣势是什么？
3. **引导文件系统** - AGENTS.md/SOUL.md 等文件的设计哲学
4. **工具多层抽象** - 权限检查、钩子机制的必要性
5. **Node 调度** - 跨设备调度的实现原理和应用场景
6. **消息队列** - steer/followup/collect 模式的设计意图
7. **插件系统** - 与常见 Agent 的扩展机制对比
