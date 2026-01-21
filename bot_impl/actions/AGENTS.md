# bot_impl/actions/

这里是 **AI 工具/动作层**：把“意图 → 可执行动作”收敛到一个 allowlist，给 LLM 一个稳定、可枚举、可测试的接口面。

## 入口与职责
- 入口：`bot_impl/actions/index.js`
  - `install(bot, { log, on, registerCleanup })` → `{ run(tool, args), list() }`
  - allowlist：`TOOL_NAMES`（脚本 `scripts/list-tools.js` 依赖它）
- 动作实现：`bot_impl/actions/modules/*`（每个文件注册一组工具）

## 如何新增/修改一个工具（最小步骤）
1. 在 `bot_impl/actions/modules/*` 中实现：`ctx.register('tool_name', async (args) => { ... })`
2. 把工具名加入 `bot_impl/actions/index.js:TOOL_NAMES`（否则 debug 模式会报 mismatch）
3. 同步 LLM 函数调用 schema：`bot_impl/ai-chat/tool-schemas.js`（让模型知道参数形状）

## 状态与副作用约束
- `ctx.shared` 只用于**当前 actions 实例**的临时字段（interval id / abort flag 等），它不会跨 reload 保留
- 需要跨 reload 的长期状态：用 `bot.state`（即 `state`）并确保在 `prepareSharedState()` 里初始化形状
- 任何长循环/timer：必须可被 `reset/stop/stop_all` 打断；并注册 cleanup，避免 reload 后重复运行

## 调试与一致性
- `list()` 返回当前注册工具；debug 时会校验 `TOOL_NAMES` 与实际注册集合是否一致
- 如果你改了工具集合：优先运行 `node scripts/list-tools.js` 检查输出是否符合预期

