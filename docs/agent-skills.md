# Agent Workflow Skill Notes

这些条目是适合固化为 Codex skill 的 mcbot 专用工作流。它们不是运行时契约；运行时真相仍以 schema、代码和 dry 验证为准。

## mcbot-interaction-debugging

触发：AI 对话、工具调用、control-plane、observe、hot reload 相关问题。

流程：

1. 读最近的目录级 `AGENTS.md` 和 `docs/hot-reload.md`。
2. 找 prompt 合同、schema 合同、executor/action 边界三处真相。
3. 先复现生产症状，优先用日志里的真实 LLM 返回或 control-plane dry 输入。
4. 写失败测试，再改实现。
5. 只做 dry 验证；真实 `tool.run` 和服内操作留给真人。
6. 改完执行 `node --check`、`npm run bot:reload`、schema 查询、`npm run interaction:dry`、定向 `botctl dry/chatdry/observe_detail`。

## llm-output-replay-testing

触发：模型返回内容被错误解析、泄漏到公屏、丢失工具调用、推理文本外泄。

规则：

- 测试输入使用生产 LLM 原始返回，不要改写成理想化 JSON。
- 断言边界是 bot 实际出站行为，例如 `bot.chat()` 收到的每一条文本。
- parser 单测只能作为补充；必须有 executor/pulse 级回放。
- `chatdry` 是真实模型路径验证，不是稳定的解析回归测试。它 timeout 时应单独记录为外部调用问题。

## prompt-contract-audit

触发：改 `bot_impl/prompts/`、`tool-schemas.js`、`executor.js`、profile/context 裁剪策略。

检查点：

- Prompt 要求模型输出的结构，executor 是否真的接受。
- Function-calling schema、inline prompt 语法、特殊工具（如 `say`、`feedback`、`plan_mode`）是否有清晰边界。
- 普通聊天 profile 禁用动作工具时，prompt 中仍可能出现的结构输出是否有安全降级。
- 若合同变化影响使用方式，同步更新 `docs/ai-chat.md`、`docs/interaction.md`、README。

## ai-tool-boundary-review

触发：新增/修改 AI 可触达工具、特殊工具、文本 fallback。

原则：

- 不从自然语言猜动作语义；只接受 schema 字段、provider tool_calls、或精确结构化文本。
- 区分 reply script 和 world action。`say` 可以在 no-tools profile 中作为回复脚本执行；其它动作工具必须受 `withTools`/intent/profile 边界约束。
- 执行真实动作前必须经过 allowlist 和 busy/side-effect 检查。
- dry 路径输出要包含可诊断字段，尤其是 observe/container 失败时的 `error/openErrors`。

## mcbot-dry-verification

触发：准备声称修复完成、提交或推送前。

最小门禁：

```bash
node --check <changed-js-files>
node --test
npm run bot:reload
node scripts/botctl.js schema tool
npm run interaction:dry
node scripts/botctl.js dry observe_detail what=containers radius=20 max=8
```

如果 socket 在 sandbox 内 `EPERM`，用授权后的同一命令重跑；不要把 sandbox 失败当作产品失败。涉及 schema 变更时再执行 `npm run interaction:docgen`。
