# Mineflayer Bot Helper

一个带热重载与可选 AI 聊天的 Mineflayer 机器人。

## 安装
- 安装依赖：`npm install`
- 服务器环境变量（可选）：`MC_HOST`、`MC_PORT`、`MC_USERNAME`、`MC_AUTH`、`MC_PASSWORD`、`MC_DEBUG(默认1)`、`MC_GREET(默认1)`、`MC_LOG_DIR`(默认 `./logs`)、`MC_LOG_FILE`（自定义路径或 `off`）
- AI 环境变量（可选）：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_PATH`、`DEEPSEEK_MODEL`

## 运行
- `npm start`（单进程热重载）
- `npm run dev`（nodemon 重启，修改 `bot.js` 时使用）

### 快速配置
- 更改机器人名：`MC_USERNAME=MyBot npm start` 或 `npm start -- --username MyBot`
- 关闭打招呼：`MC_GREET=0 npm start` 或 `npm start -- --greet off`
- 设置服务器：`MC_HOST=localhost MC_PORT=25565 npm start` 或 `npm start -- --host localhost --port 25565`
- 登录方式：`MC_AUTH=offline|microsoft`（如需 `MC_PASSWORD`）
- 降低日志：`MC_DEBUG=0 npm start`
- 调整自动迭代频率：`AUTO_ITERATE_INTERVAL_MS=300000 npm start` 或 `npm start -- --iterate-interval 5m`
- 放宽 Codex 超时：`CODEX_EXEC_TIMEOUT_MS=180000 npm start`（≤0 表示无限制）
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
    - 支持 `world|dim` 过滤，支持 `armor_*` / `health_*` 阈值过滤。
    - 输出会包含生命/盔甲（如接口提供）。
  - BlueMap
    - 通过 `<base>/settings.json` 读取 `maps` 与 `liveDataRoot`，并访问每个 `/<liveDataRoot>/<mapId>/live/players.json`。
    - 使用每张地图返回的 `foreign:false` 来判定玩家实际所在维度。
    - BlueMap 不提供生命/盔甲：输出不显示 生命/盔甲；若用户问题涉及生命/盔甲（或使用了 `armor_*` / `health_*` 过滤），机器人会明确说明不知道。
- 自定义世界：BlueMap `settings.json` 会列出全部地图，自动支持。
- 示例：
  - BlueMap：`MAP_API_URL=http://example.com/maps/world/live/players.json npm start`
  - 传统：`MAP_API_URL=http://example.com/api/players.json npm start`
- 注意：环境变量在进程内固定。修改 `MAP_API_URL` 需重启进程；热重载（`touch open_fire`）只重载代码，不会更新环境变量。

## AI 聊天用法
- 触发词：机器人名的前 3 个字母/数字（如 `owk`）。
- 查询类（多少/有无/哪些/在哪里/多远）：优先直接回答上下文，必要时用 `observe_detail`，不调用会改变世界的工具。
- 动作类：只输出一行 `TOOL {"tool":"<名字>","args":{...}}`。
- 安全默认：不攻击玩家（除非明确“追击 <玩家名>”、“追杀 <玩家名>”或“攻击 <玩家名>”）、不挖掘（除非 `dig:true`）。
- 立即停止：说“停止/停下/停止追击/不要攻击/stop/cancel”→ `reset{}`。

常用示例
- 驻守当前位置清怪：说 “owk, 驻守当前位置清怪” → `defend_area{}`
- 跟随并保护玩家：`TOOL {"tool":"defend_player","args":{"name":"Ameyaku"}}`
- 用弓射击最近的铁傀儡：`TOOL {"tool":"range_attack","args":{"match":"iron_golem"}}`
- 对玩家右键上坐（空手）：`TOOL {"tool":"mount_player","args":{"name":"Ameyaku"}}`
- 去最近的床：`TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
- 丢出主手物品：`TOOL {"tool":"toss","args":{"slot":"hand"}}`

## 功能亮点
- 修改 `bot_impl/` 可热重载逻辑，尽量不掉线；共享状态在重载间保留。
- DeepSeek 接入：以触发词开头的消息走 AI，AI 通过 TOOL 调用安全工具集。

## 内置能力
- 自动游泳、自动进食、自动装备、自动合成盔甲、自动种植、自动钓鱼、铁粒跟随、火源灭火、世界轻感知。

## 就近寻路（方块）
- 工具：`goto_block{names?|name?|match?, radius?, range?, dig?}`（默认不挖掘）
- 示例：
  - 最近的床：`TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
  - 被阻挡强制开路：`TOOL {"tool":"goto_block","args":{"match":"bed","radius":48,"dig":true}}`
  - 最近工作台：`TOOL {"tool":"goto_block","args":{"name":"crafting_table"}}`
  - 最近原木：`TOOL {"tool":"goto_block","args":{"match":"_log","radius":32}}`
