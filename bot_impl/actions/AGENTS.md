# AGENTS.md (scope: `bot_impl/actions/`)

## 目标
- 本目录是 **tool 执行内核**：统一注册、统一 dry/run 语义、统一返回结构。
- 这里的改动会同时影响 `.tool ...`、`botctl tool.*`、AI function calling。

## 快速定位（先看这四个）
- `../action-tool-specs.js`
  - `TOOL_SPECS`：工具元数据单一真相（`name` + `dryCapability`）。
- `index.js`
  - `TOOL_NAMES`：由元数据导出的兼容名称列表。
  - `MODULES`：动作模块装配顺序。
  - `install()`：导出 `run/list/dry` 三个入口。
- `modules/`
  - 各工具通过 `ctx.register(name, fn)` 注册。
- `../tool-select.js`
  - 与挖掘/工具选择相关逻辑在这里，不要散落到各 action。

## 核心契约（必须保持）
- Action 函数签名：`async function xxx(args = {})`。
- 返回结构统一：`{ ok: boolean, msg: string, ...extra }`。
- 业务失败请返回 `ctx.fail(...)`；异常可抛出，`run()` 会兜底为统一失败响应。
- 不要绕过工具元数据做“隐式可用工具”；可用性必须显式维护在 `bot_impl/action-tool-specs.js` 的 `TOOL_SPECS`。
- **跨入口共享状态** 必须放在 `ctx.shared`（来源于 `bot.state.actionsRuntime`），避免“在 CLI 能停，在 AI 停不掉”。

## dry/run 语义边界
- `dry()` 默认是 `validate_only`：只验证工具与参数，不模拟世界状态。
- 只有明确只读工具才可进入 `read_only` dry 路径（在 `bot_impl/action-tool-specs.js` 的 `TOOL_SPECS.dryCapability` 声明）。
- 新增只读工具时，必须证明：
  - 不移动、不放置、不破坏、不聊天、不开战斗行为；
  - 即使失败也不改变世界状态。

## tool schema 真相
- 工具名白名单只在 `bot_impl/action-tool-specs.js` 的 `TOOL_SPECS` 维护。
- AI function tool 列表由 `TOOL_SPECS` 自动派生；`bot_impl/ai-chat/tool-schemas.js` 只维护参数 schema 覆盖。
- 运行 `node scripts/botctl.js schema tool` 查看覆盖率：
  - `missingSchema`：白名单里存在但未写显式参数 schema。
  - `staleSchema`：schema 覆盖里存在但白名单已不存在。

## 新增工具 checklist
1. 在对应 `modules/*.js` 里实现并 `register('tool_name', fn)`。
2. 在 `bot_impl/action-tool-specs.js` 的 `TOOL_SPECS` 加入同名条目，并声明 dry 能力。
3. 在 `bot_impl/ai-chat/tool-schemas.js` 增加该工具参数 schema（若暂缺会进入 `missingSchema`，需显式知情）。
4. 如涉及观察类输出，保证 `msg` 可读 + `data` 可机读。
5. 执行 `npm run interaction:docgen` 更新交互 schema 快照。

## 强制验证（与仓库总规一致）
- `node --check bot_impl/action-tool-specs.js`
- `node --check bot_impl/actions/index.js`（以及改动到的模块文件）
- `npm run bot:reload`
- `node scripts/botctl.js schema tool`
- `npm run interaction:dry`
- 定向：`node scripts/botctl.js dry <tool> ...`

## 禁止事项
- 禁止通过硬编码字符串/正则“猜状态语义”。
- 禁止在 action 内偷改其他模块私有状态；共享状态只经 `state` / `ctx.shared`。
- 禁止把控制面授权逻辑写进 action；授权在 `bot.js` 控制面入口统一处理。
