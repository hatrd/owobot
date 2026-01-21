# scripts/

这里是开发/运维脚本集合，目标是**让行为与 schema 可检查**，而不是把知识写进 docs。

## 常用脚本
- `node scripts/list-tools.js`：导出 AI 工具 allowlist（来自 `bot_impl/actions:TOOL_NAMES`）
- `node scripts/inspect-injected-context.js ...`：预览注入 LLM 的上下文（用于控预算/控噪声）

## 约定
- 脚本应可从任意 CWD 运行（用 `path.resolve(__dirname, '..')` 锚定 project root）
- 脚本只读优先；需要写盘时写到 `data/` 或明确的输出目录，避免污染工作区

