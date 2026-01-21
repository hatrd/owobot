# bot_impl/minimal-self/

这里是 **Minimal Self**：世界模型 + 主体性归因 + 驱动（M1），用于把“自我/目标/叙事”压缩成可控的提示词输入。

## 入口
- `bot_impl/minimal-self/index.js`：`activate(bot, state)` / `deactivate()`
- 由 `bot_impl/index.js` 在主实现里安装，并通过 cleanup 在 reload 时卸载

## 文件分工（按语义切片）
- `world-model.js`：世界状态抽象（避免直接把全量 entities 注入 AI）
- `identity.js`：身份与稳定自我描述
- `narrative.js`：叙事/摘要（把长历史压缩）
- `drive.js`：驱动/触发器（主动行为的入口）
- `attribution.js`：归因（把行为原因结构化）

## 变更规则
- 任何新增字段尽量收敛到 `state` 的一个子树，避免散落跨文件隐式依赖
- 如果某能力不能被切成独立上下文（世界模型/叙事/驱动耦合），先重拆问题再实现

