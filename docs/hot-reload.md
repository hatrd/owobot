# 热重载与操作手册

## 重载闸门
- 仓库默认启用 `open_fire` 闸门。只有在完成 `bot_impl/` 里的修改后执行 `touch open_fire` 才会触发热重载，避免半成品上线。
- 重载时保持 `bot_impl/` 的模块导出纯净，所有共享状态放到 `state`，避免跨模块污染导致的幽灵状态。

## 启动模式
- 热重载后 `spawn` 事件不保证会再次触发。所有 watcher/timer 必须通过守卫式的 `start()` 函数自我初始化。
- 模板：
  ```js
  function start () { if (!timer) timer = setInterval(tick, 1000) }
  bot.on('spawn', start)
  if (state?.hasSpawned) start()
  start() // 确保首次加载时立即运行
  ```
- 如果需要一次性的 post-spawn 初始化逻辑，抽成 `initAfterSpawn()` 并在 `spawn` + 热重载分支都调用。

## AI 工具
- 需要定位代码上下文时优先使用 `acemcp` 搜索，避免盲扫全库。
- 搜索提示词尽量具体到模块/行为，以减少 LLM 的上下文需求。
