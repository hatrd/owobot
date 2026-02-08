# AGENTS.md (scope: `bot_impl/ai-chat/`)

## 目标
- 本目录负责 AI 对话编排：上下文拼装、记忆检索、工具调用循环、反馈与自省。
- 改动前先确认自己在改“编排层”还是“子能力层”，避免跨层耦合。

## 入口与分层
- 入口装配：`../ai-chat.js`
  - `createPeopleService` / `createMemoryService` / `createContextBus`
  - `createChatExecutor`（核心执行器）
  - 事件挂载、`bot._aiChatExecutor` 暴露、cleanup 回收
- 编排核心：`executor.js`
  - `handleChat()`：主入口（触发词与会话流程）
  - `callAI()`：请求模型 + 工具循环
  - `dryDialogue()`：供控制面 `ai.chat.dry` 使用
- 记忆与画像：`memory.js`、`people.js`
- 上下文总线：`context-bus.js`

## 对外契约（必须保持）
- `bot.js` 控制面通过 `bot._aiChatExecutor.dryDialogue(...)` 调用 dry 对话。
- 因此 `createChatExecutor()` 返回对象中的这些方法需保持可用：
  - `handleChat`
  - `buildContextPrompt`
  - `buildMetaContext`
  - `callAI`
  - `dryDialogue`
  - `abortActive`

## 状态真相（state-first）
- 共享状态统一挂 `state.ai*`（由 `state-init` 初始化）。
- 不要引入“隐式全局缓存”绕开 `state`。
- 预算、上下文开关、记忆模式等必须可从 `state` 回放。

## 修改边界建议
- 想改“提示词拼装顺序/工具循环策略” → `executor.js`
- 想改“长期记忆召回算法” → `memory.js` / `memory-query.js`
- 想改“玩家画像/承诺” → `people.js`
- 想改“上下文事件压缩” → `context-bus.js`
- 想改“CLI 参数与观测命令” → `cli.js`

## 禁止事项
- 禁止在多个文件重复实现触发词/意图路由。
- 禁止用硬编码 regex 从自然语言“猜状态”并写入持久记忆。
- 禁止把 action 层细节硬编码到 AI 子模块；通过 actions/tool schema 抽象边界。

## Tool schema 边界
- action 工具名来源于 `bot_impl/action-tool-specs.js` 的 `TOOL_SPECS`（单一真相）。
- 本目录只负责“参数 schema/描述”覆盖，不再维护独立工具名清单。
- `tool-schemas.js` 中缺失显式参数 schema 时，会落到默认 object schema，并出现在 `tool.schema.report.missingSchema`。
- 新增 action 工具时，优先补齐参数 schema，避免模型调用歧义。

## 强制验证（与仓库总规一致）
- `node --check bot_impl/ai-chat.js`
- `node --check bot_impl/ai-chat/executor.js`
- `node --check bot_impl/ai-chat/tool-schemas.js`
- `npm run bot:reload`
- `node scripts/botctl.js schema tool`
- `npm run interaction:dry`
- 定向 dry：
  - `node scripts/botctl.js chatdry username=<name> content="<text>" withTools=true maxToolCalls=6`

## 上下文卫生
- 新增字段前先问：能否放进已存在结构（`state.ai.context` / `state.aiMemory` / `state.aiDialogues`）？
- 默认给 LLM 的上下文必须可裁剪；任何“全量注入”都要有开关和上限。
