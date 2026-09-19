# AI Chat Pipeline

`bot_impl/ai-chat.js` 负责装配 AI 聊天模块；真正的「上下文注入/Prompt 拼装」主要发生在：

- `bot_impl/ai-chat/executor.js`：构造 DeepSeek `messages[]`（以 system 注入为主；玩家原始消息来自 `xmlCtx`，不再额外注入 `user`）
- `bot_impl/ai-chat/context-bus.js`：把时序事件序列化成紧凑 XML（`<ctx>...</ctx>`）
- `bot_impl/ai-chat/memory.js`：长期记忆检索（`长期记忆: ...`）+ 对话摘要（`对话记忆：...`）
- `bot_impl/agent/observer.js`：游戏快照（`游戏: ...`）
- `bot_impl/prompts/ai-system.txt`：系统 Prompt（强制存在）

NVIDIA Nemotron 的 `/v1/chat/completions` 请求使用官方
`chat_template_kwargs` 参数控制思考：默认发送
`{"enable_thinking":false}`，只有显式设置 `AI_REASONING_EFFORT=low/high`
才启用对应模式。出站文本始终读取 `choices[0].message.content`；
`reasoning_content` 等字段不会发送到 Minecraft 聊天。

## 1. 状态结构

| 字段 | 说明 |
|------|------|
| `state.ai` | API 配置 (model, baseUrl, path, budgets, limits)；`path` 决定请求体契约：`/responses` 使用 `input/max_output_tokens`，其它路径使用 chat-completions 的 `messages/max_tokens` |
| `state.aiContextBus` | **统一上下文总线**（运行时内存，重启不保留；见 `docs/context-bus.md`） |
| `state.aiRecent` | 最近聊天行（legacy store；用于会话摘要与部分逻辑） |
| `state.aiDialogues` | 对话摘要（max 60；注入到 prompt 的“对话记忆”） |
| `state.aiMemory.entries` | 长期记忆条目（注入到 prompt 的“长期记忆”） |
| `state.aiPulse` | 会话激活追踪（60s 窗口 + 5s 延迟跟进） |
| `state.aiStats/aiSpend` | 用量与预算 |
| `state.ai.externalCalls` | 外部 AI 调用门控；默认仅允许 `main_chat`，后台摘要/记忆/自省/auto-look greet 会被阻断，除非显式开启 background 或 allowSources |
| `state.aiCallMonitor` | 外部 AI 调用监控；记录 source/status/model/path/schema/bodyKeys/duration，并累计 started/ok/error/blocked |

## 2. 触发流程 (`handleChat`)

```
玩家消息 → 触发词检测 (bot名前3字符) → 预处理
    ├── 精确命令: /stop、/reset、/dismount → actions 直接执行
    └── 自然语言: normalizeIntent() 返回 unknown → callAI → 模型选择工具或文本回复
```

入站玩家身份统一由 `bot_impl/incoming-chat.js` 在 Mineflayer 边界解析：优先使用 `message` 事件携带的结构化 sender UUID 对齐 `bot.players`，当服务器聊天插件不再渲染 `<玩家名> 内容` 时补发标准 `chat` 事件并按 `<玩家名> 内容` 输出日志；同一结构化 `playerChat` 不再进入 system-message 分支，避免上下文同时出现 `<p>` 与重复 `<s>`。文本格式解析仅保留为旧服兼容回退，不从自然语言猜玩家身份。

`classifyIntent` 和自然语言本地查询捷径已移除。未知意图使用完整工具目录，由主聊天模型通过结构化工具调用判定语义，不额外请求一次分类模型。`normalizeIntent` 只接受显式对象；内部已知的 greet/plan/query/action 仍可使用窄上下文。`chatdry` 完全离线，返回 unknown 与可用工具，不伪装成理解了输入。

`callAI` 使用有上限的工具循环（默认 6 次、最大 16 次），相同工具和参数的重复调用会短路。unknown/action 的观察结果回填给模型；不会自动追加 pickup。显式 query/chat 的只读结果可直接结束。确定性动作、发送消息和记忆写入完成后结束本轮；更长规划由 plan_mode 推进。pending 消息可中断正在进行的模型请求并注入工具循环。

