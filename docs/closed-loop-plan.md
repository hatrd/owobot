# 闭环计划：工具 dry-run / CLI 交互 / 热重载与重启验证

## 目标
补齐“可验证闭环”：
1) 所有工具调用都能通过内部命令行（`.xxx`）先 dry-run 预览效果。
2) Codex 能直接与内部命令行交互，驱动/验证行为。
3) Codex 可随时 `touch open_fire` 触发热重载，必要时可重启 bot 进程完成验证。

## 现状速记（仅做定位，不是实现）
- 工具清单与 allowlist：`bot_impl/actions/`；`node scripts/list-tools.js` 可导出工具名。
- 部分内部 CLI 已存在：例如 AI 相关 `.ai ...` 见 `bot_impl/ai-chat/cli.js`。
- 统一工具 CLI：`.tool ...` 见 `bot_impl/tool-cli.js`（已按“list/dry/run 否则默认执行工具”路由）。
- 热重载闸门：`touch open_fire` 触发（见 `docs/hot-reload.md`）。

## 拆分计划

### P0.5 先修：工具运行时收敛（避免“多入口各跑各的”）
**目标**：先把“工具执行”的运行时收敛成可验证的单一事实源，否则 `.tool`/AI/各类 CLI 很容易互相停不掉、热重载留幽灵任务，闭环结果不可信。
- 现状风险：`actions.install(bot)` 每次都会创建新的 `shared`（interval/abort 标记等），不同入口（AI、现有 `.collect/.place`、未来 `.tool`）可能各装一份 actions，导致 `stop/reset` 只能影响“本入口那一份”。
- 规范：actions 的长期运行时（interval、abort 标记、debug 开关等）必须收敛到 `state`（跨热重载复用的 sharedState）下的单一对象（例如 `state.actionsRuntime`），所有入口复用同一份 runtime。
- 验收：任意入口启动的长任务（追击/守卫/挖矿/拾取等）都能被 `.reset`/`stop_all` 可靠停止；热重载后不残留旧 interval。
实现落点：
- `bot_impl/state.js` 初始化 `state.actionsRuntime`。
- `bot_impl/actions/index.js` 默认从 `bot.state.actionsRuntime` 读取/复用 runtime（可选通过 `install(bot, { runtime })` 注入）。

### P0 盘点与对齐（最小上下文）
**目标**：把“工具-CLI-运行时”的最小接口对齐，避免各自维护。
- 列出当前所有工具名与参数（由 `bot_impl/actions/` + `scripts/list-tools.js` 生成快照）。
- 查明内部 CLI 的统一入口/路由位置，确认可挂载新的 `.tool` 或 `.actions` 命令。
- 明确 “dry-run 的最小返回结构”（例如：会调用的子动作、目标、预计耗时/风险、失败前置条件）。

交付：
- 1 份工具清单快照（可用脚本生成并存档）。
- 1 份 CLI 入口位置的简要说明（放在本文件或新文档里）。

### P1 工具 dry-run 统一接口
**目标**：任何工具都能被 dry-run 走一遍，返回“将要发生什么”。
- 方案 A：为每个工具增加 `dryRun(args)`。
- 方案 B：统一 `run(args, { dryRun: true })`，在工具内部短路。
- 对所有工具建立 **最小 dry-run 输出格式**（例如 `{ ok, preview, warnings, blocks }`）。
- 为无法模拟的工具给出明确降级说明（例如 “仅可校验参数/权限”）。

交付：
- 所有工具具备 dry-run 路径。
- dry-run 输出格式稳定，便于 CLI/日志显示。

### P2 内部 CLI：统一工具入口
**目标**：通过内部命令行（`.xxx`）执行工具/预览。
- 新增 CLI 命令（人类入口尽量简单，避免 JSON/引号地狱）：
  - `.tool list`：列出可用工具
  - `.tool dry <toolOrAlias> [args...]`：dry-run 预览（与 run 共享同一套参数解析）
  - `.tool <toolOrAlias> [args...]`：实际执行（默认 run；可选兼容 `.tool run ...` 作为别名）
