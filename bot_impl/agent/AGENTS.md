# bot_impl/agent/

这里是 **Agent 基础设施**（不是业务动作本身）：提供可热重载复用的任务运行器与观测器。

## runner（技能任务运行器）
- 文件：`bot_impl/agent/runner.js`
- 设计要点：
  - 任务状态保存在 `bot._skillRunnerState`，以便跨 reload 延续任务
  - reload 时会清空 `skills` 注册表（`S.skills.clear()`），但保留 `tasks`
  - `agent:stop_all` 会触发 `shutdown()` 取消所有任务
- 写新 skill 的建议：
  - skill controller 不要依赖 module-level 变量；热重载会导致闭包状态失效
  - controller 提供 `start/tick/cancel/pause/resume` 中需要的最小集合即可

## observer（提示词快照/细节采样）
- 文件：`bot_impl/agent/observer.js`
- 原则：
  - 默认只输出**轻量快照**（位置/维度/附近玩家/hostiles/掉落/库存摘要）
  - “拉细节”要显式触发，避免把世界 dump 进 LLM 上下文