每轮先扣除工具 schema token，再裁剪上下文。补齐参数后，model_context 总输入预算为 12000，plan_context 为 8000，既有 chat/task 为 5000、局部观察为 3600。完整目录会提高自然语言主线的输入成本；后续可通过显式工具目录查询缩减，不能重新用关键词猜意图。

模型工具决策记录在 `state.aiToolDecisions`（最多 100 条，单次参数 JSON 最大 32 KiB），并写入 `ai.tool.decision` / `ai.tool.result` 日志，保留 seq、actor、tool、args、时间和返回结果，event 证据不受普通日志级别过滤。status=returned 表示执行器返回，业务成功与否仍以工具结果为准。记忆写入与撤销分别通过 write_memory / forget_memory，持久化由记忆服务负责。
主线对话的 completion 预算也按 context profile 分档，而不是所有请求都预留 `state.ai.maxTokensPerCall`：greet≤160、普通聊天/行动/tool loop≤640、plan≤768，并继续受 `state.ai.maxTokensPerCall` 硬上限约束；预算预检按实际分档后的 `max_tokens` 估算，避免所有请求都按 1024 completion 虚高计费预留。

工具 schema 不再全量发送给每个工具轮次。`executor` 只根据结构化 `intent.topic/kind` 选择本轮需要的工具簇：例如观察/拾取类请求只发送 `say/feedback/skip/observe_detail/pickup/collect` 等少量工具；普通聊天也会暴露基础回复/观察/记忆/计划工具，避免模型在混合聊天+动作请求中按系统提示手搓不存在的工具名；普通 `kind=action` 默认带观察、移动、基础物品/容器操作，钓鱼/喂动物/采矿/耕作等专门工具留给明确 topic 或计划模式；计划模式才发送更宽的工具集。
意图分类里的动作判定只接受明确动作词（如攻击/追击/清怪/击杀/打怪/防守等），避免“打扰一下/打算/打字”这类普通聊天因为单字“打”误进 task profile，额外携带游戏上下文和工具 schema。
主线聊天和行动/task profile 都注入群聊人物画像与全局 pending 承诺；Minecraft 公屏上下文依赖多玩家关系，不按当前发言玩家裁剪。

外部 AI 调用统一走 `ai-chat/call-monitor.js`。默认策略为 `allowSources=["main_chat"]` 且 `allowBackground=false`，所以玩家触发的主线对话可以调用模型，`startup_probe`、`overflow_summary`、`memory_rewrite`、`conversation_summary`、`dialogue_aggregation`、`people_inspector`、`introspection`、`auto_look_greet` 等旁路线只记录为 blocked，不会真正发出请求。所有未显式传入 `AbortSignal` 的 monitor 调用都会继承 `state.ai.timeoutMs`（默认 30000ms），后台请求不会无限挂起；记忆改写遇到调用门控或永久 HTTP 错误时不会重试。后台记忆/摘要类请求在显式放开后也会先走 `.ai budget` 预检，并把 provider usage 写入 `state.aiSpend`，避免预算只统计主线聊天。需要临时放开时用 `.ai calls background on`，它只放开默认后台源（`conversation_summary`、`memory_rewrite`、`overflow_summary`）；`dialogue_aggregation`、`people_inspector`、`introspection`、`auto_look_greet` 等二级/主动 LLM 源必须显式加入 `allowSources`，防止一次开关触发连锁调用。用 `.ai calls` / `.ai calls recent` 观察实际调用；recent 行会显示 `path` 与 `schema`，用于定位 provider 契约错误（例如 `/v1/responses` 必须是 `schema=responses`，不能继续发送 `messages`）。
`auto_look_greet` 即使被显式放开，单个玩家的成功、空回复或 provider 错误都会进入 10 分钟 cooldown，避免附近视线事件在上游异常时每隔几秒重复触发外部请求。
`introspection` 即使被显式放开，也只有在近期存在模型级反馈信号（非 `ENGAGEMENT/IGNORE`）或动作结果样本时才调用模型；无证据或仅有冷场/参与度信号时直接走本地 fallback，避免空数据、手动触发或紧急冷场自省消耗外部调用。手动/紧急自省在有显式反馈证据时仍可使用模型。

## 2.1 LLM 输出回放

解析/出站文本类问题必须优先做可回放测试：把生产日志里模型实际返回的文本作为 fixture 输入 executor/pulse 边界，断言 `bot.chat()` 的每一条输出。不要只测小 parser，也不要依赖 `chatdry` 复现模型输出；`chatdry` 是离线路由/工具边界预览，不会调用生产 LLM。

