# 闭环计划：工具 dry-run / CLI 交互 / 热重载与重启验证

## 目标
补齐“可验证闭环”：
1) 所有工具调用都能通过内部命令行（`.xxx`）先 dry-run 预览效果。
2) Codex 能直接与内部命令行交互，驱动/验证行为。
3) Codex 可随时 `touch open_fire` 触发热重载，必要时可重启 bot 进程完成验证。

## 现状速记（仅做定位，不是实现）
- 工具清单与 allowlist：`bot_impl/actions.js`；`node scripts/list-tools.js` 可导出工具名。
- 部分内部 CLI 已存在：例如 AI 相关 `.ai ...` 见 `bot_impl/ai-chat/cli.js`。
- 热重载闸门：`touch open_fire` 触发（见 `docs/hot-reload.md`）。

## 拆分计划

### P0 盘点与对齐（最小上下文）
**目标**：把“工具-CLI-运行时”的最小接口对齐，避免各自维护。
- 列出当前所有工具名与参数（由 `actions.js` + `list-tools.js` 生成快照）。
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
- 新增 CLI 命令（示例）：
  - `.tool list`：列出可用工具
  - `.tool dry <tool> <json>`：dry-run 预览
  - `.tool run <tool> <json>`：实际执行
- CLI 展示结构化输出（预览/警告/阻断条件）。
- CLI 行为与工具 allowlist 强一致（拒绝未注册工具）。

交付：
- `.tool`（或统一命名）命令上线。
- 所有工具可通过 CLI dry-run 与 run。

### P3 Codex ↔ CLI 交互通道
**目标**：Codex 可以“非交互地”与内部 CLI 对话。
- 选型一：提供脚本 `node scripts/cli-send.js ".tool dry ..."` 向运行中 bot 发送命令。
- 选型二：暴露轻量 IPC（stdin pipe / unix socket / file queue），CLI 仍是唯一入口。
- Codex 在任务流中通过脚本发送/接收 CLI 输出。

交付：
- 1 条稳定的 Codex 调用路径（脚本或 IPC）。
- CLI 输出格式可机读（必要时提供 `--json`）。

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
