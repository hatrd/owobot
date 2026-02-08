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

核心文件：`bot_impl/actions/index.js`

- `TOOL_SPECS` / `TOOL_METADATA`：工具元数据单一真相（含 dry 能力）。
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

`dry()` 默认只做参数与可执行性验证，不模拟世界状态。

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
2. 更新 `TOOL_SPECS`（名称与 dry 能力）。
3. 在 `bot_impl/ai-chat/tool-schemas.js` 补参数 schema（可缺省，缺省会自动回落通用 object 并在 schema report 里暴露）。
4. 明确 dry 能力级别（`validate_only` 或 `read_only`）。
5. 校验返回结构统一。
6. 运行 `npm run interaction:docgen` 刷新交互 schema 文档。

## 7. 快速验证清单

```bash
node --check bot_impl/actions/index.js
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