当前关键回归：

- `__tests__/ai-chat-text-tool-syntax.test.js`：回放 `say{"steps":["没发呆喵！","刚刚在想事情啦~"]}`，期望输出两条纯聊天，不允许泄漏 `say{}`；回放 `skip{}`，期望不产生任何公屏输出。

## 3. 会话激活与跟进

- `activateSession(username)`: 触发后保持 60s 活跃窗口
- 活跃窗口内：若玩家继续说普通聊天，先进入静默合并窗口，默认 5s（可用 `state.ai.followupDelayMs` 覆盖）后触发一次“跟进调用”；窗口内多句 followup 会合并成一次 `main_chat`，并在发起外部请求前复用 `state.ai.limits` 频率门，避免一句一调用或纯 followup 绕过限流。flush 保留完整批次交给模型判断，不再用关键词剥离查询。成功的主线 LLM 轮都会计入频率统计，即使模型只调用了 `say`/工具而没有返回文本 reply。自动推进的 plan step 也复用同一频率门，限流时直接停止计划，避免一次 `plan_mode` 继续放大成多次主线外部调用。只有精确的 /stop、/reset、/dismount 命令立即处理；自然语言停止、查询、记忆请求均走主模型。
- 触发词重新出现延长会话

## 4. 上下文构建

### 4.1 真正注入到 LLM 的顺序（`executor.callAI()`）

> 注意：这里说的是“LLM 看到的 messages[]”。动作工具 schema 通过 function-calling 传给模型，不在 prompt 文本里拼接，且会按结构化 intent 分片发送；`say{...}` 和 `skip{}` 是系统 prompt 明示的短回复控制语法，若模型把它们作为纯文本返回，`executor` 会按精确的 `<工具名>{JSON}` 结构解析处理，避免原样发到公屏。

顺序（全部为 system message）：

1. `systemPrompt()`（必有）：来自 `bot_impl/prompts/ai-system.txt`，并替换 `{{BOT_NAME}}`
2. `metaCtx`（几乎必有）：`现在是北京时间 ...，你在 ShikiMC 服务器中。服主为 Shiki。`
3. `gameCtx`（可关）：`bot_impl/agent/observer.toPrompt(snapshot)`，形如 `游戏: 位置:... | 维度:... | HP:... | 背包:...`
   - 开关：`state.ai.context.game.include=false`
   - 参数：`invTop/nearPlayerRange/nearPlayerMax/dropsRange/dropsMax`（hostileRange 固定 24）
4. `peopleProfilesCtx`（可无）：`bot_impl/ai-chat/people.buildAllProfilesContext()` 输出（XML：`<people>...<profile n=...>...</profile>...</people>`，主对话注入群聊人物画像；Minecraft 公屏对话常依赖多玩家关系，不按当前玩家裁剪）
5. `peopleCommitmentsCtx`（可无）：`bot_impl/ai-chat/people.buildAllCommitmentsContext()` 输出（`承诺（未完成）：...`，主对话注入全局 pending 承诺）
6. `memoryCtx`（可关）：`memory.longTerm.buildContext({ query: 玩家消息, withRefs:true })`
   - 开关：`state.ai.context.memory.include=false`
   - 数量：默认最多 6 条（`state.ai.context.memory.max`）；带 `refs` 但 refs 不注入，只用于反馈链路
   - Query：`executor.callAI()` 先用 `buildMemoryQuery({ username, message, recentChat, worldHint })` 构造会话语境查询，再传给 `buildContext({ query: memoryQuery, actor: username })`
   - Mode：`state.ai.context.memory.mode=v2|keyword`，默认 `v2`
     - `v2`：多信号打分（relevance/recency/importance）+ `minScore/minRelevance` 阈值裁剪 + 去重；**宁缺毋滥，无 recent fallback**
     - `keyword`：显式 legacy 模式，关键词/触发词命中；**无命中时会 recent fallback**（补最近记忆）
   - 关键可调参（v2）：`minScore/minRelevance`、`wRelevance/wRecency/wImportance`、`recencyHalfLifeDays`、`importanceCountSaturation`
   - Backfill：
     - 命名空间：`node scripts/memory-backfill-v2.js --dry-run` / `--apply`（写入前会生成 `.bak.*`）
   - Namespacing：长期记忆条目含 `scope=player|global` + `owners[]`；召回会按 `actor` 强过滤，避免跨玩家污染
   - Feedback：`refs` 由反馈链路使用，显式正/负反馈会影响 `count/effectiveness`，并更新 `lastPositiveFeedback` 参与 recency/decay
   - 格式：`长期记忆: 1. ... | 2. ...`
   - 撤销：模型在理解玩家撤销请求后调用 forget_memory{query}，只禁用当前玩家拥有的匹配记忆（不再注入）
