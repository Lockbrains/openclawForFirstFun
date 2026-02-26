# Tool Execution Gateway (TEG) 方案提案

> **状态**: 草案 / 待团队讨论  
> **日期**: 2026-02-26  
> **作者**: FirstFun  
> **关联**: OpenClaw 安全加固 / 功能精简

---

## 1. 背景与问题

### 1.1 现状

OpenClaw 当前以 prompt 驱动的方式运行 LLM agent，agent 可以通过工具调用（tool call）执行系统级操作，包括 shell 命令、文件读写、网络请求、消息发送等。

### 1.2 已知风险

社区和实际使用中已出现以下问题：

- **Context overflow 导致 memory 丢失**：长对话中，系统提示中的安全规则在上下文压缩/截断后被省略，LLM 可能无视安全指令。
- **Prompt 注入攻击**：外部内容（邮件、webhook、网页抓取结果）中的恶意指令被 LLM 当作合法指令执行。
- **工具调用的隐式信任**：LLM 返回的 tool call 在大多数路径上直接执行，缺乏程序级的强制审批。

### 1.3 矛盾点

- **完全剥离系统操作** → 安全性最高，但功能大幅削弱，agent 退化为纯文本助手。
- **保留当前机制** → 功能完整，但在 context overflow 和 prompt 注入场景下存在不可忽视的安全隐患。

**核心问题：能否在程序层面实现类似 Cursor 的审批机制——系统级操作必须经过结构化请求和人工/程序许可后才执行？**

---

## 2. 现有安全架构审计

### 2.1 当前安全层

| 层级                  | 机制                               | 关键文件                                  | 是否依赖 LLM 合规 |
| --------------------- | ---------------------------------- | ----------------------------------------- | :---------------: |
| Docker 沙箱           | 容器隔离、只读 FS、cap-drop        | `src/agents/sandbox/`                     |        否         |
| Exec Approvals        | deny / allowlist / full + ask 模式 | `src/infra/exec-approvals.ts`             |        否         |
| Tool Policy           | allow / deny 列表、profile 分级    | `src/agents/tool-policy.ts`               |        否         |
| Before-tool-call Hook | 插件级拦截钩子                     | `src/agents/pi-tools.before-tool-call.ts` |        否         |
| 外部内容包裹          | 不可信内容用边界标记隔离           | `src/security/external-content.ts`        |      **是**       |
| SSRF 防护             | 屏蔽 localhost / 私有 IP           | `src/infra/net/ssrf.js`                   |        否         |
| 危险环境变量拦截      | 屏蔽 PATH / LD*\* / DYLD*\*        | `src/agents/bash-tools.exec.ts`           |        否         |

### 2.2 关键缺陷

1. **Exec Approvals 的 ask 机制范围有限**：仅覆盖 `exec` 工具在 `host=gateway` 和 `host=node` 时的场景，不覆盖 `write`、`edit`、`message` 等工具。

2. **外部内容防护依赖 LLM 合规**：`external-content.ts` 中的 `detectSuspiciousPatterns()` 只记录日志不阻止执行；`wrapExternalContent()` 的安全标记完全依赖 LLM 能"看到并遵守"。

3. **Before-tool-call Hook 未被内置使用**：这个拦截点目前只走插件 hookRunner，核心安全层没有默认注册拦截器。

4. **无 context-aware 安全升级**：当上下文被压缩或接近上限时，安全策略不会自动收紧。

---

## 3. 方案设计：Tool Execution Gateway (TEG)

### 3.1 核心思路

在 LLM 输出的 tool call 和实际 `tool.execute()` 之间插入一个**程序级强制中间层**。这个中间层：

- **不依赖 LLM 是否记住安全规则**
- **对所有有副作用的工具调用进行分类、验证、审批**
- **根据运行时上下文（context 使用率、是否压缩、是否有外部内容）动态调整安全等级**

### 3.2 架构图

```
LLM 输出 tool_call
      │
      ▼
┌─────────────────────────────────────┐
│     Tool Execution Gateway (TEG)    │
│                                     │
│  ① classify  → safe / approval / blocked
│  ② validate  → 参数安全性 / 路径越界 / 命令危险性
│  ③ approve   → auto-allow / 推送审批 / 超时拒绝
│  ④ audit     → 记录决策 / 异常模式告警
│                                     │
└─────────────────────────────────────┘
      │
      ▼
   tool.execute()
```

### 3.3 工具风险分级

```
┌─────────────────────────────────────────────────────────┐
│  safe (自动通过)                                         │
│  read, web_search, memory_search, memory_get,           │
│  session_status, sessions_list, sessions_history        │
├─────────────────────────────────────────────────────────┤
│  needs_approval (需要审批)                               │
│  exec, write, edit, apply_patch, message,               │
│  sessions_send, sessions_spawn, cron, nodes             │
├─────────────────────────────────────────────────────────┤
│  blocked (默认禁止，需显式启用)                           │
│  elevated exec, dangerous node commands (camera.snap,   │
│  screen.record, sms.send 等)                            │
└─────────────────────────────────────────────────────────┘
```

> **注意**：分级应可通过配置文件自定义，不同部署场景需求不同。

### 3.4 Context-Aware 动态安全等级

针对 context overflow 问题，TEG 应根据运行时状态动态调整安全策略：

