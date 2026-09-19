# Actions Contract（`bot_impl/actions/`）

本文档定义 action 层的稳定协作面：**谁能调用、怎么注册、返回什么、dry/run 各自保证什么**。

## 1. 调用路径（控制面到动作层）

控制面入口在 `bot.js`：

1. `tool.list` / `tool.dry` / `tool.run` 进入 `handleCtlRequest()`。
2. 动态 `require('./bot_impl/actions')`，执行 `actionsMod.install(bot, { log: null })`。
3. 先用 actions 工具元数据（`isToolAllowlisted`）做 allowlist 校验。
4. `tool.dry` 走 `actions.dry(tool, args)`；`tool.run` 走 `actions.run(tool, args)`。
5. `tool.run` 包裹 `external:begin` / `external:end` 事件，供上层状态机感知外部任务占用。

这条链路是“控制面真相”，不要在 action 子模块里重复实现授权逻辑。

## 2. 动作层结构

核心文件：`bot_impl/action-tool-specs.js` + `bot_impl/actions/index.js`

- `bot_impl/action-tool-specs.js` 的 `TOOL_SPECS`：工具元数据单一真相（含 dry 能力）。
- `index.js` 的 `TOOL_METADATA`：由单一真相派生的运行时元数据。
- `TOOL_NAMES`：从元数据导出的名称列表（兼容导出）。
- `MODULES`：模块注册列表（`./modules/*`）。
- `createContext()`：构造统一 `ctx`（`ok/fail/register/shared/...`）。
- `install()`：加载模块并返回 `{ run, list, dry }`。

各模块在 `bot_impl/actions/modules/*.js` 中通过 `ctx.register(name, fn)` 注册工具。

## 3. 返回与错误契约

### 3.1 工具函数签名

- 推荐：`async function toolName (args = {})`。

### 3.2 统一返回结构

- 成功：`{ ok: true, msg: string, ...extra }`
- 失败：`{ ok: false, msg: string, ...extra }`

优先使用 `ctx.ok()` / `ctx.fail()` 构造。

### 3.3 异常策略

- 工具内部可抛异常，`run()` 会兜底为统一失败结构并记录日志。
- 不要在工具里吞掉所有异常并返回无诊断信息。

## 4. dry / run 语义（必须严格区分）

### 4.1 默认 dry：`validate_only`

`dry()` 默认只做参数 schema 与注册验证，不模拟世界状态。`dry` 与 `run` 使用 `bot_impl/action-tool-schemas.js` 的同一份 Ajv 校验；缺少必填字段、类型不符或被 schema 禁止的额外字段返回 `{ ok:false, blocks:["bad_args"], errors:[...] }`，不会调用动作。

参数不会被执行层自动强转类型。`botctl key=value` 按 JSON 值解析数字、布尔、数组、对象，解析失败保留字符串；例如 `dig=false`、`names='["oak_log"]'`。旧工具声明 `additionalProperties:true` 的扩展字段仍允许通过；这不等于未声明字段也已得到类型校验。

### 4.2 只读 dry：`read_only`

只有极少数无副作用工具允许在 dry 中真实读取运行时数据（由工具元数据 `dryCapability=read_only` 声明）。

新增 `read_only` 工具前，必须满足：

- 不移动、不放置、不破坏、不聊天、不战斗。
- 失败时也不产生状态副作用。

## 5. 共享状态契约

- 跨入口共享运行时（AI / CLI / 控制面）统一走 `ctx.shared`。
- `ctx.shared` 来源于 `bot.state.actionsRuntime`；不要另建平行 runtime 容器。
- 需要被 `stop/reset` 回收的 interval/flag，必须挂在 `ctx.shared`。

## 6. 新增工具最小流程

1. 在合适模块实现并 `register('tool_name', fn)`。
2. 更新 `bot_impl/action-tool-specs.js` 中的 `TOOL_SPECS`（名称与 dry 能力）。
3. 在 `bot_impl/action-tool-schemas.js` 补参数 schema（必填；缺失、重复或过期 schema 会阻止加载）。
4. 明确 dry 能力级别（`validate_only` 或 `read_only`）。
5. 校验返回结构统一。
6. 运行 `npm run interaction:docgen` 刷新交互 schema 文档。

## 7. 快速验证清单

```bash
node --check bot_impl/actions/index.js
node --check bot_impl/action-tool-specs.js
node --check bot_impl/actions/modules/<your-module>.js
npm run bot:reload
npm run interaction:dry
node scripts/botctl.js dry <tool> ...
```

工具面一致性检查：

- `node scripts/botctl.js schema tool`（控制面返回工具参数 schema + 覆盖率报告）

```bash
node scripts/list-tools.js
node scripts/botctl.js list
```

若 `list` 返回 `missing/extra`，先修复注册与白名单不一致，再继续。

## Explicit building tools

- `craft_preview` is read-only: uses registered Minecraft recipes and current inventory counts, returning required ingredients and shortages. `count` is desired output quantity; one recipe may produce more (e.g. three signs).
- `craft_item` executes the selected `recipeIndex` and checks the inventory delta. Recipes requiring a table must provide explicit reachable `table: {x,y,z}`. It does not gather materials or infer a crafting location.
- `place_sign` places one new standing sign at an explicit integer position. It requires air and solid support, refuses to overwrite any existing block, waits for the server's sign editor permission, and confirms text by observer readback. Partial failures return `data.stage` (`preparing`, `placed`, `write_sent`, `confirmed`), coordinates and intended lines; do not retry placement blindly after a partial failure. Recent receipts are bounded in `state.actionsRuntime.signPlacements`.

- `dig_block` requires integer `position`, an `expected` block name and an explicit inventory `tool`. It checks reach and line of sight, digs only that block and checks removal. It never navigates or clears obstructions; collecting drops is a separate action. Removal confirmation does not imply inventory collection.
- `place_block` places one registered block item at an explicit reachable empty `position` with solid support below, then checks the block name. It does not navigate. Inspect the coordinate after an unconfirmed placement before retrying. Use `place_sign` when sign text and editor permission are required.

Mutation tools are validate-only in dry mode. Live execution uses the existing action control/hand lock boundaries. These tools are not controller behavior primitives; no cancellable multi-step crafting support is claimed.

## Bounded movement input

`move_input` provides explicit yaw/pitch and forward/jump controls for 50–5000 ms, useful for short swimming or local maneuvers when navigation stalls. It stops the current pathfinder goal, does not plan a route or alter blocks, and returns its ending position. Duration completion does not imply arrival. Only one pulse may run; stop/reset and implementation reload cancel it and release its controls. Observe surrounding blocks before a pulse and position afterward. Dry validates arguments only.

Auto-swim reads actual jump control state each tick because navigation can clear controls; an internal remembered key state is insufficient to maintain buoyancy.
