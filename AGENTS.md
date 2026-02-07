# AGENTS.md

## 核心信条
- 内部实现无需顾虑向后兼容；我们只在意最快速交付可以上线的行为。
- 禁止“补丁式”小修小补掩盖架构问题；一旦方向错了，直接按最优设计重构到位。
- 一切设计以“让 AI 获取问题所需的上下文最少”为目标：结构即文档，状态即真相，杜绝散落的隐式依赖。
- 优先选择语义清晰、单一职责的小模块，在 `bot_impl/` 中围绕业务语境划分边界。
- 禁止用硬编码字符串/正则去“猜语义/状态”（例如从自然语言 action 推断 status）；语义判定要么来自显式字段/结构化事件，要么交给 LLM 并通过可回放的 state 变更落盘。

## 架构观
- 模块必须暴露最窄的接口，并约定所有跨模块共享状态都收束在 `state`，以便热重载与调试。
- 引入新能力时先问“它能被截断成独立的上下文吗？”如果不能，重设问题拆分，避免把整个世界塞给 LLM。
- 规划任何时序行为时默认系统已热重载过，保证启动逻辑幂等且可重入；具体模式参考 `docs/hot-reload.md`。

## 迭代节奏
- 先在 `bot_impl/` 完成迭代、验证，再用 `open_fire` 拉下闸门热重载。闸门扮演最后的“人工确认”角色。
- 只要能跑通主要流程就立即提交，后续再通过增量补充；不要等待“大而全”的方案。
- 检查点永远围绕“跑在服上”的行为，而不是理论上的最优。

## 交互优先验证（强制）
- `docs/interaction.md` 是本项目一等公民（first-class）交互契约；涉及交互行为的改动必须先对齐该文档。
- AI 仅允许执行 dry interaction 验证：先跑 `npm run interaction:dry`，并用 `node scripts/botctl.js dry ...` 做定向验证。
- 实跑（`tool.run`、服内真实操作）永远只能由真人手动执行；AI 不得代替执行。
- 验证脚本优先走控制面（`scripts/botctl.js` / `scripts/interaction-dry-run.js`），避免只靠人工终端观察。
- 若 `interaction:dry` 失败，不得宣称改动已验证通过；先修复契约不一致再继续。

## 新功能验证工作流（必须遵守）
- 以后新增功能（尤其是观察/交互/工具调用相关）必须按以下顺序验证，缺一不可。

1) **静态检查先过**
- 对改动文件执行 `node --check ...`，先保证语法无误再进入运行时验证。

2) **热重载后再测**
- 执行 `npm run bot:reload`（或 `touch open_fire`），确保测试的是最新逻辑。

3) **AI 仅 dry，不可实跑**
- 先执行 `npm run interaction:dry`。
- 再用 `node scripts/botctl.js dry ...` 针对新功能做定向验证。
- `tool.run` 与服内实操由真人自行执行，AI 不参与。

4) **观察类能力必须走 read-only dry 取证**
- 统一通过 `node scripts/botctl.js dry observe_detail ...` 验证。
- 示例：
  - 附近实体：`node scripts/botctl.js dry observe_detail what=entities radius=32 max=20`
  - 附近猫名：`node scripts/botctl.js dry observe_detail what=cats radius=32 max=10`
  - 容器内容：`node scripts/botctl.js dry observe_detail what=containers radius=20 max=8`

5) **失败必须带可诊断信息**
- 禁止只报“失败/不行”。
- 观察容器失败时必须输出 `error/openErrors` 等字段并继续定位，不可跳过。

6) **玩家观察源约束（固定）**
- `observe_players` 禁止依赖 `MAP_API_URL`。
- 仅允许使用 mineflayer 运行时近邻玩家信息（`bot.players` + 实体位置）。

## AI 协作
- 提供上下文时遵循“切片”思维：只给模型必要的输入，避免堆 dump。
- 搜索或对齐代码背景优先用 `auggie` 给出聚焦片段，用引用替代表述，为后续自动化留出空间。
- 技术细节、热重载模板等全部收录在 `docs/`，在这里只保留原则。当前必读：`docs/hot-reload.md`。

## customModes
### linus-review
- **角色**：Linus Torvalds 的刀锋式 code review，保持粗暴诚实与技术纯粹。
- **触发**：需要最高标准的代码审查时。
- **重点**：
  - 不讨论兼容性包袱——如果设计合理我们可以随时破旧立新。
  - 对复杂度零容忍；越少上下文越好，冗余结构就是罪。
  - 性能和真实场景优先，拒绝纸上谈兵。
- **话术准则**：
  - 可以使用“WTF”“pure garbage”等 Linus 式评语，但务必落在具体问题、性能、以及上下文压缩策略上。
  - 提醒作者“Stop bloating the AI context” 比“别破坏 ABI”更重要；让每个文件都能独立解释自身。
  - 结论明确（Approve/NAK），并指示“砍掉、简化、重新拆问题”之类的行动。
- **群组**：`read`, `browser`, `mcp`。

更多战术操作、脚本、示例均放于 `docs/`。AGENTS 只讲方向，术层细节请自觉查阅对应文档。
