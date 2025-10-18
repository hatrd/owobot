# Mineflayer Bot Helper

Mineflayer bot with hot reload and optional AI chat.

## Setup
- Install: `npm install`
- Server env (optional): `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD`, `MC_DEBUG` (default 1), `MC_GREET` (default 1), `MC_LOG_DIR` (default `./logs`), `MC_LOG_FILE` (custom path or `off`)
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
- Adjust auto-iteration cadence: `AUTO_ITERATE_INTERVAL_MS=300000 npm start` or `npm start -- --iterate-interval 5m`
- Scope Codex write access: `AUTO_ITERATE_REPO_ROOT=/absolute/path/to/repo npm start`
  - Remember to `touch open_fire` (or restart) after changing this value so the iterator reloads the new scope.
- Allow Codex more time: `CODEX_EXEC_TIMEOUT_MS=180000 npm start` (omit or ≤0 for no limit)
- Customize AI prompts: edit files under `bot_impl/prompts/` (hot reload via `touch open_fire`)

- **Codex sandboxing:** auto-iteration grants Codex write access only within `AUTO_ITERATE_REPO_ROOT` (defaults to the current working directory). Double-check the path before enabling to avoid exposing unrelated folders.
### File Logging
- Default path: `logs/bot-YYYY-MM-DD.log` (created automatically).
- Configure directory: set `MC_LOG_DIR=/path/to/dir`.
- Override filename or disable: set `MC_LOG_FILE=/path/to/file.log` or `MC_LOG_FILE=off`.

### AI Reply Size
- Increase model output tokens: `.ai budget maxtokens 512`
- Increase post‑trim length: `.ai reply maxlen 240`

## Player Map Integration
- Env var: set `MAP_API_URL` to a live players endpoint.
  - Legacy shape: any URL returning `{ "players": [{ "name","world","x","y","z","health?","armor?" }, ...] }`.
  - BlueMap: `http(s)://<host>/<prefix>/maps/<mapId>/live/players.json`.
- Behavior by API type:
  - Legacy API
    - Supports filters on `world|dim` and `armor_*` / `health_*` thresholds.
    - Output includes health/armor when present.
  - BlueMap
    - Discovers all maps via `<base>/settings.json` (reads `maps` and `liveDataRoot`) and queries each `/<liveDataRoot>/<mapId>/live/players.json`.
    - Uses `foreign:false` per map to determine the player’s actual dimension.
    - Health/armor are not provided; output omits them. If a query asks for health/armor (or uses `armor_*` / `health_*` filters), the bot will reply it doesn’t know.
- Custom worlds: supported automatically via BlueMap `settings.json` map list.
- Examples:
  - BlueMap: `MAP_API_URL=http://example.com/maps/world/live/players.json npm start`
  - Legacy: `MAP_API_URL=http://example.com/api/players.json npm start`
- Note: Environment variables are process‑bound. Changing `MAP_API_URL` requires restarting the bot; hot reload (`touch open_fire`) only reloads code, not env.

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
- Shoot nearest iron golem with bow: `TOOL {"tool":"range_attack","args":{"match":"iron_golem"}}`
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

Default digging policy (simplified)
- Most tools do not dig unless `dig:true`: `goto`, `goto_block`, `follow_player`, `collect|pickup`, `mount_near`, `mount_player`, `flee_trap`, `place_blocks`, `cull_hostiles`.
- Purpose-built gatherers dig internally: `break_blocks`, `gather`, `harvest` choose tools and safety on their own.
- Ore mining skill uses a more aggressive movement profile for efficiency; other tools remain conservative.

## Combat / Defense Tools
- Defend area: `defend_area{radius?,tickMs?,dig?}` — stand near the anchor, attack hostiles; no digging by default. For mob farms exposing only feet, the bot cycles multiple aim heights to land hits.
- Defend player: `defend_player{name, radius?, followRange?, tickMs?, dig?}` — follows the player and clears hostiles nearby.
- Cull hostiles: `cull_hostiles{radius?,tickMs?}`
 - Ranged attack: `range_attack{name?, match?, radius?, followRange?, durationMs?}` — use bow/crossbow via HawkEye to attack a specific player (explicit `name`) or nearest entity matching `match` (e.g., `iron_golem`). For players, you must provide an exact name.

## Farming & Ranching
- Harvest and replant crops: `harvest{only?, radius?, replant?, sowOnly?}`
- Feed animals: `feed_animals{species?, item?, radius?, max?}`
  - Example: feed nearby cows with wheat: `TOOL {"tool":"feed_animals","args":{"species":"cow","item":"wheat"}}`
## CLI Commands
- `.collect [radius=N] [max=N] [match=substr|names=a,b] [until=exhaust|all]`
- `.place <item> [on=a,b|solid] [radius=N] [max=N] [spacing=N] [collect=true|false]` (alias `.plant`; buttons default to `on=solid`, `spacing=1`)
- `.spawnproof [item=name] [on=solid|block,...] [radius=N] [max=N] [spacing=N]` — defaults to polished blackstone buttons on any solid floor for rapid spawn-proofing
- `.autoplant on|off|status|interval ms|radius N|max N|spacing N`
- `.autoarmor on|off|status|interval ms|radius N|now|debug on|off`
- `.autofish on|off|status|interval ms|radius N|now|debug on|off`
- `.swim on|off|status|interval ms|surface ms|scanup N|hold ms|debug on|off`
- `.follow status|debug on|off|door on|off|dig on|off|parkour on|off|towers on|off`
- `.ai ...` — configure AI key/model/base/path; list tools
- `.iterate status|interval <duration>|run|cooldown <duration>|reset` — manage the automation (duration accepts ms/s/m/h; `reset` moves the log cursor to current end)
- `.pulse status|on|off|now` — control automatic DeepSeek chat pulses (flush recent player chats and produce a proactive reply)

## Farming
- Harvest and replant crops: `harvest{only?, radius?, replant?}`
  - Examples:
    - Harvest and replant nearby potatoes: `TOOL {"tool":"harvest","args":{"only":"potato"}}`
    - Auto-detect crops (harvest mature and replant same type): `TOOL {"tool":"harvest","args":{}}`

## Hot Reload
- `bot.js` watches `bot_impl/`, unloads old modules, calls `deactivate()`, then loads the new `index.js`.
- Modules follow a reload‑safe start pattern: run on `spawn`, when `state.hasSpawned` is true, and immediately on install (guarded).
- `activate()` returns `{ sharedState }` to persist state across reloads.
- Reload gate (default ON): edits under `bot_impl/` do not reload immediately; touch the gate file to apply: `touch open_fire`.
  - Example: edit files → `touch open_fire` to reload once changes are ready.
  - Disable the gate if you want immediate reloads: CLI `--reload-gate off` or env `HOT_RELOAD_GATE=off`.

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
- 安全默认：不攻击玩家（除非明确“追击 <玩家名>”、“追杀 <玩家名>”或“攻击 <玩家名>”）、不挖掘（除非工具参数 `dig:true`）。
- 立即停止：自然语言“停止/停下/停止追击/不要攻击/stop/cancel”会直接映射 `reset{}`。

常用示例
- 驻守当前位置清怪：说 “owk, 驻守当前位置清怪” → `defend_area{}`
- 跟随并保护玩家：`TOOL {"tool":"defend_player","args":{"name":"Ameyaku"}}`
- 去最近的床：`TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
- 丢出主手物品：`TOOL {"tool":"toss","args":{"slot":"hand"}}`
