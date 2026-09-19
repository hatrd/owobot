# 液体与导航

所有服内 `Movements` 经 `bot_impl/navigation/pathfinder.js` 统一适配，禁止各入口直接导入上游。保留 Mineflayer Pathfinder 的 A* 与移动执行器；不修改 node_modules。

`liquids.js` 是液体判定的单一事实源：使用 registry ID、waterlogged/isWaterlogged 和流体 level，识别水、熔岩、气泡柱、水草、海带与含水方块。未知区块不视为空气。

默认 `wade`：优先干路（液体额外代价 8），只允许有完整实体支撑、头部不浸水的一格静水。拒绝深水、流动水、气泡柱和熔岩；`dry` 完全不踏水。完整含水方块的干燥顶面可作支撑。探索候选点使用相同判定的 dry 模式。对角移动检查中间两格，避免只检查终点造成切角入水。

观察与预览（不移动、不改目标、不加载 pathfinder 插件）：

```bash
node scripts/botctl.js dry observe_detail what=navigation
node scripts/botctl.js dry observe_detail what=navigation x=-1365 y=69 z=1349 liquidMode=wade
```

预览限定 128 格内，单次 A* 计算约 30 ms 切片，切片间让出事件循环，约 200–250 ms 总预算，仅输出最多 64 个节点。`partial` 表示搜索尚未完成，不能当可达；`noPath` 表示在当前加载区块和策略下无路。预览不写运行态、不代表服内执行已成功。

已确认的库边界：pathfinder 2.4.5 的 `Movements.getBlock` 默认只以 water/lava ID 标记液体，而 prismarine-physics 识别更多含水方块；因此统一适配不可省略。物理仿真、服务器碰撞和动态世界仍可能令实际执行偏离计划。当前不承诺水下洞穴潜泳或跨海；没有安全路线应返回可诊断失败，不能无限重试或强行下水。

## 执行与脱困

控制器 `goto` 使用 `navigation/drive.js`：`path_update.noPath/timeout` 立即作为结构化失败返回；连续 8 秒位置无进展只重规划一次，再 8 秒无进展返回 `navigation_stalled`。到达、取消、热重载均释放当前操作的目标、计时器和监听器。诊断保存在 `state.navigation`，失败结果保存在 controller task 的 `lastResult`，不再只留下 node_timeout。

自动游泳使用独立有界局部搜索（半径 6、向上 24、最多 1200 节点），先找可呼吸水面或有支撑岸边，通过短步方向与持续上浮脱困，**不再创建 pathfinder 目标**。只在没有其他操作持有控制权时接管，贡献一个可对账的 externalBusy 计数。路线每秒重算、下一步重新检查；无进展 8 秒或总共 20 秒进入 blocked，仅保留上浮，不无限换目标。未知区块不作为出口，未找到出口会保留 `reason/visited/phase`。

控制器检测头部入水即暂停，让出控制权；脱困释放后重规划。任务第三次意外入水会终止为 `navigation_repeated_water_entry`，避免重复同一失败动作。任务总 deadline 始终有效。低氧依旧是独立暂停条件。

`state.autoSwim.runtime` 是脱困的可观测真相。热重载取消旧操作、释放自己持有的按键与 busy 贡献，不重放旧路线。`.swim on|off|status` 查询或开关脱困；旧的 surface/hold/scanup 参数已移除。

这些完成/卡住/取消保证适用于控制器 goto；旧动作的“开始前往”回执仍然只代表启动。所有入口的液体规划均已统一。默认不自动游过深水；跨海、潜水或无岸封闭水体需要另外的明确移动能力，不能声称总能走通。

氧气来自 `navigation/oxygen.js`：按 registry 的 air_supply 字段索引读取**自身实体** metadata，缺失返回 null。当前 Mineflayer 的 entities 元数据分支会把其他实体的 air_supply 写入 bot.oxygenLevel；不再将该共享字段当作当前玩家氧气真相。老版本无 metadataKeys 时才使用按自身 entityId 过滤的 breath 插件字段。
