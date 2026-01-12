# AI Chat Pipeline

`bot_impl/ai-chat.js` 负责装配 AI 聊天模块；真正的「上下文注入/Prompt 拼装」主要发生在：

- `bot_impl/ai-chat/executor.js`：构造 DeepSeek `messages[]`（system 只放 stable prefix；动态上下文统一用 user message 后置；玩家原始消息来自 `xmlCtx`）
- `bot_impl/ai-chat/context-bus.js`：把时序事件序列化成紧凑 XML（`<ctx>...</ctx>`）
- `bot_impl/ai-chat/memory.js`：长期记忆检索（`长期记忆: ...`）+ 对话摘要（`对话记忆：...`）
- `bot_impl/agent/observer.js`：游戏快照（`游戏: ...`）
- `bot_impl/prompts/ai-system.txt`：系统 Prompt（强制存在）

相关阅读：
- `docs/上下文缓存经济学.md`（Prompt cache / 前缀缓存：为什么“只追加”很重要）

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
>
> 为了提高 prompt cache 命中率，`messages[]` 按 **stable prefix + dynamic tail** 组织：
> - stable prefix：尽量不变（system policies + tool schemas + 静态协议）
> - dynamic tail：每轮变化（时间、游戏快照、最近聊天 XML、people/memory 召回等）

顺序：

**Stable prefix（缓存候选；system message）**

1. `systemPrompt()`（必有）：来自 `bot_impl/prompts/ai-system.txt`，并替换 `{{BOT_NAME}}`

**Dynamic tail（高动态；user message）**

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
7. `contextPrompt`（user）：`executor.buildContextPrompt(username)`，由三段拼接：
   - `当前对话玩家: <name>`
   - `xmlCtx`：`contextBus.buildXml({ maxEntries, windowSec, includeGaps:true })`（`state.ai.context.recentCount/recentWindowSec`）
   - `conv`：`memory.dialogue.buildPrompt(username)`，形如 `对话记忆：\n1. ...\n2. ...`
8. （可选）`inlinePrompt`（user）：仅少数内部调用会额外附加一段临时指令（如 plan mode、auto-look greet）；玩家对话不使用这段。

### 4.2 如何对齐“真实注入内容”

- 离线查看（不依赖 bot 在线）：`npm run inspect:context -- --player <name> [--query <text>] [--memory-limit N]`
  - 输出：`systemPrompt/metaCtx/peopleProfilesCtx/peopleCommitmentsCtx/memoryCtx/contextPrompt`；`gameCtx` 需要 bot 在线（用 `.ai ctx` 或 trace log）
  - 对比：加 `--compare` 会同一 query 跑 `keyword/v2/hybrid`（JSON 输出含 `compare.memory` + `compare.diff`）
  - Debug：加 `--debug` 会输出检索 `tokens/scoredTop/thresholds` 以及 `trace`（token 估算）
- 运行时查看（bot 在线）：`.ai ctx [player] [query...]`（打印 `metaCtx/gameCtx/chatCtx`，并尽量对齐注入的 `people/memory`）
  - 同时会打印 `stablePrefix.sig` 以及累计 `promptCache`（若 provider 返回 cached tokens 字段）

### 4.3 Prompt cache 约定（踩坑清单）

核心目标：让 provider 复用 stable prefix（system + tool schemas）对应的 KV cache。

禁止：
- 动态 system（把时间/进度/状态写进 system prompt）
- 编辑历史消息（改动 `messages[i]` 内容）
- 滑动窗口截断（删除旧消息/中间插入）
- 用摘要替换历史（导致前缀变化）

推荐：
- system prompt 只放稳定的 policies/协议（本仓库 `ai-system.txt` + `{{BOT_NAME}}` 替换）
- 动态状态统一放到 dynamic tail（user message）
- 需要控 token 时，优先“结束 session → 开新 session”或用子 Agent 隔离上下文（主会话只接收摘要结果）

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

---

*Version: 2.2 | Docs aligned to runtime prompt assembly*
