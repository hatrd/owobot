# Mineflayer Bot Helper

Mineflayer bot with hot reload and optional AI chat.

## Setup
- Install: `npm install`
- Server env (optional): `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD`, `MC_DEBUG` (default 1), `MC_GREET` (default 1)
- AI env (optional): `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_PATH`, `DEEPSEEK_MODEL`

## Run
- `npm start` — hot‑reloadable single process
- `npm run dev` — nodemon restarts (use when editing `bot.js`)

### Quick Configuration
- Change bot name: `MC_USERNAME=MyBot npm start` or `npm start -- --username MyBot`
- Disable greeting: `MC_GREET=0 npm start` or `npm start -- --greet off`
- Set server: `MC_HOST=localhost MC_PORT=25565 npm start` or `npm start -- --host localhost --port 25565`
- Auth: `MC_AUTH=offline|microsoft` (use `MC_PASSWORD` if needed)
- Reduce logs: `MC_DEBUG=0 npm start`

### AI Reply Size
- Increase model output tokens: `.ai budget maxtokens 512`
- Increase post‑trim length: `.ai reply maxlen 240`

## AI Chat Usage
- Trigger: first 3 alnum chars of bot name (e.g. `owk`).
- Info queries (how many/any/which/where/distance): answer from context; use `observe_detail` only if needed; do not call world‑changing tools.
- Actions: output a single line `TOOL {"tool":"<name>","args":{...}}` with no extra text.
- Safety defaults: never attack players unless explicitly named; do not dig unless `dig:true`.
- Immediate stop: natural language “stop/cancel/停止/停下” maps to `reset{}`.

Examples
- Defend current spot: say “owk, 守点清怪” → `defend_area{}`
- Defend a player (follow + protect): `TOOL {"tool":"defend_player","args":{"name":"Ameyaku"}}`
- Right-click mount a player (empty hand): `TOOL {"tool":"mount_player","args":{"name":"Ameyaku"}}`
- Go to nearest bed: `TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
- Toss main‑hand: `TOOL {"tool":"toss","args":{"slot":"hand"}}`

## Highlights
- Hot reload by editing `bot_impl/`; shared state is preserved across reloads when possible.
- DeepSeek integration: AI routes via TOOL calls on a safe toolset.

## Built‑in Behaviors
- Auto swim/eat/gear/armor craft/plant/fish; follow by iron nugget; fire watch; lightweight world sense.

## Pathfinding to Nearest Block
- Tool: `goto_block{names?|name?|match?, radius?, range?, dig?}` (no digging by default)
- Examples:
  - Bed: `TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
  - Force dig if blocked: `TOOL {"tool":"goto_block","args":{"match":"bed","radius":48,"dig":true}}`
  - Crafting table: `TOOL {"tool":"goto_block","args":{"name":"crafting_table"}}`
  - Logs: `TOOL {"tool":"goto_block","args":{"match":"_log","radius":32}}`
Note: approaching a bed will attempt to sleep automatically.

## Combat / Defense Tools
- Defend area: `defend_area{radius?,tickMs?,dig?}` — stand near the anchor, attack hostiles; no digging by default. For mob farms exposing only feet, the bot cycles multiple aim heights to land hits.
- Defend player: `defend_player{name, radius?, followRange?, tickMs?, dig?}` — follows the player and clears hostiles nearby.
- Cull hostiles: `cull_hostiles{radius?,tickMs?}`

## CLI Commands
- `.collect [radius=N] [max=N] [match=substr|names=a,b] [until=exhaust|all]`
- `.place <item> [on=a,b] [radius=N] [max=N] [spacing=N] [collect=true|false]` (alias `.plant`)
- `.autoplant on|off|status|interval ms|radius N|max N|spacing N`
- `.autoarmor on|off|status|interval ms|radius N|now|debug on|off`
- `.autofish on|off|status|interval ms|radius N|now|debug on|off`
- `.swim on|off|status|interval ms|surface ms|scanup N|hold ms|debug on|off`
- `.follow status|debug on|off|door on|off|dig on|off|parkour on|off|towers on|off`
- `.ai ...` — configure AI key/model/base/path; list tools

## Hot Reload
- `bot.js` watches `bot_impl/`, unloads old modules, calls `deactivate()`, then loads the new `index.js`.
- Modules follow a reload‑safe start pattern: run on `spawn`, when `state.hasSpawned` is true, and immediately on install (guarded).
- `activate()` returns `{ sharedState }` to persist state across reloads.

## Development
- CommonJS, 2‑space indent, no semicolons.
- Prefer putting features under `bot_impl/` for reload; keep `bot.js` as loader/wiring.
- Save atomically under `bot_impl/` to avoid partial reloads.

## CLI Overrides
All env vars are overridable via CLI:
- `--host`, `--port`, `--username|--user`, `--auth`, `--password`, `--greet on|off`
Example: `npm start -- --host my.server --port 25565 --username MyBot --greet off`
## AI Chat Usage
- 触发词: 机器人名称的前 3 个字母/数字（例如 `owk`）。以触发词开头的聊天会进入 AI 模式。
- 查询类问题（多少/有无/哪些/在哪里/距离多远）：优先直接回答已有“游戏上下文”，必要时使用 `observe_detail`。不会调用修改世界的工具。
- 动作类需求：AI 以一行 `TOOL {"tool":"<名字>","args":{...}}` 调用工具，不附带其他文字。
- 安全默认：不攻击玩家（除非明确“追杀 <玩家名>”）、不挖掘（除非工具参数 `dig:true`）。
- 立即停止：自然语言“停止/停下/停止追击/不要攻击/stop/cancel”会直接映射 `reset{}`。

常用示例
- 驻守当前位置清怪：说 “owk, 驻守当前位置清怪” → `defend_area{}`
- 跟随并保护玩家：`TOOL {"tool":"defend_player","args":{"name":"Ameyaku"}}`
- 去最近的床：`TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
- 丢出主手物品：`TOOL {"tool":"toss","args":{"slot":"hand"}}`