7. `contextPrompt`（system）：`executor.buildContextPrompt(username)`，由三段拼接：
   - `当前对话玩家: <name>`
   - `xmlCtx`：`contextBus.buildXml({ maxEntries, windowSec, includeGaps:true })`（`state.ai.context.recentCount/recentWindowSec`）；默认注入视图会截短过长玩家行，并限制已发给游戏的 bot/tool echo（各保留最近 3 条，单条也截短），只压 prompt，不丢 `state.aiContextBus` 原始记录；profile 的 recent/window 是场景上限，用户显式设置更小值时取更小值，`recentCount=0` 时只保留当前玩家锚点，不注入历史聊天
   - `conv`：`memory.dialogue.buildPrompt(username)`，形如 `对话记忆：\n1. ...\n2. ...`
8. （可选）`inlinePrompt`（system）：仅少数内部调用会额外附加一段临时指令（如 plan mode、auto-look greet）；玩家对话不使用这段。

这些段在进入 provider 请求前会统一过 `maxInputTokens` 裁剪；带工具的请求会先为本轮 tool schema 预留输入预算，剩余预算再分给 messages。`systemPrompt/metaCtx/inlinePrompt` 是保留段；`gameCtx/peopleProfilesCtx/peopleCommitmentsCtx/memoryCtx/contextPrompt` 是可裁剪段，并有各自的默认 token 份额和最低保留份额，避免前面的长段挤掉当前玩家/对话摘要锚点。裁剪标记会留在对应 system message 内，内部预算字段不会发送给 provider。

### 4.2 如何对齐“真实注入内容”

- 离线查看（不依赖 bot 在线）：`npm run inspect:context -- --player <name> [--query <text>] [--memory-limit N]`
  - 输出：`systemPrompt/metaCtx/peopleProfilesCtx/peopleCommitmentsCtx/memoryCtx/contextPrompt`；`gameCtx` 需要 bot 在线（用 `.ai ctx` 或 trace log）
  - 对比：加 `--compare` 会同一 query 跑 `keyword/v2`（JSON 输出含 `compare.memory` + `compare.diff`）
  - Debug：加 `--debug` 会输出检索 `tokens/scoredTop/thresholds` 以及 `trace`（token 估算）
- 运行时查看（bot 在线）：`.ai ctx [player] [query...]`（打印 `metaCtx/gameCtx/chatCtx`，并尽量对齐注入的 `people/memory`）

## 5. 对话记忆

