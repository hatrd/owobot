# AI Chat Pipeline

`bot_impl/ai-chat.js` 负责装配 AI 聊天模块；真正的「上下文注入/Prompt 拼装」主要发生在：

- `bot_impl/ai-chat/executor.js`：构造 DeepSeek `messages[]`（仅 `systemPrompt()` 保持为 system；其余动态上下文 + 玩家输入统一拼到单个 `user` message，便于复用 prompt cache）
- `bot_impl/ai-chat/context-bus.js`：把时序事件序列化成紧凑 XML（`<ctx>...</ctx>`）
- `bot_impl/ai-chat/memory.js`：长期记忆检索（`长期记忆: ...`）+ 对话摘要（`对话记忆：...`）
- `bot_impl/agent/observer.js`：游戏快照（`游戏: ...`）
- `bot_impl/prompts/ai-system.txt`：系统 Prompt（强制存在）

## 1. 状态结构

| 字段 | 说明 |
|------|------|
| `state.ai` | API 配置 (model, baseUrl, budgets, limits) |
| `state.aiContextBus` | **统一上下文总线**（运行时内存，重启不保留；见 `docs/context-bus.md`） |
| `state.aiRecent` | 最近聊天行（legacy store；用于会话摘要与部分逻辑） |
| `state.aiDialogues` | 对话摘要（max 60；注入到 prompt 的“对话记忆”） |
| `state.aiMemory.entries` | 长期记忆条目（注入到 prompt 的“长期记忆”） |
| `state.aiPulse` | 会话激活追踪（60s 窗口 + 5s 延迟跟进） |
| `state.aiStats/aiSpend` | 用量与预算 |

## 2. 触发流程 (`handleChat`)

```
玩家消息 → 触发词检测 (bot名前3字符) → 预处理
    ├── 立即命令: 下坐/停止 → actions 直接执行
    ├── 记忆写入/撤销: "记住..." / "忘记..." / "别叫我..." → 写入或禁用长期记忆
    └── LLM 调用: classifyIntent → callAI → 工具执行或文本回复
```

## 3. 会话激活与跟进

- `activateSession(username)`: 触发后保持 60s 活跃窗口
- 活跃窗口内：若玩家继续说话，5s 沉默后会触发“跟进调用”
- 触发词重新出现延长会话

## 4. 上下文构建

### 4.1 真正注入到 LLM 的顺序（`executor.callAI()`）

> 注意：这里说的是“LLM 看到的 messages[]”。工具 schema 通过 function-calling 传给模型，不在 prompt 文本里拼接。

顺序（1 条 system + 1 条 user；目标是让 system prompt 尽可能稳定以命中 provider 的 prompt cache）：

1. `systemPrompt()`（必有）：来自 `bot_impl/prompts/ai-system.txt`，并替换 `{{BOT_NAME}}`
2. `user` message：按“固定片段 + 候选片段 + userPrompt”拼接（中间空行分隔），由 `buildContextSelection()` 完成：
   - 固定片段（始终保留）：
     1) `metaCtx`：`现在是北京时间 ...，你在 ShikiMC 服务器中。服主为 Shiki。`
     2) `targetCtx`：`当前对话玩家: <name>`
     3) `taskCtx`：`任务:<name>(玩家命令|自动)`（若存在）
   - 候选片段（BM25 相关度排序 + top-K 预算裁剪）：
     1) `contextBus`：`contextBus.buildXml({ maxEntries, windowSec, includeGaps:true })`
     2) `gameCtx`：`observer.toPrompt(snapshot)`，默认 lite（无 blocks/drops/详细 inv）
     3) `memoryCtx`：`memory.longTerm.buildContext({ query: memoryQuery, actor })`，包含 `长期记忆:` + `对话记忆:`
     4) `affordances`：可用动作建议（由 `observer.affordances()` 生成）
     5) `peopleProfiles/peopleCommitments`
   - 预算与开关：`state.ai.context.<slice>.include/maxChars`；全局开关 `state.ai.context.include=false` 会同时关掉 `contextBus`
   - 选择参数：`state.ai.context.selection.topK/minScore/nGram`
   - `userPrompt`：本轮玩家输入（或内部调用的临时指令，例如 plan mode、auto-look greet）

补充：`memoryCtx` 关键细节
- Query：`buildMemoryQuery({ username, message, recentChat })` → 只包含“当前问题 + 最近1~2句 + 玩家名”
- Mode：`state.ai.context.memory.mode=bm25|keyword|v2|hybrid`（默认 `bm25`）
- BM25 参数：`nGram`、`bm25MinScore`、`dialogueMax/dialogueMinScore`
- v2/hybrid 仍可用（`minScore/minRelevance`、`wRelevance/wRecency/wImportance` 等）

### 4.2 如何对齐“真实注入内容”

- 离线查看（不依赖 bot 在线）：`npm run inspect:context -- --player <name> [--query <text>] [--memory-limit N]`
  - 输出：`systemPrompt/metaCtx/peopleProfilesCtx/peopleCommitmentsCtx/memoryCtx/contextPrompt`；`gameCtx` 需要 bot 在线（用 `.ai ctx` 或 trace log）
  - 对比：加 `--compare` 会同一 query 跑 `keyword/v2/hybrid`（JSON 输出含 `compare.memory` + `compare.diff`）
  - Debug：加 `--debug` 会输出检索 `tokens/scoredTop/thresholds` 以及 `trace`（token 估算）
- 运行时查看（bot 在线）：`.ai ctx [player] [query...]`（离线模拟一次上下文选择，打印候选块/分数/预算/最终选择结果）

## 5. 对话记忆

- 会话结束/重启/过期时：从 `state.aiRecent` 的 seq 区间抽取聊天行，用一个小模型调用生成“≤40字”摘要（目标是≤40字，但不强制）
- 存储：`state.aiDialogues`（max 60，持久化到 `data/ai-memory.json`）
- 注入：`memory.longTerm.buildContext()` 生成 `对话记忆:` 段（BM25 过滤）
- 选取策略：候选来自 `state.aiDialogues`（时间桶预筛）→ `dialogueMax/dialogueMinScore` 过滤

## 6. CLI 命令

| 命令 | 说明 |
|------|------|
| `.ai on/off` | 启用/禁用 AI |
| `.ai ctx [player] [query...]` | 离线模拟一次上下文选择；打印候选块/分数/预算/最终选择结果（含 memoryRefs） |
| `.ai context show` | 打印 `state.ai.context` |
| `.ai context recent N` | 设置注入 `xmlCtx` 的最大条数（下限被 clamp 到 ≥1） |
| `.ai context window SEC` | 设置 `xmlCtx` 的窗口秒数（CLI 下限 10s） |
| `.ai context recentmax N` | 设置 `state.aiRecent` 存储上限（用于会话摘要/部分逻辑） |
| `.ai dialog [clear|full|<username>]` | 查看/清空对话摘要 |
| `.ai budget show` | 查看预算与用量 |
| `.ai clear` | 只清空 `state.aiRecent`（不清 `state.aiContextBus`） |

## 7. 热重载

- `registerCleanup` 清理所有监听器和定时器
- `state.aiContextBus/state.aiRecent/...` 都在 shared state 内，跨热重载保持；进程重启会丢失 `state.aiContextBus/state.aiRecent`
- AbortController 防止异步泄漏

---

*Version: 2.3 | Docs aligned to runtime prompt assembly*
