# AGENTS.md

## AI 自主权限
- 本项目由 AI 全权操作。用户已持续授权 AI 自主决定并执行项目开发、重构、测试、热重载、启动/停止/重启、配置修改、控制面写操作和服内真实操作。
- `tool.run`、自主生活启用、探索、移动、喂食、采集和建造等项目操作均在授权范围内，无需逐项或重复请求用户确认。
- AI 应主动完成任务所需的实现、部署、实跑验证和问题修复；仅在确实缺少无法从代码、状态或观察中取得的必要信息时向用户提问。
- 授权覆盖项目操作，不替代工程验证：先查询 schema、完成 dry 检查，再按目标实跑并读取状态确认结果。用户后续明确的停止、范围或偏好指令优先。

## 核心信条
- 内部实现无需顾虑向后兼容；我们只在意最快速交付可以上线的行为。
- 禁止“补丁式”小修小补掩盖架构问题；一旦方向错了，直接按最优设计重构到位。
- 这个仓库代码全是 AI AGENT 写的，一切设计以“让 AI 获取问题所需的上下文最少”为目标：结构即文档，状态即真相，杜绝散落的隐式依赖。
- 禁止用硬编码字符串/正则去“猜语义/状态”（例如从自然语言 action 推断 status）；语义判定要么来自显式字段/结构化事件，要么交给 LLM 并通过可回放的 state 变更落盘。

## 架构观
- 模块必须暴露最窄的接口，并约定所有跨模块共享状态都收束在 `state`，以便热重载与调试。
- 规划任何时序行为时默认系统已热重载过，保证启动逻辑幂等且可重入；具体模式参考 `docs/hot-reload.md`。
- 交互契约优先“接口可查询”：`ctl.schema` / `observe.schema` / `tool.schema` 是机器真相，`docs/interaction.generated.md` 是其快照。

## 交互优先验证（强制）
- `docs/interaction.md` 是交互流程说明；具体 ops/what/tool 列表以 schema 接口与生成文档为准，不再手工维护清单。
- 交互验证先走 dry：先跑 `npm run interaction:dry`，并用 `node scripts/botctl.js dry ...` 做定向验证。
- dry 检查通过后，AI 可自主执行 `tool.run` 和服内真实操作，并用结构化状态、事件和观察验证实际结果。
- 验证脚本优先走控制面（`scripts/botctl.js` / `scripts/interaction-dry-run.js` / `scripts/generate-interaction-doc.js`），避免只靠人工终端观察。
- 若 `interaction:dry` 失败，不得宣称改动已验证通过；先修复契约不一致再继续。

## 新功能验证工作流（必须遵守）
- 以后新增功能（尤其是观察/交互/工具调用相关）必须按以下顺序验证，缺一不可。

1) **静态检查先过**
- 对改动文件执行 `node --check ...`，先保证语法无误再进入运行时验证。

2) **热重载后再测**
- 执行 `npm run bot:reload`（或 `touch open_fire`），确保测试的是最新逻辑。

3) **先看 schema 真相**
- 至少检查一项：
  - `node scripts/botctl.js schema ctl`
  - `node scripts/botctl.js schema observe`
  - `node scripts/botctl.js schema tool`
- 涉及交互契约变更时，执行 `npm run interaction:docgen` 更新 `docs/interaction.generated.md`。

4) **先 dry，再自主实跑**
- 先执行 `npm run interaction:dry`。
- 再用 `node scripts/botctl.js dry ...` 针对新功能做定向验证。
- 需要验证实际行为时，由 AI 自主执行 `tool.run` 与服内实操；检查完成状态、取消行为和失败诊断，不把启动成功当成任务完成。

5) **观察类能力必须走 read-only dry 取证**
- 统一通过 `node scripts/botctl.js dry observe_detail ...` 验证。
- 示例：
  - 附近实体：`node scripts/botctl.js dry observe_detail what=entities radius=32 max=20`
  - 附近猫名：`node scripts/botctl.js dry observe_detail what=cats radius=32 max=10`
  - 容器内容：`node scripts/botctl.js dry observe_detail what=containers radius=20 max=8`

6) **失败必须带可诊断信息**
- 禁止只报“失败/不行”。
- 观察容器失败时必须输出 `error/openErrors` 等字段并继续定位，不可跳过。

7) **完成一定量改动后检查文档漂移**
- 当改动涉及契约、入口、脚本或运行方式时，必须同步检查 `docs/`、`README*`、目录级 `AGENTS.md` 是否仍与实现一致；若不一致，先修正文档再结束任务。

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
