# AGENTS.md (scope: `bot_impl/agent/`)

## 目标
- 本目录提供 agent 基础能力：观测（observer）与技能执行器（runner）。
- 对 onboarding 最关键的是 `observer.js`：它是 `observe.snapshot/prompt/detail` 的事实来源。

## 公开 API（observer）
- `snapshot(bot, opts)`：结构化快照（位置、维度、生命、背包、附近实体、任务等）。
- `toPrompt(snapshot)`：把快照压缩为 prompt 文本（`游戏: ...`）。
- `detail(bot, args)`：按 `what` 返回细化观察（players/hostiles/entities/containers/...）。
- `affordances(bot, snap?)`：基于快照给出动作建议。
- `getDetailSchema()`：导出 `observe.detail` 的 canonical what、alias、参数约束。

改动这些函数等同于改动：
- 控制面 `observe.*`
- AI 上下文游戏态注入
- 交互 dry 验证输出

## detail 输出契约
- 一律返回 `{ ok, msg, data }`。
- `msg` 给人读，`data` 给机读。
- `containers` 分支失败时要保留诊断字段（如 `openError/openErrors/unreachable`），不能只给“失败”。

## 高风险区域
- 容器只读打开逻辑：`openContainerReadOnly` / `detailContainers`
  - 涉及超时、重试、可达性诊断。
- `what` 分派：通过 canonical+alias（`DETAIL_WHAT_CANONICAL` / `DETAIL_WHAT_ALIASES`）管理，避免散落分支。

## 设计约束
- 观察路径默认 read-only。
- 禁止通过外部 API 推断玩家近邻（玩家观察源只用运行时实体数据）。
- 禁止把复杂语义推断塞进字符串拼接；结构化证据应落在 `data` 字段。

## observe.schema 真相
- `detail.what` canonical + alias 由 `observer.getDetailSchema()` 导出，并通过控制面 `observe.schema` 暴露。
- `docs/interaction.generated.md` 由 `npm run interaction:docgen` 生成，不再手工维护 what 列表。

## 强制验证
- `node --check bot_impl/agent/observer.js`
- `npm run bot:reload`
- `node scripts/botctl.js schema observe`
- `npm run interaction:dry`
- 定向：
  - `node scripts/botctl.js dry observe_detail what=entities radius=32 max=20`
  - `node scripts/botctl.js dry observe_detail what=cats radius=32 max=10`
  - `node scripts/botctl.js dry observe_detail what=containers radius=20 max=8`

## 变更提示
- 若你改了 `detail(... what=containers ...)` 输出字段，请同步 `docs/observer-contract.md`（语义约束）并重新生成 `docs/interaction.generated.md`（接口快照）。
