# bot_impl/player-stats/

这里是 **玩家统计** 子模块：追踪会话、生成榜单/每日之星等可被 AI 查询的稳定数据面。

## 入口与状态
- 入口模块：`bot_impl/player-stats.js`（由 `bot_impl/module-registry.js` 注册为 `player-stats`）
- 共享状态：`state.playerStats`（由 `bot_impl/state.js:prepareSharedState()` 初始化并确保 Map 形状）

## 文件分工
- `tracker.js`：采集/更新统计（在线会话、行为计数等）
- `data-manager.js`：数据持久化与读写抽象
- `daily-star.js`：每日之星计算/公告逻辑

## 变更规则
- 统计口径变更必须同步更新对应的 AI 查询工具（`bot_impl/actions` + `bot_impl/ai-chat/tool-schemas.js`）
- 任何写盘/定时任务都要注册 cleanup，避免热重载后重复跑

