# bot_impl/ai-chat/

这里是 **AI Chat 子系统**：把游戏观测、记忆、工具调用、回复生成组合成一个“最小上下文”的闭环。

## 入口与数据流
- 入口：`bot_impl/ai-chat.js`（由 `bot_impl/module-registry.js` 注册为 `ai-chat` 模块）
- 典型链路（高层）：
  1) 收到玩家聊天/CLI → 2) `observer` 生成轻量快照（避免 dump 世界）→ 3) 记忆服务补上下文 → 4) LLM 选择工具（function calling）→ 5) `actions.run()` 执行动作 → 6) 产出回复并记账/落盘

## 状态切片（跨 reload 保真）
- 统一入口：`bot_impl/ai-chat/state-init.js:prepareAiState(state, ...)`
- 常见 slice（不要随意改名/改形状）：
  - `state.ai`：模型/URL/key/预算/上下文配置（`maxTokensPerCall`、`timeoutMs` 等）
  - `state.aiMemory` / `state.aiLong` / `state.aiRecent`：记忆与对话存储
  - `state.aiSpend`：token/cost 记账（day/month/total）
  - `state.aiFeedback` / `state.aiPersonality` / `state.aiEmotionalState` / `state.aiIntrospection`：反馈与自省

## 工具接口（LLM 可调用面）
- schema：`bot_impl/ai-chat/tool-schemas.js`（描述工具名/参数）
- 执行器：`bot_impl/ai-chat/executor.js`（把 function call 路由到 `bot_impl/actions`）
- 规则：能用快照回答就别 `observe_detail`；只在必要时拉细节，控制上下文与成本

## 变更规则（避免上下文膨胀）
- 新增能力优先拆为：`actions` 新工具 / `observer` 新字段 / `memory` 新存取规则（选其一，别三者同时大改）
- 若必须引入新状态：加到 `prepareAiState()` 里初始化形状，并解释“为什么跨 reload 需要保留”

