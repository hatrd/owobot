# 持续探索与长期记忆

连续探索需要空间证据和任务检查点。聊天记忆仍负责人物、承诺和语义记忆；`exploration/` 负责从真实观察与任务状态生成探索档案，不把聊天摘要当地图，也不从自然语言猜任务是否完成。

## 使用

```bash
# 只读观察、检索与路径候选预览
npm run interaction:dry
node scripts/botctl.js dry observe_detail what=terrain radius=8 max=12
node scripts/botctl.js dry observe_detail what=exploration_memory radius=128 max=8
node scripts/explore-survival.js --dry

# 实际探索：按仓库操作权限由真人执行，或在用户明确授权的实操任务中执行
node scripts/explore-survival.js --steps 4 --max-radius 32
node scripts/explore-survival.js --resume <missionId> --steps 4
```

控制器每轮申请并续租独占控制、保存检查点、选择未充分访问且没有近期失败的候选点、安装一个短移动行为、等待真正抵达、记录结果并回收临时行为版本。结束、失败或 Ctrl-C 会暂停探索任务、保存检查点并释放租约。下一次显式 `--resume` 使用同一档案继续，无需复制上一轮聊天上下文。

默认每次四步，最多二十步；不启动无限后台探索。出发半径默认 32，脚本允许 8–128。每步超时 20 秒，总任务 25 秒。任务开始及轮询时检查生命值、食物和已观察到的敌对生物；当前策略需要生命值 >=16、食物 >=10，没有附近敌对生物。底层继续由自动进食、防溺水等反应处理基础生存。这是短距离步行探索器，不会自动挖矿、开箱取物、建营地或与玩家聊天。

## 数据真相与持久化

`state.explorationMemory.document` 是唯一探索事实来源，内容包括：

- missions：明确的 objective、出发点 home、dimension、maxRadius、active/paused 状态、checkpoint、暂停原因。
- visits：2×2 水平网格及高度分组的实际检查点位置、观察次数、首次/最近时间与生命状态。
- landmarks：实读告示牌与具名实体，保留种类、内容、坐标、来源和观察时间。
- attempts：任务 ID、明确的终态和原因、移动目标。失败只关联真正执行失败的移动节点，不从错误文本猜目标。

文件为 `data/exploration-<worldId>.json`。worldId 默认由服务器地址/端口和机器人账号产生摘要；可配置 `MCBOT_WORLD_ID` 指定独立世界身份，服务器重置世界时也应更换这个值。各记录带维度，附近检索不会把其他维度的位置混入。任务摘要保留维度，供模型判断上下文。

写入以共享 state 中的 Promise 队列串行执行，使用独立临时文件、文件 fsync 和原子 rename；只有成功保存后才发布新 document。错误返回 `memory_save_failed` / `memory_unavailable`，不会假装记住，也不会用空数据覆盖损坏文件。已保存 revision/savedAt 可查询。加载验证文件大小与记录结构；最多 4 MiB 文件、16 个任务、2048 个访问区域、512 条发现、128 次路线结果，超额淘汰最旧记录。

重连、死亡和代码重载会暂停任务；进程重启读取文件并将原 active 任务解释为 paused，不自动执行旧动作。恢复时重新观察实际位置、维度和生命值，核对出发半径后才续探。旧异步动作的迟到结果仍由控制运行时屏蔽。

## 检索与模型上下文

`observe_detail what=exploration_memory` 和 `controller_read op=memory.recall` 返回任务摘要、附近访问记录和发现、近期路线结果、容量与保存状态。默认最多 8 条空间记录，最多 20 条；距离上限 512。具名实体超过一分钟、告示牌超过一天标记 stale；即使未过期也只是历史证据，不保证对象仍在原地。

内置聊天 AI 的记忆上下文增加一段最多 1000 字符的探索摘要，沿用现有 token 预算；需要位置细节时再查工具，不将整张地图塞入提示词。其他外部模型直接通过控制客户端读取相同档案。

## 接口与边界

`controller_read op=schema` 是操作参数的机器真相。新增 `memory.recall`（只读）、`memory.begin/resume/pause/checkpoint`（需有效租约）；`task.start` 可带 missionId，开始前验证任务状态、维度、当前位置和所有 goto 目标的出发半径。寻路中也检查实际位置是否越界。`behavior.remove` 回收不再运行的版本，不能删除活动任务绑定的版本。

`what=terrain` 对已加载方块进行有界局部连通扫描，不设置寻路目标、不移动机器人。明确排除水、岩浆、火、仙人掌等危险方块，以及未加载区域；步高与下降限制一格。候选点按近期失败、任务边界、访问次数和距离排序。该几何检查是路径候选，不保证 Mineflayer 寻路成功，也不是完整地图。当前 goto 驱动禁挖掘、禁搭柱、禁跑酷、禁冲刺，下降最多一格。

该模块不把任意方块名称、告示牌文字或自然语言任务解释成危险/完成/资源语义。更复杂的目标分解交给外部模型，状态推进仍走 schema 与明确任务事件。

## 验证证据

离线验证覆盖原子保存失败、文件损坏、结构非法、并发提交、跨进程恢复、维度隔离、实体证据过期、危险地形排除、任务边界校验、行为回收和已有取消机制。常规 dry 验证包含探索记忆和地形接口。

2026-09-19，在用户明确要求“进行简单生存、探索附近世界”后完成了两轮短距离实操（3 步 + 4 步），两轮之间热重载，第二轮显式恢复同一个 missionId；到达结果和观察已保存到本机探索档案。默认开发验证规则不因此改成自动实跑。