提示：靠近床会自动尝试睡觉。

默认挖掘策略（精简版）
- 大多数工具默认不挖掘，除非传入 `dig:true`：`goto`、`goto_block`、`follow_player`、`collect|pickup`、`mount_near`、`mount_player`、`flee_trap`、`place_blocks`、`cull_hostiles`。
- 专用采集工具内部自带挖掘：`break_blocks`、`gather`、`harvest` 会自行选工具并做安全检查。
- 矿脉挖掘技能为提高效率，使用更激进的寻路/移动策略；其它工具保持保守策略。

## 战斗/防御工具
- 守点清怪：`defend_area{radius?,tickMs?,dig?}`（默认不挖掘；刷怪塔“只露脚”会尝试多种瞄准高度）
- 护卫玩家：`defend_player{name, radius?, followRange?, tickMs?, dig?}`（跟随并清怪）
- 半径清怪：`cull_hostiles{radius?,tickMs?}`
 - 远程射击：`range_attack{name?, match?, radius?, followRange?, durationMs?}` — 使用弓/弩通过 HawkEye 射击目标。玩家需指名 `name`；非玩家可用 `match`（如 `iron_golem`）。

## CLI 命令
- `.collect [radius=N] [max=N] [match=substr|names=a,b] [until=exhaust|all]`
- `.place <item> [on=a,b] [radius=N] [max=N] [spacing=N] [collect=true|false]`（别名 `.plant`）
- `.autoplant on|off|status|interval ms|radius N|max N|spacing N`
- `.autoarmor on|off|status|interval ms|radius N|now|debug on|off`
- `.autofish on|off|status|interval ms|radius N|now|debug on|off`
- `.swim on|off|status|interval ms|surface ms|scanup N|hold ms|debug on|off`
- `.follow status|debug on|off|door on|off|dig on|off|parkour on|off|towers on|off`
- `.ai ...`（配置 AI key/model/base/path，查看工具）
- `.iterate status|interval <时长>|run|cooldown <时长>|reset` — 在线调整自动 Codex 迭代周期（时长支持 ms/s/m/h 后缀；`reset` 将日志游标移动到当前末尾）
- `.pulse status|on|off|now` — 控制自动 DeepSeek 聊天脉冲（定期汇总玩家聊天并主动发言）

## 种植
- 收割并重种：`harvest{only?, radius?, replant?}`
  - 示例：
    - 收获并重种马铃薯：`TOOL {"tool":"harvest","args":{"only":"potato"}}`
    - 自动识别作物（按原作物重种）：`TOOL {"tool":"harvest","args":{}}`

## 畜牧
- 喂动物：`feed_animals{species?, item?, radius?, max?}`（`max: all|0` 表示喂半径内所有可喂目标）
  - 示例：用小麦喂附近的牛：`TOOL {"tool":"feed_animals","args":{"species":"cow","item":"wheat","max":"all"}}`

## 热重载
- `bot.js` 递归监听 `bot_impl/`，卸载旧模块，调用 `deactivate()`，再加载新 `index.js`。
- 模块使用“热重载安全”模式：`spawn`+`state.hasSpawned`+即时受控启动。
- `activate()` 返回 `{ sharedState }` 以在重载间复用。

## 开发规范
- CommonJS、2 空格缩进、无分号。
- 新功能优先放在 `bot_impl/`，便于热重载；在 `bot.js` 只做装载/监听。
- 在 `bot_impl/` 下保存需原子性，避免不完整热重载。

## CLI 覆盖
运行时环境变量均可被 CLI 覆盖：
- `--host`、`--port`、`--username|--user`、`--auth`、`--password`、`--greet on|off`
示例：`npm start -- --host my.server --port 25565 --username MyBot --greet off`
