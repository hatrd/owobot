# 自主生活

`life/` 是常驻的确定性生活调度器，通过现有 controller 租约与可取消任务执行活动，不调用聊天 LLM。默认关闭；首次启用时把当前位置设为家，后续启用保留原来的家。家应设在可步行到达的安全位置，不会根据告示牌或自然语言猜家在哪里。

```bash
# 实跑前检查：只读状态、决策预览和配置 schema
npm run interaction:dry
node scripts/botctl.js dry observe_detail what=life
node scripts/botctl.js dry life_configure op=enable 'args={"maxRadius":32}'

# dry 检查通过后，AI 可自主执行：首次把当前位置设为家并启用
node scripts/botctl.js run life_configure op=enable
# 将当前位置重新设为家（也可传 args.home 的 x/y/z，维度取当前维度）
node scripts/botctl.js run life_configure op=set_home
node scripts/botctl.js run life_configure op=disable
```

参数机器真相是 `schema tool` 与 `dry observe_detail what=life` 返回的 `schemas`。可调活动半径 `maxRadius`（默认 32，8–128）、闲逛间隔 `wanderIntervalMs`（默认 20 秒）、同猫喂食冷却 `feedCooldownMs`（默认 10 分钟，最少 5 分钟）。读取/预览和配置 dry 不启动调度、不保存设置、不申请控制权。未启用时 preview 明确标记 hypothetical；尚未设家时以当前位置作假设并标记 homeAssumed。

## 行为与优先级

- 未出生、维度不符、生命低于 16、食物低于 10、缺氧/游泳恢复/正在进食、玩家或外部任务占用时让出控制。死亡和 stop/reset 持久化关闭自主生活，需显式再次启用；AI 应遵守用户的停止指令。
- 时间达到 12000 ticks（傍晚）停止逛街/喂猫，步行回家；到家后休息到天亮。雷暴或观察到附近敌对生物也优先回家。这里的“休息”是在家停留，不承诺睡床或跳过夜晚。
- 白天有生鳕鱼或生鲑鱼时，可接近 16 格内、家活动半径内的猫并尝试喂一次。按实体 UUID 记录冷却，不依赖名字。两只猫之间至少间隔一分钟。喂食预留在动作前落盘，即使失败、取消或重载也不立刻重试。临交互再次确认距离、身份、视线和手持物；仅物品数量减少才记为已确认，超时返回 feed_not_confirmed。
- 其余时间选择已加载、局部可通行、较少访问且在家半径内的地形候选，每次短途移动后歇一会儿。近期失败的目标五分钟内避开；动作失败退避一分钟，回家失败也保留原因并稍后重试。
- 不挖掘、不搭柱。单次移动最多 45 秒；候选连通性不是完整寻路保证。远距离传送超出家半径加 8 格时暂停，避免把传送点误设成新家。

## 状态与生命周期

`state.life.document` 保存启用设置、家坐标与维度、访问/失败记录、喂食尝试；`state.life.runtime` 保存活动、原因、当前控制会话、下次决策时间、最近结果和有界事件。持久化文件为 `data/life-<worldId>.json`，worldId 复用探索记忆。每类记录最多 64 条，小文件原子写入并 fsync；保存失败即停止调度，损坏文件不会被空数据覆盖。事件记录到 `life.transition`。

热重载撤销当前动作，不重放未确认的交互；保留配置与冷却，新的驱动重新观察后规划。已显式启用的设置在进程重启后继续生效；重连等待 spawn。stop/reset 和死亡关闭配置，所以不会在下一次 tick 偷偷再出发。手动修改类工具或外部控制器申请租约会抢占自主活动，并给它至少 30 秒让路期。只读观察不打断自主活动。

喂猫使用 controller 的显式 `feed_cat` 节点，区别于旧的批量 feed_animals 工具。它是一次有界交互；生存中断会取消该节点，不能从头重复。寻路仍由共享导航驱动负责；新增玩法应保持同样的完成、取消与可查询状态契约。

## 验证

`__tests__/life.test.js` 用 mock 时间和世界验证昼夜切换、控制交接、取消迟到结果、冷却持久化、损坏文件、dry 无副作用和喂食确认。线上先做 schema 与 read-only dry；通过后 AI 可启用自主生活，实测走路、回家和喂食，并读取任务状态与结果完成验收。
