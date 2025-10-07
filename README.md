# Mineflayer Bot Helper

An opinionated Mineflayer bot with hot‑reloaded behaviors and optional DeepSeek‑powered AI chat. Edit logic live without disconnecting.

## Setup
- Install deps: `npm install`
- Server env (optional): `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD`, `MC_DEBUG` (default 1), `MC_GREET` (default 1)
- AI env (optional): `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_PATH`, `DEEPSEEK_MODEL`

## Run
- `npm start` — single process with in‑place hot reload
- `npm run dev` — nodemon restart (reconnects). Prefer editing under `bot_impl/` to hot reload.

### Quick Configuration
- Change bot name: `MC_USERNAME=MyBot npm start` or `npm start -- --username MyBot`
- Disable greeting: `MC_GREET=0 npm start` or `npm start -- --greet off`
- Set server: `MC_HOST=localhost MC_PORT=25565 npm start` or `npm start -- --host localhost --port 25565`
- Auth modes: `MC_AUTH=offline` (default) or `microsoft` (use `MC_PASSWORD` where applicable)
- Reduce logs: `MC_DEBUG=0 npm start`

### AI Reply Length / Tokens
- Increase reply tokens (model output): use CLI `.ai budget maxtokens 512` (default used for request `max_tokens`).
- Increase chat reply text length (post-trim): `.ai reply maxlen 240` (default 240).

## Highlights
- Hot reload without reconnect: change files under `bot_impl/` and the bot reloads logic in‑process; shared state persists when possible.
- DeepSeek API integration: chat messages starting with `owk` are routed to DeepSeek for concise replies; the AI can call safe tools via a simple TOOL line.

## Built‑in Behaviors
- Auto‑swim: if feet/head are in water, keep jump pressed; in deep water push a short surface goal to break the waterline.
- Auto‑eat: replenish hunger with best available food and avoid conflicting with higher‑priority actions.
- Auto‑gear: equip best armor/weapon/shield; no thrash when already wearing the best.
- Auto‑armor‑craft: craft and equip iron armor when you have enough ingots and a nearby crafting table.
- Auto‑plant: plant saplings on valid blocks with spacing.
- Auto‑fish: approach shoreline, equip rod and fish; coordinates with other modules using locks.
- Follow (iron nugget): follow nearest holder; explicit door open‑and‑pass; no block breaking.
- Fire watch: detect/put out nearby fire.
- World sense: lightweight sensing + simple anti‑trap.

## New: Pathfind to Nearest Block
- Tool: `goto_block{names?|name?|match?, radius?, range?}`
  - Optional: `dig?: true` to allow breaking obstacles (default false to avoid destroying scaffolding/ladders).
- Examples:
  - Go to nearest bed: `TOOL {"tool":"goto_block","args":{"match":"bed","radius":48}}`
  - Go to nearest bed (force dig if blocked): `TOOL {"tool":"goto_block","args":{"match":"bed","radius":48,"dig":true}}`
  - Go to nearest crafting table: `TOOL {"tool":"goto_block","args":{"name":"crafting_table"}}`
  - Go to nearest logs: `TOOL {"tool":"goto_block","args":{"match":"_log","radius":32}}`

Note: Night sleep is automatic when near a bed; `goto_block{match:"bed"}` pairs well with it.

## CLI (terminal) Commands
- `.collect [radius=N] [max=N] [match=substr|names=a,b] [until=exhaust|all]`
- `.place <item> [on=a,b] [radius=N] [max=N] [spacing=N] [collect=true|false]` (alias `.plant`)
- `.autoplant on|off|status|interval ms|radius N|max N|spacing N`
- `.autoarmor on|off|status|interval ms|radius N|now|debug on|off`
- `.autofish on|off|status|interval ms|radius N|now|debug on|off`
- `.swim on|off|status|interval ms|surface ms|scanup N|hold ms|debug on|off`
- `.follow status|debug on|off|door on|off|dig on|off|parkour on|off|towers on|off`
- `.ai ...` — configure AI key/model/base/path, list tools

## Hot Reload Details
- `bot.js` watches `bot_impl/` recursively, unloads old modules, calls `deactivate()`, and loads the new `index.js`.
- Modules use a reload‑safe start pattern (see AGENTS.md): start timers on `spawn`, when `state.hasSpawned` is true, and immediately on install (guarded) to work under hot reload.
- Shared state is handed back via `activate()` → `{ sharedState }` and persisted across reloads.

## Development
- CommonJS, 2‑space indent, no semicolons.
- Prefer adding features under `bot_impl/` to benefit from hot reload.
- Save atomically under `bot_impl/` (watcher debounce ~120ms).

## CLI Overrides
All env vars can be overridden via CLI flags when using `npm start`:
- `--host`, `--port`, `--username|--user`, `--auth`, `--password`, `--greet on|off`
Example: `npm start -- --host my.server --port 25565 --username MyBot --greet off`
