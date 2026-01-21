# bot_impl/

这里是**可热重载**的业务实现层；`bot.js` 只负责加载/重连/热重载编排，绝大多数行为都应该落在本目录，避免把上下文扩散到全仓库。

## 入口与生命周期
- Loader：`bot.js`（watch `bot_impl/`）→ `require('./bot_impl').activate(bot, { sharedState, config })` / `deactivate()`
- 实现入口：`bot_impl/index.js`
  - `activate()` 必须幂等、可重入（热重载后不保证再次触发 `spawn`）
  - `activate()` 返回 `{ sharedState }`，用于跨 reload 保留状态
- 重载闸门：默认 `open_fire`（改完 `bot_impl/` 再 `touch open_fire` 才真正 reload）

## 模块边界（单一职责，最小接口）
- 模块清单唯一真相：`bot_impl/module-registry.js`
- 每个模块约定：导出 `install(bot, { state, on, log, dlog, registerCleanup, ... })`
  - 只通过 `state` 共享跨模块状态；不要靠 module-level 单例/全局变量“偷偷共享”
  - 所有 timer/watcher/listener 都要能在热重载后自我恢复（守卫式 `start()`）

## 共享状态（State 是真相）
- `state` 由 `bot_impl/state.js:prepareSharedState(existing, ...)` 规范化（确保 Map/Set/Array 形状稳定）
- 约定：长生命周期/跨模块/跨 reload 的数据放 `state`（也会被挂到 `bot.state`）
- 反例：把 interval id、临时开关、缓存塞进全局变量 → reload 后幽灵状态/泄漏

## 清理与热重载卫生
- 用 `registerCleanup(fn)` 注册清理（底层落在 `state.cleanups`，`deactivate()` 会执行）
- 监听器统一通过 `on(event, handler)` 注册，`deactivate()` 会 `offAll()`

## 常用事件（跨模块协作的“窄接口”）
- `external:begin` / `external:end`：玩家/CLI 驱动的外部任务边界（会映射到 `state.currentTask`）
- `skill:start` / `skill:end`：技能任务边界（由 `bot_impl/agent/runner.js` 发出）
- `agent:stop_all`：全局硬停信号（技能 runner 会监听并取消所有任务）

## 变更规则（让 AI 低上下文也能改对）
- 改行为时：优先更新最近的 `AGENTS.md`（本文件或更深目录）补 2-3 条“边界/状态/入口”说明
- 只有当信息跨多个模块且稳定时，才写到 `docs/`；避免把临时约定堆进 docs 里失去维护

