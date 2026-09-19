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

已观测 route 记录的落脚点下方一格也是禁挖支撑。开掘若会破坏旧阶梯，返回 `recorded_route_support` 和对应记忆 id；不能因为机器人当前站在别处就挖掉返程所需的地板。路线损坏时先按实际方块检查修复，修复旧段后可将被替代的路线保存在远征检查点的 `supersededRoutes` 中，活动 `route` 只保留当前可用路线。

`scripts/expedition-return.js --steps=40 --dry` 验证最近的返程航点；去掉 `--dry` 后按活动远征路线倒序行走，最多80步，拒绝不匹配的世界、路线摘要或当前位置。独立原子检查点 `data/diamond-return-<worldId>.json` 保存下一索引、任务回执和真实钻石数。失败停止且非零退出；路线改变后必须重新检查旧返程记录，不能继续沿旧摘要执行。到达 `mine_route_returned` 只证明回到已录制矿道的起点，地表水路、家坐标和最终钻石数仍需独立验证。

## 目标级采钻执行

```bash
node scripts/mine-diamonds.js --target=64 --home=home:diamond-expedition --return-route=route:diamond-expedition-home --dry
node scripts/mine-diamonds.js --target=64 --home=home:diamond-expedition --return-route=route:diamond-expedition-home
```

这是准备好工具、采矿区和已观测返家路线之后的目标执行器。`target` 是背包 diamond 总数；本轮初始数量为0，因此64也代表新增64颗。外部 agent 不再选择逐格坐标：只读 `controller_read op=mining.plan` 在本地已加载方块上进行有界路径搜索，绕过液体、保护区和旧路线支撑，同时避免新路线挖掉自己的支撑。当前开掘搜索支持水平和逐格下降，未找到安全矿脉路线时返回结构化诊断，不猜测未加载地形。脚本自动观察、选矿脉、清理普通石料、执行、确认真实入包数，然后倒序走矿道和返家路线；危险或未知失败停止并保存诊断。它不自动制造缺失的镐子，也不会把失败称为完成。

返家路线是 observed 的 route 记录，fact 为 `{"actions":[{"action":"goto","args":{...}},{"action":"surface_travel","args":{...}}]}`；所有动作在开始前按控制器 schema 验证。配置与阶段存入 `data/diamond-goal-<worldId>.json`，相同命令恢复原目标；SIGINT/SIGTERM 会转发给当前段并释放当前返家租约。结束必须同时实测钻石数量、存活、维度和家坐标，单独达到数量不算完成。

返程不会盲信历史航点：每段先通过只读导航搜索，优先连接前方最多8个历史节点内更早的可达节点；只有 `success` 路径证据才允许跳过中间节点，`partial`/超时不算可达。这样旧矿道的局部变动可由本地重规划消化。当前位置必须仍在当前路线段附近；段中取消后可以重新观察再恢复。`node scripts/mine-diamonds.js --status` 返回保存的目标状态和实时位置、生命及钻石数。

任务记录可显式携带 `inventoryHold: ["diamond", "diamond_block"]`。后台物品压缩与自动铁甲制作读取该结构化保留策略，避免在目标段之间改变或消耗被保留的物品；内存损坏时拒绝后台转换。采钻目标自动建立此保留记录，并通过真实配方查询将已有钻石块还原为钻石后验收。保留记录持久化到目标完成之后，需明确删除或设置 expiresAt 才释放，防止刚验收完又被后台压缩。

地表返程也会对连续的 goto 航点做只读可达性重规划，但绝不会跨过 `surface_travel` 水路切换点。此能力只绕行已有通路，不靠破坏玩家建筑“修路”。

钓鱼目标：[`scripts/fish.js` / `fishing_goal`](fishing.md) 在本地持久执行补给、选岸、钓获、受伤撤退、夜间睡觉和返家；无需外部模型逐次抛竿或指定航点。生鳕鱼/鲑鱼保留给猫，烹饪不属于该目标。
