# 小脑：外部规划、确定性动作与长期证据

外部模型负责目标分解；本地控制器负责租约、完成、取消、危险中断和结构化回执。模型不需要写 JS 或把自然语言状态交给正则解释。

```bash
node scripts/cerebellum.js schema
node scripts/cerebellum.js goto '{"x":10,"y":64,"z":20,"range":1}' --dry
node scripts/cerebellum.js goto '{"x":10,"y":64,"z":20,"range":1}'
node scripts/botctl.js dry observe_detail what=excavation radius=32 max=12
node scripts/botctl.js dry observe_detail what=knowledge max=10
```

`cerebellum.js` 自动申请/续租、创建短任务、等待终态并回收行为。JS 调用 `session(owner)` 后使用 `action(name,args,timeoutMs)`；finally 调用 `close()`。长期会话复用同一个租约，最多 100 个任务后应关闭并重新申请。stdio、模型无关 SDK 仍是 `controller-client.js`。所有参数以 `controller_read op=schema` 为准。

新增行为 `excavate` 只挖指定坐标且要求方块 ID 与 expected 相符；必须可见可达、血量至少16、食物至少10、镐耐久至少33、背包至少两个空位。不自动挖路。完成以服务器更新后的目标方块为准，不代表掉落已进背包。`discard` 只允许明确列出的普通开掘材料并保留 keep 数量。`storage_transfer` 对指定容器和物品执行单次存取，回执包含 before/after/transferred；失败可能已产生部分效果，必须观察再规划，不能盲重试。危险中断这些修改动作时取消任务，不自动重放。行走使用独立 goto。

`observe_detail what=excavation` 返回真实背包、耐久、组件附魔、空位和已加载范围内的钻石矿。精准采集矿石不等于钻石物品；目标验收必须统计 `diamond`。扫描不加载未知区块。

## 长期记忆

`controller_read op=knowledge.query` 按 id/kind/subject/dimension 精确查询，可分页。`controller_write op=knowledge.put|knowledge.remove` 需要租约。空间记录必须提供 dimension/position/radius；记录类型为 home/protected/mining/hazard/route/resource/player/task。每条记录明确 fact/source/confidence（observed/reported/inferred），可以带 expiresAt。玩家主体优先使用 UUID；玩家偏好来自其明确表达或模型标注，系统不会凭昵称或聊天关键词猜测。

文件 `data/knowledge-<worldId>.json` 以 0600 权限、fsync 和原子 rename 写入，成功后才发布到 `state.knowledge.document`。热重载保留状态，进程启动重新加载。世界身份沿用 exploration 的 worldId。最多2000条、读取上限8MiB，满额拒绝写入而不删除保护区；损坏文件拒绝写入和开掘。旧聊天人物档案与探索档案保留，各自的观察/来源不自动变成新证据。接口适用于任何外部模型，不依赖向量库或模型供应商。

## 开掘保护

所有 `bot.dig` 调用与路径规划的 safeToBreak 共同执行 `safety.checkDig`。home/protected 是整个高度的水平圆形禁挖区域；它们优先于 mining。只有 observed 且未过期的 mining 区域允许开掘，并且仅限明确列出的天然地层与矿石策略。禁止挖脚下、未知邻格、邻接液体和不安全顶盖。

这是一项保守的开掘权限策略，不能从客户端方块推断所有权：玩家也能用天然石头建造。外部模型必须根据观察把建筑区域写成 protected，不能把“石头”当作无人建筑的证明。没有确认 mining 区域时默认不挖。当前保护只管破坏方块；放置、容器存取仍要求规划者使用明确目标，不能把它当服务器领地插件。

采钻执行目标：出发前记录 home 和初始钻石数、保护住宅、存放非必需品并记住箱子、确认镐附魔、规划可逆路线；每段先观察后挖，危险拒绝后改道；成功条件为新增64颗 diamond、生命存活且实际返回 home。失败/尚在进行必须保留明确进度，不能把启动任务当作成功。

水面通行与地图层见 [navigation.md](navigation.md)。`surface_travel` 有明确干燥落脚点、氧气和时间限制。挖掘计时与镐子选择也读取现代物品组件，修正上游旧 NBT 接口漏读效率/精准采集的问题；钻石矿要求非精准采集镐，避免把矿石误计为钻石。

玩家事件自动按 UUID（缺失时使用服务器用户名）更新 player 证据，保留最近10次见面/聊天原话；不从原话推断偏好。模型写入的其他 player 记录可使用独立 id，避免被事件记录覆盖。

`tunnel_step` 只允许相邻水平一格，脚部高度保持或下降一格。先确认目标底部是干燥实体，再自上而下调用受保护的 excavate 清出空间，最后等待 goto 到达；部分成功后失败会返回 cleared 列表。规划者逐步记录路线，可沿阶梯原路返回。`smelt` 只使用明确坐标的空熔炉，显式给出 input/output/count/fuel/fuelCount，最多8件、120秒；中断不会自动撤销炉内材料，重试前必须读容器。`what=excavation` 同时给出最近储物/熔炼/水面通行状态。

mining 记录可附 minY/maxY，限制开掘高度；home/protected 始终保护整列，不受这些高度字段影响。`scripts/diamond-expedition.js --direction=north --steps=16 --floor=-54 --dry` 预览有限段阶梯计划，去掉 --dry 后逐步执行并记录原子检查点、路线事实和真实钻石数；遇危险或工具失败停止当前段并保留诊断，外部规划者重新观察后决定下一段。它不会自动宣布64颗钻石任务已完成，也不自动将失败动作重放。

远征脚本在空位少于4格时，只为数量最多的一种普通开掘材料保留最多32块搭路储备，其余普通石料清空；食物、工具、矿物和其他物品不在丢弃名单中。每次清理后重新观察背包，失败以非零退出码停止，保留检查点。
丢弃动作临时转向当前朝向的背面水平投掷，再恢复视角，减少沿原方向前进时的重新拾取；回执只证明当次背包变化，后续行走仍需观察空位。
