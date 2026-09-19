# 整理战利品：外部 Agent 入口

在任意工作目录运行（脚本自动连接项目 socket）：

```sh
node /home/oyxy/src/mcbot/scripts/stash.js --help
node /home/oyxy/src/mcbot/scripts/stash.js preview
node /home/oyxy/src/mcbot/scripts/stash.js run
```

`run` 自动发现半径 64 内的箱子/木桶/潜影盒，优先访问已配置目的地，容量已足够时停止扫描，然后归仓、返回出发位置，等待终态并输出 JSON 回执。无需逐箱导航或逐槽操作。`start` 仅启动；`status` 查询；`resume` 继续并等待；`cancel` 立即取消，异步存取结算前仍保持控制权。`--timeout=300` 是 CLI 等待上限，超时不会取消后台任务；用 `status` 继续查询。退出码：0 成功，2 部分完成，3 阻塞/暂停/取消，4 等待超时，1 请求失败。

默认保留所有装备/不可堆叠物品、自定义 NBT 或现代组件物品、每种食物最多 64 个及长期记忆中的任务保留物品。相同名称中只要存在自定义版本，该名称全部保留，避免底层按名称/类型存取误选。不能用 keep=0 覆盖任务保留或装备保护；只整理玩家主背包，不整理随身潜影盒内部。

归仓依据优先级为 **显式物品坐标规则 → 展示框精确物品 → 箱中已有相同物品 → 明确配置的溢出箱**。带其他展示框标签的箱子不会被当作溢出箱。未知归属留在背包，回执为 `partial`，不随意混入玩家箱子；终态的 `suggestions` 提供已算好容量、可直接传给 configure 的候选配置。可一次配置一个合适的溢出箱，之后各类普通战利品都能自动归仓：

```sh
node scripts/stash.js configure '{"overflow":{"x":-100,"y":64,"z":200}}'
node scripts/stash.js configure '{"keep":{"oak_log":32},"routes":[{"item":"raw_copper","position":{"x":-101,"y":64,"z":200}}]}'
node scripts/stash.js resume
```

坐标为示例，需要从 `preview` 的 candidates 和扫描后的 catalog 选择实际存储。`configure` 只替换提供的字段；keep/routes 集合整体替换；overflow=null 清除溢出箱。明确路线找不到或箱满时保留物品，不悄悄改投其他箱。`run '{"radius":32,"requestId":"trip-123"}'` 可扩大本次扫描范围，同一个最近任务的 requestId 重试不会启动第二次整理。

`preview` 是只读：不走路，不打开箱子，不修改背包。未传 radius 的 preview 沿用最近任务的扫描范围。catalog 是带 observedAt 的持久历史；cachedPlan 仅作参考。真实执行会重新打开箱子，存入前再计算保留量和容量。`status --detail` 含所有逐笔回执、双边数量、计划、开箱错误和未决转移；默认 status/run 输出压缩回执。

回执需要同时满足源背包减少量和目标箱增加量。每次存取前 fsync 写入 intent；转移后落盘真实数量。热重载暂停任务，`resume` 对账未决转移再重新扫描；无法归因的变化报告 `ambiguous_transfer`，禁止盲目重试。任务死亡、换维度、受伤或返程失败都有明确诊断；受伤先停止当下动作并尝试安全返程。导航不挖掘、不搭方块，沿用已验证的陆地/水面路线。取消立即停下，不自动返家。

机器接口无需 CLI：

- `tool.schema` 的 `stash_goal`：start/resume/cancel/configure 参数。
- `tool.dry observe_detail {"what":"stash","preview":true}`：只读发现与库存策略。
- `tool.dry observe_detail {"what":"stash"}`：状态和完整操作 schema。
- `tool.dry stash_goal {"op":"start","args":{}}`：参数验证；不启动。
- `tool.run stash_goal {"op":"start","args":{}}`：启动；必须继续观察终态。

存储路线绑定配置时的维度，跨维度不会复用；箱子观测也按维度隔离。存储位于 `data/stash-<worldId>.json`，保存配置、箱子观测、当前任务和回执。`.stash on` 的旧自动触发器也使用本任务，不再把所有东西直接扔进最近的箱子；partial/blocked/paused 后不自动反复重试。重新配置后可直接 `run`。

实际接入记录：[两轮独立 Codex 实跑](traces/stash-2026-09-19.md)。
