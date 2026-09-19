# 液体与导航

所有服内 `Movements` 经 `bot_impl/navigation/pathfinder.js` 统一适配，禁止各入口直接导入上游。保留 Mineflayer Pathfinder 的 A* 与移动执行器；不修改 node_modules。

`liquids.js` 是液体判定的单一事实源：使用 registry ID、waterlogged/isWaterlogged 和流体 level，识别水、熔岩、气泡柱、水草、海带与含水方块。未知区块不视为空气。

默认 `wade`：优先干路（液体额外代价 8），只允许有完整实体支撑、头部不浸水的一格静水。拒绝深水、流动水、气泡柱和熔岩；`dry` 完全不踏水。完整含水方块的干燥顶面可作支撑。探索候选点使用相同判定的 dry 模式。对角移动检查中间两格，避免只检查终点造成切角入水。

观察与预览（不移动、不改目标、不加载 pathfinder 插件）：

```bash
node scripts/botctl.js dry observe_detail what=navigation
node scripts/botctl.js dry observe_detail what=navigation x=-1365 y=69 z=1349 liquidMode=wade
```

预览限定 128 格内，单次 A* 计算约 40 ms 切片、100 ms 总预算，仅输出最多 64 个节点。`partial` 表示搜索尚未完成，不能当可达；`noPath` 表示在当前加载区块和策略下无路。预览不写运行态、不代表服内执行已成功。

已确认的库边界：pathfinder 2.4.5 的 `Movements.getBlock` 默认只以 water/lava ID 标记液体，而 prismarine-physics 识别更多含水方块；因此统一适配不可省略。物理仿真、服务器碰撞和动态世界仍可能令实际执行偏离计划。当前不承诺水下洞穴潜泳或跨海；没有安全路线应返回可诊断失败，不能无限重试或强行下水。