| 条件                                | 安全等级   | 行为                 |
| ----------------------------------- | ---------- | -------------------- |
| context 使用率 < 80%，无压缩历史    | `normal`   | 按分级表执行         |
| context 使用率 > 80% 或已发生过压缩 | `elevated` | 更多工具需要审批     |
| 高 context + 检测到外部不可信内容   | `lockdown` | 所有工具调用都需审批 |

伪代码：

```typescript
function resolveRuntimeSecurityLevel(params: {
  contextTokens: number;
  maxContextTokens: number;
  hasCompactedHistory: boolean;
  externalContentDetected: boolean;
}): "normal" | "elevated" | "lockdown" {
  const utilization = params.contextTokens / params.maxContextTokens;

  if (utilization > 0.8 || params.hasCompactedHistory) {
    if (params.externalContentDetected) {
      return "lockdown";
    }
    return "elevated";
  }

  return "normal";
}
```

### 3.5 审批交互流程

```
TEG 判定需审批
  │
  ├─ 有前端 UI / TUI → 推送审批请求，等待用户操作
  │   └─ 用户可选：allow-once / allow-always / deny
  │
  ├─ 仅有 Socket（现有 exec-approvals.sock）→ 复用现有协议
  │
  └─ 无审批通道 → 超时自动拒绝，返回安全提示给 LLM
```

可复用现有 `requestExecApprovalViaSocket()`（见 `src/infra/exec-approvals.ts:1478`），将其从仅限 exec 扩展到通用工具审批。

---

## 4. 实现路径

### 4.1 挂载点：扩展 `wrapToolWithBeforeToolCallHook`

现有的 `src/agents/pi-tools.before-tool-call.ts` 提供了完美的拦截点。当前它只走 plugin hookRunner，需要增加内置的 TEG 逻辑：

```typescript
// 改造后的执行流程：
async execute(toolCallId, params, signal, onUpdate) {
  // 1. 内置 TEG 检查（新增，硬编码，不可被插件跳过）
  const gatewayResult = await toolExecutionGateway.evaluate({
    toolName, params, runtimeSecurityLevel
  });
  if (gatewayResult.action === "deny") {
    throw new Error(gatewayResult.reason);
  }
  if (gatewayResult.action === "await_approval") {
    const decision = await requestApproval(gatewayResult.request);
    if (decision !== "allow-once" && decision !== "allow-always") {
      throw new Error("Tool call denied by user.");
    }
  }

  // 2. 插件 hook（现有逻辑，保留）
  const hookOutcome = await runBeforeToolCallHook({ toolName, params });
  if (hookOutcome.blocked) {
    throw new Error(hookOutcome.reason);
  }

  // 3. 执行
  return await originalExecute(toolCallId, params, signal, onUpdate);
}
```

### 4.2 建议实现优先级

| 优先级 | 任务                             | 说明                                        |
| :----: | -------------------------------- | ------------------------------------------- |
| **P0** | 内置 Tool Execution Gateway 核心 | 分类 + 验证 + 拦截，挂载到 before-tool-call |
| **P0** | Context-aware 安全等级           | 检测压缩/截断状态，动态收紧策略             |
| **P1** | 通用审批 Socket 协议             | 将 exec-approvals socket 扩展为通用工具审批 |
| **P1** | 前端 / TUI 审批 UI               | 展示待审批的工具调用，支持 allow / deny     |
| **P2** | 异常模式检测                     | 连续工具调用、参数异常、高频写操作告警      |
| **P2** | 审计日志                         | 所有 TEG 决策持久化，支持事后分析           |

---

## 5. 与"完全剥离"的对比

| 维度                  |  完全剥离系统操作   |    TEG 审批机制     |
| --------------------- | :-----------------: | :-----------------: |
| 安全性                |        ★★★★★        |        ★★★★☆        |
| 功能完整性            |        ★★☆☆☆        |        ★★★★★        |
| 用户体验              | ★★★★★（无审批打断） | ★★★☆☆（偶尔需审批） |
| 实现复杂度            |        ★☆☆☆☆        |        ★★★☆☆        |
| Context overflow 防护 |       不需要        |        ★★★★☆        |
| 可复用现有代码        |          —          |       ~60-70%       |

---

## 6. 待讨论事项

1. **功能精简的边界**：OpenClaw 现有功能远超我们的需求，在实施 TEG 之前，是否应先剥离不需要的模块（channels、多 agent chatroom、nodes 等），减小攻击面？

2. **审批 UX**：在移动端（WhatsApp/Telegram）场景下，审批交互如何设计？是否用 inline button 还是单独的管理通道？

3. **allowlist 的维护成本**：用户是否会因频繁审批而倾向于直接 `security: "full"`，反而降低安全性？是否需要"智能学习"自动扩展 allowlist？

4. **性能影响**：每次工具调用增加 TEG 检查，对响应延迟的影响是否可接受？（预估：纯程序检查 < 1ms，需审批时取决于用户响应速度）

5. **与功能精简的先后顺序**：是先精简再加 TEG，还是先加 TEG 再精简？建议先精简——减小代码量后 TEG 的实现和测试都更可控。

---

## 7. 参考

- Cursor 的沙箱权限模型：`required_permissions: ["full_network", "all"]`
- OpenClaw 现有 exec approvals：`~/.firstclaw/exec-approvals.json`
- OpenClaw 威胁模型：`docs/security/THREAT-MODEL-ATLAS.md`
