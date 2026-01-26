# AI Context Retrieval Plan (BM25/N-gram)

目标：在不依赖关键词意图分类的情况下，显著减少上下文体积，做到可控、可解释、可回放。以中文环境、旧电脑、低资源为前提，优先使用字符 n-gram + BM25（或 TF-IDF）检索与硬预算裁剪。

## 范围
- 覆盖 `bot_impl/ai-chat/` 的上下文拼装链路（executor/context-bus/memory/observer）。
- 引入轻量检索模块，支撑“候选块 -> 相关性排序 -> top-K”选择。
- 提供可验收的日志/调试入口，确保可观测。

## 非目标
- 不引入远程向量数据库或云端检索。
- 不做复杂意图分类器，不依赖关键词路由。

## 计划与验收标准

### 1) 现状基线与预算开关
任务：
- 在 `bot_impl/ai-chat/executor.js` 增加上下文构成日志（slice 名称、字符数、估算 token）。
- 在 `state.ai.context` 增加“每个 slice 的预算配置”（如 `budgetTokens` 或 `maxChars`）。
- 对所有 slice 增加统一的 `include` 开关与预算硬裁剪。

验收标准：
- 每次 AI 调用前能看到“上下文片段清单 + 估算 token + 预算限制”的日志。
- 修改 `state.ai.context.<slice>.include = false` 能完全移除该 slice。
- 超预算 slice 被裁剪且日志里可见裁剪结果。

### 2) 游戏快照分级（lite/detail）
任务：
- 在 `bot_impl/agent/observer.js` 增加 lite 快照（仅任务、位置、维度、时间、HP/饥饿、附近玩家）。
- 调整 `buildGameContext` 默认使用 lite；仅在需要时（显式触发）使用 detail。
- 为 lite/detail 定义各自的预算上限。

验收标准：
- 默认上下文里不包含 blocks/drops/详细 inv 列表（可通过日志或打印确认）。
- lite 快照输出字符数稳定低于 detail。
- 切换到 detail 时能看到完整快照内容。

### 3) 轻量检索模块（字符 n-gram + BM25/TF-IDF）
任务：
- 新建模块（建议：`bot_impl/ai-chat/retrieval/bm25.js`），提供：
  - `buildIndex(docs)`：为候选块建立 n-gram 统计。
  - `query(text, topK, minScore)`：返回排序后的候选块。
- 支持 2-gram/3-gram（默认 2-gram），并可配置。
- 只做内存级索引，不引入外部依赖。

验收标准：
- 用 5~10 条样本文本进行自测，query 能稳定返回语义相关文本。
- `topK` 生效：返回条数 <= K，按分数降序。
- `minScore` 生效：低相关返回空结果。

### 4) 记忆检索改造（长期记忆 + 对话记忆）
任务：
- 在 `bot_impl/ai-chat/memory.js` 的 `buildMemoryContext` 中引入检索模块。
- 记忆检索输出分两段：`长期记忆` 与 `对话记忆`，不要混在一段。
- 查询文本只使用“当前问题 + 最近 1~2 句对话 + 玩家名”，避免长 query。

验收标准：
- “不相关提问”时记忆段为空（或不出现）。
- “相关提问”时能返回 top-K 记忆条目，且顺序可解释（按分数）。
- 记忆段落有明确标签（`长期记忆:` / `对话记忆:`）。

### 5) 上下文候选块选择（非意图分类）
任务：
- 在 `bot_impl/ai-chat/executor.js` 把各 slice 作为候选块：
  - `context-bus` XML、`game snapshot`、`recent dialogue`、`memory`、`affordances`
- 对候选块计算相关度（BM25/TF-IDF），并按预算选 top-K。
- 如果候选块无分数（如系统规则），按固定优先级保留。

验收标准：
- 在同一输入下，候选块选择稳定、可复现（日志可对比）。
- 当预算较紧时，低分块被剔除，高分块保留。
- 系统规则/任务状态始终保留（即使预算紧张）。

### 6) 可观测性与调试入口
任务：
- 在 `bot_impl/ai-chat` 的 CLI handler 增加一个调试命令（例如 `ai ctx`）：
  - 输出候选块、分数、预算、最终选择结果。
- 在 `docs/ai-chat.md` 或新增文档中记录“上下文选择规则 + 调参说明”。

验收标准：
- CLI 命令可复用当前输入做一次离线“上下文选择模拟”。
- 文档里清晰写出可调参数、默认值、推荐范围。

## 验收场景清单（用于最终确认）
1) 随机闲聊：只出现“系统规则 + 极短对话 + 任务状态”，无游戏快照/记忆。
2) 询问位置/附近：只出现 lite 游戏快照，不出现长期记忆。
3) 询问过去事件：记忆段出现，且条目少于等于 top-K。
4) 预算极低：只有系统规则 + 任务状态被保留。
5) “不相关问题”：记忆段为空且无低相关噪声。

## 参数建议（默认值，后续可调）
- n-gram：2
- top-K：3~6
- minScore：0.05~0.15（按实际分数分布调整）
- lite 快照预算：<= 150 字
- 记忆段预算：<= 300~500 字
