# 可复现的上游修复

修改过的上游库使用 `hatrd` 的 fork；`package.json` 固定不可变提交，`package-lock.json` 固定解析结果。集成分支统一为 `mcbot/integration`，升级时先在独立目录执行 `npm ci`，不要依赖手改 `node_modules`。

| 库 | 固定提交 | 集成内容 / 上游 PR |
| --- | --- | --- |
| [hatrd/prismarine-item](https://github.com/hatrd/prismarine-item/tree/mcbot/integration) | `bf484256627463726cf0a3b29c2f6da0a435d857` | [#190](https://github.com/PrismarineJS/prismarine-item/pull/190)：现代物品和附魔书组件转换成标准附魔接口 |
| [hatrd/mineflayer-pathfinder](https://github.com/hatrd/mineflayer-pathfinder/tree/mcbot/integration) | `3d2784b8df67578a3dd488bdeb3b72b9774fcbf5` | [#384](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/384) 水生方块；[#385](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/385) 落差；[#386](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/386) 同步取消；[#387](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/387) 选镐读取标准附魔接口 |

`prismarine-item` 通过 npm overrides 覆盖全部间接依赖，包括 Mineflayer、pathfinder、prismarine-block/entity/windows。Mineflayer 的挖掘计时本身已使用 `item.enchants`，因此不需要另改 Mineflayer。没有修改的库保留 registry 依赖并由 lockfile 固定。

Pathfinder 集成以 upstream `5872016` 为基线，依次 cherry-pick 原始提交 `6cb3ea5`、`4bdb0cf`、`892b6eb`、`48fd361`。上游 PR #357 的 `goto()` 失败误报成功已经由基线中的 #375 (`84c3bd2`) 覆盖，未重复引入。

验证：pathfinder 集成版本 lint 和 89 个测试通过；独立空目录 `npm ci` 成功，`npm ls mineflayer-pathfinder prismarine-item` 确认所有物品库实例统一到 fork 提交。落差用例和同步取消的 8 个用例均记录了上游基线失败、修复后通过。项目仍保留本地导航的水域风险策略及挖掘保护；它们是游戏策略，不属于上游通用修复。
