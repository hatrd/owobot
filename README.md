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
- Customize AI prompts: edit files under `bot_impl/prompts/` (hot reload via `touch open_fire`)

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
    - Supports `world|dim` filters (armor/health filters were removed after upstream API changes).
    - Output currently includes name/world/coordinates; health/armor fields are no longer provided.
  - BlueMap
    - Discovers all maps via `<base>/settings.json` (reads `maps` and `liveDataRoot`) and queries each `/<liveDataRoot>/<mapId>/live/players.json`.
    - Uses `foreign:false` per map to determine the player’s actual dimension.
    - Health/armor are not provided; output omits them. If a query asks for health/armor, the bot will reply it doesn’t know.
- Custom worlds: supported automatically via BlueMap `settings.json` map list.
- Examples:
  - BlueMap: `MAP_API_URL=http://example.com/maps/world/live/players.json npm start`
  - Legacy: `MAP_API_URL=http://example.com/api/players.json npm start`
- Note: Environment variables are process‑bound. Changing `MAP_API_URL` requires restarting the bot; hot reload (`touch open_fire`) only reloads code, not env.

## AI Chat Usage
- Trigger: first 3 alnum chars of bot name (e.g. `owk`).
- Info queries (how many/any/which/where/distance): answer from context; call `observe_detail` only if needed; never mutate the world just to respond.
- Actions: describe the goal plainly. DeepSeek uses function calling to pick from the allowlisted tools automatically (see `node scripts/list-tools.js` for the current schema).
- Safety defaults: never attack players unless explicitly named; do not dig unless `dig:true`.
- Immediate stop: natural language “stop/cancel/停止/停下” maps to `reset{}`.

Examples
- Defend current spot: say “owk, 守点清怪” → function call `defend_area{}`
- Defend a player (follow + protect): “owk, 保护 Ameyaku” → `defend_player{"name":"Ameyaku"}`
- Right-click mount a player (empty hand): “owk, 来坐我身上” → `mount_player{"name":"<requester>"}` (name auto-fills to the speaker)
- Shoot nearest iron golem with bow: “owk, 弓射最近的铁傀儡” → `range_attack{"match":"iron_golem"}`
- Go to nearest bed: “owk, 去最近的床” → `goto_block{"match":"bed","radius":48}`
- Toss main-hand: “owk, 丢掉主手物品” → `toss{"slot":"hand"}`

## Highlights
- Hot reload by editing `bot_impl/`; shared state is preserved across reloads when possible.
- DeepSeek integration: AI routes via DeepSeek function calling on a safe toolset.
- Built-in automations cover survival chores and can be toggled via CLI commands.

## Built‑in Behaviors
- Auto eat/back/gear/armor craft/fish/swim/plant/stash; iron-nugget follow; periodic fire watch; auto bed sleep; inventory compression; frame-based sorter; `/tpa` helper; optional AI chat.

- Tool: `goto_block{names?|name?|match?, radius?, range?, dig?}` (no digging by default)
- Example arguments:
  - Bed: `{"match":"bed","radius":48}`
  - Force dig if blocked: `{"match":"bed","radius":48,"dig":true}`
  - Crafting table: `{"name":"crafting_table"}`
  - Logs: `{"match":"_log","radius":32}`
Note: approaching a bed will attempt to sleep automatically.

Default digging policy (simplified)
- Most tools do not dig unless `dig:true`: `goto`, `goto_block`, `follow_player`, `collect|pickup`, `mount_near`, `mount_player`, `place_blocks`, `cull_hostiles`.
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
  - Example: feed nearby cows with wheat: `{"species":"cow","item":"wheat"}`
## CLI Commands
- `.collect [radius=N] [max=N] [match=substr|names=a,b] [until=exhaust|all]`
- `.place <item> [on=a,b|solid] [radius=N] [max=N] [spacing=N] [collect=true|false]` (alias `.plant`; buttons default to `on=solid`, `spacing=1`)
- `.spawnproof [radius=N] [item=name] [on=solid|block,...] [max=N] [spacing=N] [collect=true|false]` — defaults to polished blackstone buttons on any solid floor for rapid spawn-proofing; bare numbers set radius and standalone `collect` toggles pickup
- `.autoplant on|off|status|interval ms|radius N|max N|spacing N`
- `.autoarmor on|off|status|interval ms|radius N|now|debug on|off`
- `.autofish on|off|status|interval ms|radius N|now|debug on|off`
- `.swim on|off|status|interval ms|surface ms|scanup N|hold ms|debug on|off`
- `.follow status|debug on|off|door on|off|dig on|off|parkour on|off|towers on|off`
- `.ai ...` — configure AI key/model/base/path; list tools
- `.pulse status|on|off|now` — control automatic DeepSeek chat pulses (flush recent player chats and produce a proactive reply)

## Farming
- Harvest and replant crops: `harvest{only?, radius?, replant?}`
  - Examples:
    - Harvest and replant nearby potatoes: `{"only":"potato"}`
    - Auto-detect crops (harvest mature and replant same type): `{}`

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

### Developer References
- `docs/runtime-map.md` explains the long-lived shared state layout and key event hooks.
- `bot_impl/module-registry.js` lists every hot-reloadable module; edit it to add/remove behaviour safely.
- Run `node scripts/list-tools.js` to dump the AI tool allowlist as JSON (keeps prompts/docs in sync).

## CLI Overrides
All env vars are overridable via CLI:
- `--host`, `--port`, `--username|--user`, `--auth`, `--password`, `--greet on|off`
Example: `npm start -- --host my.server --port 25565 --username MyBot --greet off`