- 会话结束/重启/过期时：从 `state.aiRecent` 的 seq 区间抽取聊天行；4 行以内且总文本不超过约 240 字的短会话直接生成本地摘要，不调用外部模型，长会话才用小模型生成“≤40字”摘要（目标是≤40字，但不强制）。
- 会话摘要发给外部模型前会压缩聊天摘录：最多保留 48 行、单行约 100 字、摘录约 3200 字；单轮 summary 队列最多尝试 2 次外部模型调用，超出后改用本地摘要，避免积压会话一次性追账；短会话走本地摘要并直接跳过 `people_inspector`，规则命中的画像/承诺由本地 patch 落盘，不再为同一段短聊天追加 LLM 抽取；显式放开 `people_inspector` 时只发送最多 48 行、单行约 120 字、摘录约 3000 字，并只携带一份字段级裁剪的画像/承诺 JSON 快照（profile≈180 字、commitment≈160 字、每类≤12 条），输出预算固定 256 tokens，且共享 summary 队列的单轮外部调用预算。
- 显式放开 `dialogue_aggregation` 时，小时/日/周聚合只发送头尾最多 24 条既有摘要，单条约 80 字、摘要列表约 2200 字内，输出预算固定 96 tokens；单轮聚合最多尝试 2 次外部模型调用，本地低信号聚合不占用这 2 次模型预算，积压窗口留到后续轮次继续处理，避免历史堆积后一次性追账。
- `state.aiRecent` 溢出时的 `overflow_summary` 只在后台源被允许时触发；请求会压到最近 40 行、单行 80 字、prompt 约 2200 字内，输出预算固定 96 tokens，避免为 20-40 字摘要预留大额 completion。同一时间只保留 1 个 provider 摘要请求，重叠溢出会写本地短摘要，避免聊天爆量时并发追账。
- `memory_rewrite` 服务仍可处理已有后台队列，但聊天入口不再按关键词入队或本地解析坐标落盘；新请求由主模型显式调用 write_memory 保存。
- 存储：`state.aiDialogues`（max 60，持久化到 `data/ai-memory.json`）；raw 摘要保存 `summaryKey=username:startSeq:endSeq`，同一会话 seq 窗口已保存后不会再次排队调用外部 summary，避免 expire/reset/restart 重复触发。
- 注入：`memory.dialogue.buildPrompt(username)` → `对话记忆：\n...`
- 选取策略：优先包含该玩家的记录，并按时间桶挑选（3d/7d/15d/30d，各自有上限）

## 6. CLI 命令

| 命令 | 说明 |
|------|------|
| `.ai on/off` | 启用/禁用 AI |
| `.ai env reload [~/.bashrc]` | source 指定 rc（默认 `~/.bashrc`）后，重载 `DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_PATH(或 AI_CHAT_PATH/DEEPSEEK_CHAT_PATH) / AI_MODEL(或 DEEPSEEK_MODEL)` 到运行态，并清除旧的 path fallback/probe 状态（别名：`.ai reloadenv`） |
| `.ai ctx [player] [query...]` | 打印对齐 LLM 注入片段：`intent/contextProfile/metaCtx/gameCtx/chatCtx`；主线对话使用全局 `peopleProfilesCtx/peopleCommitmentsCtx`，并在提供 `player+query` 时额外打印 `memoryCtx/memoryRefs` |
| `.ai context show` | 打印 `state.ai.context` |
| `.ai context off` | 关闭 `contextPrompt` 的历史聊天注入；只保留当前玩家锚点，profile 不会重新打开它 |
| `.ai context recent N` | 设置注入 `xmlCtx` 的最大条数；`0` 表示不注入历史聊天，只保留当前玩家锚点 |
| `.ai context window SEC` | 设置 `xmlCtx` 的窗口秒数（CLI 下限 10s） |
| `.ai context recentmax N` | 设置 `state.aiRecent` 存储上限（用于会话摘要/部分逻辑） |
| `.ai dialog [clear|full|<username>]` | 查看/清空对话摘要 |
| `.ai budget show` | 查看预算与用量 |
| `.ai calls` / `.ai calls recent` | 查看外部 AI 调用计数与最近记录 |
| `.ai calls background on/off` | 临时允许/禁止默认后台外部 AI 调用（默认 off；不含 people inspector / dialogue aggregation 等二级源） |
| `.ai clear` | 只清空 `state.aiRecent`（不清 `state.aiContextBus`） |

## 7. 热重载

- `registerCleanup` 清理所有监听器和定时器
- `state.aiContextBus/state.aiRecent/...` 都在 shared state 内，跨热重载保持；进程重启会丢失 `state.aiContextBus/state.aiRecent`
- `state.ai.path` 也在 shared state 内；热重载时若它仍是旧默认路径，会自动跟随当前 `DEFAULT_PATH`（例如从 chat-completions 切到 `/v1/responses`）。手动设置的自定义 path 会保留；`.ai path ...` 与 `.ai env reload` 会清除旧 `pathOverride`。
- AbortController 防止异步泄漏

## 8. 进程守护（推荐）

- 推荐通过 `npm run bot:watch` 启动（`scripts/bot-watch.js`）。
- watcher 负责拉起 `bot.js`（继承 stdin/stdout）并在进程异常退出时自动重启。
- 当 `bot.js` 运行在 watcher 下时，控制面 `proc.restart` 只会优雅退出当前进程，由 watcher 完成重拉起，避免“自重启脱离原终端”。

---

*Version: 2.2 | Docs aligned to runtime prompt assembly*
