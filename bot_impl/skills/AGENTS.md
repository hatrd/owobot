# bot_impl/skills/

这里是 **技能实现**：更长周期、更高层意图的任务（相对于 actions 的单次工具调用）。

## 入口与注册
- 注册发生在 `bot_impl/index.js`：`runner.registerSkill(name, require('./skills/...'))`
- runner：`bot_impl/agent/runner.js`（跨 reload 复用 `bot._skillRunnerState`）

## 写一个 skill factory 的约定
- 导出函数签名：`({ bot, args, log, observer }) => controller`
- controller 典型实现：`tick()`（周期推进）、`cancel()`（硬停）、可选 `start/pause/resume`
- 任务应可中断：尊重 `agent:stop_all`，并在 `cancel()` 里尽快释放控制（停止 pathfinder/挖掘/窗口）

## 状态放哪里
- 临时推进状态：放 controller 内部（但要接受 reload 可能丢失闭包）
- 必须跨 reload 的进度/标记：放 `bot.state`（并在 `prepareSharedState()` 初始化）

