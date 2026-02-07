# AI Chat Pipeline

`bot_impl/ai-chat.js` 负责装配 AI 聊天模块；真正的「上下文注入/Prompt 拼装」主要发生在：

- `bot_impl/ai-chat/executor.js`：构造 DeepSeek `messages[]`（以 system 注入为主；玩家原始消息来自 `xmlCtx`，不再额外注入 `user`）
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

补充：`callAI` 采用有上限的工具循环（读取 `state.ai.maxToolCallsPerTurn/maxToolCalls`，默认 6 次、最大 16 次）：每轮把工具执行结果（含 observe 结构化摘要）回填到下一轮上下文，让模型继续决策。若 loop 进行中收到新玩家输入，会触发中断并把增量消息实时注入当前 loop；达到上限后返回阶段性总结，避免 observe 复读/循环。

## 3. 会话激活与跟进

- `activateSession(username)`: 触发后保持 60s 活跃窗口
- 活跃窗口内：若玩家继续说话，5s 沉默后会触发“跟进调用”
- 触发词重新出现延长会话

## 4. 上下文构建

### 4.1 真正注入到 LLM 的顺序（`executor.callAI()`）

> 注意：这里说的是“LLM 看到的 messages[]”。工具 schema 通过 function-calling 传给模型，不在 prompt 文本里拼接。

顺序（全部为 system message）：

1. `systemPrompt()`（必有）：来自 `bot_impl/prompts/ai-system.txt`，并替换 `{{BOT_NAME}}`
2. `metaCtx`（几乎必有）：`现在是北京时间 ...，你在 ShikiMC 服务器中。服主为 Shiki。`
3. `gameCtx`（可关）：`bot_impl/agent/observer.toPrompt(snapshot)`，形如 `游戏: 位置:... | 维度:... | HP:... | 背包:...`
   - 开关：`state.ai.context.game.include=false`
   - 参数：`invTop/nearPlayerRange/nearPlayerMax/dropsRange/dropsMax`（hostileRange 固定 24）
4. `peopleProfilesCtx`（可无）：`bot_impl/ai-chat/people.buildAllProfilesContext()` 输出（XML：`<people>...<profile n=...>...</profile>...</people>`，会注入**全部**已录入画像的玩家）
5. `peopleCommitmentsCtx`（可无）：`bot_impl/ai-chat/people.buildAllCommitmentsContext()` 输出（`承诺（未完成）：...`，会注入全部 pending 承诺）
6. `memoryCtx`（可关）：`memory.longTerm.buildContext({ query: 玩家消息, withRefs:true })`
   - 开关：`state.ai.context.memory.include=false`
   - 数量：默认最多 6 条（`state.ai.context.memory.max`）；带 `refs` 但 refs 不注入，只用于反馈链路
   - Query：`executor.callAI()` 先用 `buildMemoryQuery({ username, message, recentChat, worldHint })` 构造会话语境查询，再传给 `buildContext({ query: memoryQuery, actor: username })`
   - Mode：`state.ai.context.memory.mode=keyword|v2|hybrid`
     - `keyword`：关键词/触发词命中；**无命中时会 recent fallback**（补最近记忆）
     - `v2`：多信号打分（relevance/recency/importance）+ `minScore/minRelevance` 阈值裁剪 + 去重；**宁缺毋滥，无 recent fallback**
     - `hybrid`：稀疏（lexical）+ 稠密（embeddings，可选）RRF 融合后再按 v2-style 打分；**宁缺毋滥，无 recent fallback**
   - 关键可调参（v2/hybrid）：`minScore/minRelevance`、`wRelevance/wRecency/wImportance`、`recencyHalfLifeDays`、`importanceCountSaturation`
   - Embeddings（hybrid）：`embeddingProvider` 为空则自动退化为 sparse-only；向量存到 `data/ai-memory-embeddings.json`（可重建，不膨胀 `data/ai-memory.json`）
   - Backfill：
     - 命名空间：`node scripts/memory-backfill-v2.js --dry-run` / `--apply`（写入前会生成 `.bak.*`）
     - 向量：`node scripts/memory-embeddings-backfill.js --provider hash --dim 64 --dry-run` / `--apply`
   - Namespacing：长期记忆条目含 `scope=player|global` + `owners[]`；召回会按 `actor` 强过滤，避免跨玩家污染
   - Feedback：`refs` 由反馈链路使用，显式正/负反馈会影响 `count/effectiveness`，并更新 `lastPositiveFeedback` 参与 recency/decay
   - 格式：`长期记忆: 1. ... | 2. ...`
   - 撤销：玩家说“忘记/删除记忆/别叫我…”会把匹配记忆标记为 disabled（不再注入）
7. `contextPrompt`（system）：`executor.buildContextPrompt(username)`，由三段拼接：
   - `当前对话玩家: <name>`
   - `xmlCtx`：`contextBus.buildXml({ maxEntries, windowSec, includeGaps:true })`（`state.ai.context.recentCount/recentWindowSec`）
   - `conv`：`memory.dialogue.buildPrompt(username)`，形如 `对话记忆：\n1. ...\n2. ...`
8. （可选）`inlinePrompt`（system）：仅少数内部调用会额外附加一段临时指令（如 plan mode、auto-look greet）；玩家对话不使用这段。

### 4.2 如何对齐“真实注入内容”

- 离线查看（不依赖 bot 在线）：`npm run inspect:context -- --player <name> [--query <text>] [--memory-limit N]`
  - 输出：`systemPrompt/metaCtx/peopleProfilesCtx/peopleCommitmentsCtx/memoryCtx/contextPrompt`；`gameCtx` 需要 bot 在线（用 `.ai ctx` 或 trace log）
  - 对比：加 `--compare` 会同一 query 跑 `keyword/v2/hybrid`（JSON 输出含 `compare.memory` + `compare.diff`）
  - Debug：加 `--debug` 会输出检索 `tokens/scoredTop/thresholds` 以及 `trace`（token 估算）
- 运行时查看（bot 在线）：`.ai ctx [player] [query...]`（打印 `metaCtx/gameCtx/chatCtx`，并尽量对齐注入的 `people/memory`）

## 5. 对话记忆

- 会话结束/重启/过期时：从 `state.aiRecent` 的 seq 区间抽取聊天行，用一个小模型调用生成“≤40字”摘要（目标是≤40字，但不强制）
- 存储：`state.aiDialogues`（max 60，持久化到 `data/ai-memory.json`）
- 注入：`memory.dialogue.buildPrompt(username)` → `对话记忆：\n...`
- 选取策略：优先包含该玩家的记录，并按时间桶挑选（3d/7d/15d/30d，各自有上限）

## 6. CLI 命令

| 命令 | 说明 |
|------|------|
| `.ai on/off` | 启用/禁用 AI |
| `.ai ctx [player] [query...]` | 打印对齐 LLM 注入片段：`metaCtx/gameCtx/chatCtx`；若可用还会打印 `peopleProfilesCtx/peopleCommitmentsCtx`，并在提供 `player+query` 时额外打印 `memoryCtx/memoryRefs` |
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

## 8. 进程守护（推荐）

- 推荐通过 `npm run bot:watch` 启动（`scripts/bot-watch.js`）。
- watcher 负责拉起 `bot.js`（继承 stdin/stdout）并在进程异常退出时自动重启。
- 当 `bot.js` 运行在 watcher 下时，控制面 `proc.restart` 只会优雅退出当前进程，由 watcher 完成重拉起，避免“自重启脱离原终端”。

---

*Version: 2.2 | Docs aligned to runtime prompt assembly*
