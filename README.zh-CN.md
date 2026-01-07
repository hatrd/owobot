# Mineflayer Bot Helper

一个带热重载与可选 AI 聊天的 Mineflayer 机器人。

## 安装
- 安装依赖：`npm install`
- 服务器环境变量（可选）：`MC_HOST`、`MC_PORT`、`MC_USERNAME`、`MC_AUTH`、`MC_PASSWORD`、`MC_DEBUG(默认1)`、`MC_GREET(默认1)`、`MC_LOG_DIR`(默认 `./logs`)、`MC_LOG_FILE`（自定义路径或 `off`）
- AI 环境变量（可选）：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_PATH`、`DEEPSEEK_MODEL`（或 `AI_MODEL`）

## 运行
- `npm start`（单进程热重载）
- `npm run dev`（nodemon 重启，修改 `bot.js` 时使用）

### 快速配置
- 更改机器人名：`MC_USERNAME=MyBot npm start` 或 `npm start -- --username MyBot`
- 关闭打招呼：`MC_GREET=0 npm start` 或 `npm start -- --greet off`
- 设置服务器：`MC_HOST=localhost MC_PORT=25565 npm start` 或 `npm start -- --host localhost --port 25565`
- 登录方式：`MC_AUTH=offline|microsoft`（如需 `MC_PASSWORD`）
- 降低日志：`MC_DEBUG=0 npm start`
- 自定义提示词：编辑 `bot_impl/prompts/` 下的文件（改动后 `touch open_fire` 热重载）

### 文件日志
- 默认日志文件：`logs/bot-YYYY-MM-DD.log`（自动创建目录）。
- 自定义目录：设置 `MC_LOG_DIR=/path/to/dir`。
- 自定义文件名或关闭：设置 `MC_LOG_FILE=/path/to/file.log`，或 `MC_LOG_FILE=off` 关闭文件日志。

### AI 回复长度
- 增大模型输出 token：`.ai budget maxtokens 512`
- 增大文本截断长度：`.ai reply maxlen 240`

## 玩家地图集成（MAP_API_URL）
- 环境变量：将 `MAP_API_URL` 指向“在线玩家”接口（players.json）。
  - 传统接口：返回 `{ "players": [{ "name","world","x","y","z","health?","armor?" }, ...] }`。
  - BlueMap：`http(s)://<host>/<prefix>/maps/<mapId>/live/players.json`。
- 不同接口下的行为：
  - 传统接口
    - 仅支持 `world|dim` 过滤（上游接口已移除生命/盔甲筛选）。
    - 当前仅返回 名称/世界/坐标，生命/盔甲字段已移除。
  - BlueMap
    - 通过 `<base>/settings.json` 读取 `maps` 与 `liveDataRoot`，并访问每个 `/<liveDataRoot>/<mapId>/live/players.json`。
    - 使用每张地图返回的 `foreign:false` 来判定玩家实际所在维度。
    - BlueMap 不提供生命/盔甲：输出不显示 生命/盔甲；若用户问题涉及生命/盔甲，机器人会明确说明不知道。
- 自定义世界：BlueMap `settings.json` 会列出全部地图，自动支持。
- 示例：
  - BlueMap：`MAP_API_URL=http://example.com/maps/world/live/players.json npm start`
  - 传统：`MAP_API_URL=http://example.com/api/players.json npm start`
- 注意：环境变量在进程内固定。修改 `MAP_API_URL` 需重启进程；热重载（`touch open_fire`）只重载代码，不会更新环境变量。

## AI 聊天用法
- 触发词：机器人名的前 3 个字母/数字（如 `owk`）。
- 查询类（多少/有无/哪些/在哪里/多远）：优先直接回答上下文，必要时用 `observe_detail`，不调用会改变世界的工具。
- 动作类：描述需求即可，DeepSeek 会通过 function calling 自动选择安全工具（`node scripts/list-tools.js` 可查看完整 schema）。
- 安全默认：不攻击玩家（除非明确“追击 <玩家名>”、“追杀 <玩家名>”或“攻击 <玩家名>”）、不挖掘（除非 `dig:true`）。
- 立即停止：说“停止/停下/停止追击/不要攻击/stop/cancel”→ `reset{}`。

常用示例
- 驻守当前位置清怪：说 “owk, 驻守当前位置清怪” → `defend_area{}`
- 跟随并保护玩家：说 “owk, 保护 Ameyaku” → `defend_player{"name":"Ameyaku"}`
- 用弓射击最近的铁傀儡：说 “owk, 弓射最近的铁傀儡” → `range_attack{"match":"iron_golem"}`
- 对玩家右键上坐（空手）：说 “owk, 来骑我/坐我” → `mount_player{"name":"(请求者)"}`（名字自动解析）
- 去最近的床：说 “owk, 去最近的床” → `goto_block{"match":"bed","radius":48}`
- 丢出主手物品：说 “owk, 丢掉主手” → `toss{"slot":"hand"}`

## 功能亮点
- 修改 `bot_impl/` 可热重载逻辑，尽量不掉线；共享状态在重载间保留。
- DeepSeek 接入：以触发词开头的消息走 AI，AI 利用 function calling 调用安全工具集。
- 日常自动化（进食/补装/种植/钓鱼等）可通过 CLI 快速开启或调节。

