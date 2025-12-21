# AI Chat Pipeline

`bot_impl/ai-chat.js` 实现触发式 DeepSeek 对话、会话跟进、长期记忆。

## 1. 状态结构

| 字段 | 说明 |
|------|------|
| `state.ai` | API 配置 (model, baseUrl, budgets, limits) |
| `state.aiContextBus` | **统一上下文总线** (见 `docs/context-bus.md`) |
| `state.aiPulse` | 会话激活追踪 (activeUsers) |
| `state.aiMemory` | 长期记忆 |
| `state.aiDialogues` | 对话摘要 (max 60) |
| `state.aiStats/aiSpend` | 用量与预算 |

## 2. 触发流程 (`handleChat`)

```
玩家消息 → 触发词检测 (bot名前3字符) → 预处理
    ├── 立即命令: 下坐/停止 → actions 直接执行
    ├── 记忆写入: "记住..." → 入队重写任务
    └── LLM 调用: classifyIntent → callAI → 工具执行或文本回复
```

## 3. 会话激活与跟进

- `activateSession(username)`: 触发后保持 1 分钟关注
- 激活期内非触发消息自动跟进，LLM 可输出 `SKIP` 跳过
- 触发词重新出现延长会话

## 4. 上下文构建

**ContextBus 统一所有事件**:

```javascript
const xmlCtx = contextBus.buildXml({
  maxEntries: 50,
  windowSec: 86400, // 24h，用 gap 标记跨时段空窗
  includeGaps: true
})
```

LLM 收到的上下文顺序:
1. `systemPrompt()` — 行为规范
2. `buildGameContext()` — 游戏快照 (位置/血量/背包)
3. `buildIdentityContext()` — minimal-self 身份画像
4. `buildMemoryContext()` — 长期记忆检索
5. `contextBus.buildXml()` — 聊天 + 事件时序流
6. 用户消息

## 5. 对话记忆

- 会话结束时生成 ≤40 字摘要存入 `state.aiDialogues`
- `buildConversationMemoryPrompt()` 按时间桶选取历史摘要
- 持久化至 `data/ai-memory.json`

## 6. CLI 命令

| 命令 | 说明 |
|------|------|
| `.ai on/off` | 启用/禁用 AI |
| `.ai budget` | 查看预算 |
| `.ai context recent N` | 设置上下文条数 |
| `.ai clear` | 清空上下文 |

## 7. 热重载

- `registerCleanup` 清理所有监听器和定时器
- `state.aiContextBus` 跨重载保持
- AbortController 防止异步泄漏

---

*Version: 2.0 | ContextBus 重构*