- 路由规则（核心约定）：如果 `.tool` 第一个参数是 `list/dry/run` 则走子命令，否则把第一个参数当 tool 名（或 alias）并直接执行。
- 参数解析规范（人类入口）：
  - 统一支持 `key=value`（建议用工具原生字段名，例如 `radius/max/timeoutMs/match`）。
  - 少量高频工具支持“位置参数”糖衣（避免写 key=）：
    - `pickup/collect`：`.tool pick 20` → `{ radius: 20 }`；`.tool pick 20 log` → `{ radius: 20, match: "log" }`
      - 可选糖衣：`.tool pick 20 50` → `{ radius: 20, max: 50 }`
    - `goto`：`.tool goto 10 64 -20` → `{ x: 10, y: 64, z: -20 }`（可选 range）
    - `say`：`.tool say 你好` → `{ text: "你好" }`（剩余 token 视为文本拼接）
  - alias 建议（示例）：`pick`→`pickup`，`go`→`goto`，`tp`→`goto`（按项目习惯增补即可）。
- CLI 展示结构化输出（预览/警告/阻断条件）。
- CLI 行为与工具 allowlist 强一致（拒绝未注册工具）。

交付：
- `.tool`（或统一命名）命令上线。
- 所有工具可通过 CLI dry-run 与 run。
实现落点：
- `.tool` 命令处理：`bot_impl/tool-cli.js`（已实现上述路由与基础解析）。

### P3 Codex ↔ bot 控制面（Unix Socket / NDJSON）
**目标**：为 Codex/脚本提供稳定、可机读、可重连的控制通道；不依赖“attach stdin”。
- 选择 Unix Domain Socket（UDS）：bot 启动时在 `cwd` 写入 socket（例如 `.mcbot.sock`），同时写入 `.mcbot.pid` 便于发现与排障。
- 协议：一行一个 JSON（NDJSON），请求/响应都带 `id`，便于并发与超时处理。
- 请求类型（示例）：
  - `tool.list` / `tool.dry` / `tool.run`：直接传结构化 `{ tool, args }`（机器通道不走字符串分词）。
  - `cli.line`：可选，传 `{ line: ".status" }` 复用现有 CLI 语义（人类命令行的子集）。
- 输出规范：响应统一 `{ id, ok, result, error }`；stdout 仍保留稳定前缀（`[CLI]`/`[AICTL]`）给人看，但机器以 socket 响应为准。
- 安全隔离：socket 文件权限尽量收紧（同用户可读写），并在握手响应中回传 `cwd/pid/startedAt`，避免串台。

交付：
- 1 个脚本化控制入口（例如 `node scripts/botctl.js ...`）可连接 UDS 并执行 `tool.dry/tool.run`。
- 1 份最小协议说明（本文件即可），保证自动化不漂移。

### P4 验证闭环：热重载 + 进程重启
**目标**：Codex 能明确“什么时候热重载、什么时候重启”。
- 约定验证路径：
  - **仅改 `bot_impl/`** → `touch open_fire` 热重载验证
  - **涉及启动流程/依赖/脚本** → 提供“安全重启”入口
- 补一条脚本化入口（示例）：
  - `npm run bot:reload`（内部做 `touch open_fire`）
  - `npm run bot:restart`（安全停止并拉起）

交付：
- 明确可复制的验证步骤（CLI/脚本）。
- 文档中写清“热重载 vs 重启”的判断标准。

## 验收标准（Definition of Done）
- 任一工具都能通过 `.tool dry ...` 预览，将要发生的动作清晰可见。
- Codex 能通过脚本向内部 CLI 发命令并读回结果。
- 文档给出明确的验证路径：热重载（`touch open_fire`）与重启（脚本化）。

## 风险与约束
- 部分工具可能依赖实时世界状态，dry-run 只能“静态预估”；需标明不确定性。
- CLI 输出必须稳定、可机读，否则 Codex 的自动化将漂移。
- 热重载不覆盖的修改必须走重启路径，避免“看起来成功但没生效”。