## 内置能力
- 自动进食/回包、自动装备、自动合成盔甲、自动钓鱼/游泳/种植/收纳；铁粒跟随；自动灭火；床上睡觉；库存压缩；物品展示框分类；TPA 辅助；可选 AI 聊天。

## 就近寻路（方块）
- 工具：`goto_block{names?|name?|match?, radius?, range?, dig?}`（默认不挖掘）
- 示例参数：
  - 最近的床：`{"match":"bed","radius":48}`
  - 被阻挡强制开路：`{"match":"bed","radius":48,"dig":true}`
  - 最近工作台：`{"name":"crafting_table"}`
  - 最近原木：`{"match":"_log","radius":32}`
提示：靠近床会自动尝试睡觉。

默认挖掘策略（精简版）
- 大多数工具默认不挖掘，除非传入 `dig:true`：`goto`、`goto_block`、`follow_player`、`collect|pickup`、`mount_near`、`mount_player`、`place_blocks`、`cull_hostiles`。
- 专用采集工具内部自带挖掘：`break_blocks`、`gather`、`harvest` 会自行选工具并做安全检查。
- 矿脉挖掘技能为提高效率，使用更激进的寻路/移动策略；其它工具保持保守策略。

## 战斗/防御工具
- 守点清怪：`defend_area{radius?,tickMs?,dig?}`（默认不挖掘；刷怪塔“只露脚”会尝试多种瞄准高度）
- 护卫玩家：`defend_player{name, radius?, followRange?, tickMs?, dig?}`（跟随并清怪）
- 半径清怪：`cull_hostiles{radius?,tickMs?}`
- 远程射击：`range_attack{name?, match?, radius?, followRange?, durationMs?}` — 使用弓/弩通过 HawkEye 射击目标。玩家需指名 `name`；非玩家可用 `match`（如 `iron_golem`）。
- 敲盔甲架：`attack_armor_stand{radius?,range?,rate?,pos?,x?,y?,z?,dig?}` —— 默认原地输出、只攻击攻击范围内的盔甲架；可传入 `pos` 或 `x/y/z` 先走到该坐标后静止攻击（`rate` 支持 `20gt`、`1000ms` 等写法）。

## CLI 命令
- `.tab` — 打印当前玩家列表（含延迟），效果与客户端 Tab 一致
- `.collect [radius=N] [max=N] [match=substr|names=a,b] [until=exhaust|all]`
- `.place <item> [on=a,b|solid] [radius=N] [max=N] [spacing=N] [collect=true|false]`（别名 `.plant`；如放置按钮会默认使用 `on=solid` 且间距为 1）
- `.spawnproof [radius=N] [item=name] [on=solid|block,...] [max=N] [spacing=N] [collect=true|false]` — 默认使用磨制黑石按钮并针对任意实体方块铺设，便于快速做防刷怪地毯；纯数字参数会视为半径，单独写 `collect` 会开启回收
- `.autoplant on|off|status|interval ms|radius N|max N|spacing N`
- `.autoarmor on|off|status|interval ms|radius N|now|debug on|off`
- `.autofish on|off|status|interval ms|radius N|now|debug on|off`
- `.swim on|off|status|interval ms|surface ms|scanup N|hold ms|debug on|off`
- `.follow status|debug on|off|door on|off|dig on|off|parkour on|off|towers on|off`
- `.ai ...`（配置 AI key/model/base/path，查看工具）
- `.pulse status|on|off|now` — 控制自动 DeepSeek 聊天脉冲（定期汇总玩家聊天并主动发言）

## 种植
- 收割并重种：`harvest{only?, radius?, replant?}`
  - 示例：
    - 收获并重种马铃薯：`{"only":"potato"}`
    - 自动识别作物（按原作物重种）：`{}`

## 畜牧
- 喂动物：`feed_animals{species?, item?, radius?, max?}`（`max: all|0` 表示喂半径内所有可喂目标）
  - 示例：用小麦喂附近的牛：`{"species":"cow","item":"wheat","max":"all"}`

## 热重载
- `bot.js` 递归监听 `bot_impl/`，卸载旧模块，调用 `deactivate()`，再加载新 `index.js`。
- 模块使用“热重载安全”模式：`spawn`+`state.hasSpawned`+即时受控启动。
- `activate()` 返回 `{ sharedState }` 以在重载间复用。

## 开发规范
- CommonJS、2 空格缩进、无分号。
- 新功能优先放在 `bot_impl/`，便于热重载；在 `bot.js` 只做装载/监听。
- 在 `bot_impl/` 下保存需原子性，避免不完整热重载。

### 开发参考
- `docs/runtime-map.md` 总结了共享状态结构与关键事件。
- `bot_impl/module-registry.js` 统一登记所有热重载模块，新增/移除功能时只需修改这里。
- `docs/git-worktree-parallel.md` 总结了基于 git worktree 的并行 Codex 流程（分配/验收/合入子任务）。
- 运行 `node scripts/list-tools.js` 可输出当前 AI 工具白名单 JSON，帮助提示词与文档保持一致。

## CLI 覆盖
运行时环境变量均可被 CLI 覆盖：
- `--host`、`--port`、`--username|--user`、`--auth`、`--password`、`--greet on|off`
示例：`npm start -- --host my.server --port 25565 --username MyBot --greet off`
