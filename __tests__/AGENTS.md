# __tests__/

这里是单元/集成测试目录，跑法：`npm test`（底层 `node --test`）。

## 测试原则
- 优先测“纯逻辑”（helpers、记忆裁剪、去重、schema/allowlist 一致性等），避免依赖真实 MC 服务器
- 如需 integration：用 mock bot / fake timers，保证可重复、可在 CI/本地稳定跑

## 变更规则
- 改 `bot_impl/ai-chat/*`、`bot_impl/actions/*`、`bot_impl/agent/*` 时，优先就近补一个小测试覆盖关键约束（预算/上下文缩减/工具路由/去重）

