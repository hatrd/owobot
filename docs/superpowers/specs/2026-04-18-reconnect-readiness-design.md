# Reconnect Readiness Guard Design

## Goal

修复 bot 断线后的“假在线卡死”问题：连接对象虽然已建立，但如果迟迟没有进入可用在线态（未 `spawn` 或 TAB 里看不到自己），系统必须主动终止当前连接并回到统一重连流程，而不是无限挂起。

## Problem

当前实现只在以下两类事件上触发统一重连：

- 底层连接显式 `end` / `kicked`
- 运行期 watcher 发现 TAB 长时间为空

这会漏掉一个启动期死挂窗口：新 bot 已创建、控制台显示 connected/login success，但实例没有真正进入稳定在线态；这时 `.tab` 为空，且后续可能不再触发足够强的失败信号，导致不会继续重连。

## Non-goals

- 不处理 `mineflayer-simplevoice` 的 `ECONNREFUSED` 噪音
- 不重做完整连接状态机
- 不修改交互契约、schema 或 control plane

## Design

### 1. Add a per-bot readiness guard in loader

在 `bot.js` 为每次 `mineflayer.createBot()` 生成的新实例绑定“启动期在线守卫”，只依赖结构化状态：

- 在 `SPAWN_TIMEOUT_MS` 内必须收到 `spawn`
- 收到 `spawn` 后，在 `TAB_READY_TIMEOUT_MS` 内 TAB 至少必须包含 bot 自己

若任一条件失败，则主动结束当前 bot，让现有 `end` 监听触发 `scheduleReconnect()`。

### 2. Keep guard state local to the bot instance

守卫所用的 timer / interval 必须绑定到具体 bot 实例，并在以下场景清理：

- bot `spawn` 后进入下一阶段
- bot `end` / `kicked`
- 旧 bot 被替换或销毁

这样旧实例不会把过期 timer 泄漏到新连接上。

### 3. Reuse existing tablist truth

TAB 就绪判断继续复用 `bot_impl/tablist-utils.js` 中的 `getListedPlayerEntries()` / `hasListedSelf()`，不引入新的字符串语义推断。

### 4. Keep runtime watcher as second-line defense

`bot_impl/watchers.js` 里的长期 TAB 健康检查保留，用于处理“运行中掉成假在线”的场景；启动期 readiness guard 只负责把连接建立后的死挂窗口收口。

## Files

- Modify: `bot.js`
  - 连接启动期 readiness guard
  - 生命周期清理接入 `end` / `kicked`
- Reuse: `bot_impl/tablist-utils.js`
  - 自身是否已出现在 TAB 中的结构化判定
- Add test: `__tests__/reconnect-readiness.test.js`
  - 覆盖 `spawn` 超时和 `spawn` 后 TAB 仍空两种失败路径

## Verification

1. `node --check bot.js`
2. `node --check __tests__/reconnect-readiness.test.js`
3. `node --test __tests__/reconnect-readiness.test.js`
4. `npm run bot:reload`
5. `npm run interaction:dry`

## Expected Outcome

当服务器或 mineflayer 进入“看起来连上了，但实际上没有完成在线态”的异常窗口时，bot 会在超时后主动断开并继续重连，而不是停在 TAB 空白、后续也不再自愈的状态。
