# Repository Guidelines

## Development Principles
- 内部实现不用考虑兼容，这是一个短平快的项目，一切都以最快迭代效率为准。
- 对外接口（技能/工具）无需保持长期稳定；优先保证简洁优雅、语义清晰，并让 AI 易于调用。可以在迭代中随时调整接口，但需确保当前运行内的一致性，并保持注册表与提示文档严格同步（见“Registration gate”）。

## Project Structure & Module Organization
- Entry point: `bot.js` (creates Mineflayer bot, sets up hot reload).
- Hot‑reloadable logic: `bot_impl/` with `index.js` exporting `activate`/`deactivate`.
- Runtime deps: `node_modules/`; config via environment variables (`MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD`, `MC_DEBUG`, `MC_GREET`).
- Prefer adding new features under `bot_impl/` to benefit from hot reload. Only touch `bot.js` for loader/core wiring.

## Build, Test, and Development Commands
- `npm install` — install dependencies.
- `npm start` — run the bot once (no process restarts). Supports hot reload by editing files in `bot_impl/`.
- `npm run dev` — run with nodemon (process restarts on file changes). Use only if changing `bot.js`.
- Example: `MC_HOST=localhost MC_PORT=25565 MC_USERNAME=bot npm start`.

### Runtime Configuration (Env or CLI)
- Env vars: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH` (`offline|microsoft`), `MC_PASSWORD`, `MC_DEBUG` (`0|1`), `MC_GREET` (`0|1`).
- CLI overrides (take precedence over env): `--host`, `--port`, `--username|--user`, `--auth`, `--password`, `--greet on|off`.
- Examples:
  - Disable greeting: `MC_GREET=0 npm start` or `npm start -- --greet off`.
  - Change bot name: `MC_USERNAME=MyBot npm start` or `npm start -- --username MyBot`.
  - Reduce logs: `MC_DEBUG=0 npm start`.

## Hot Reload Workflow
- Save atomically: prepare changes fully, then write them. Avoid partial/fragmented saves under `bot_impl/` (the watcher reloads on file events, debounce ≈120ms).
- If generating files, write to a temp path and `rename` into `bot_impl/` to ensure the new version is complete when reloaded.
- For large multi-file edits, apply changes outside `bot_impl/` and move them in at once, or stop the bot temporarily.

### Spawn Is Not Reliable Under Hot Reload

Under hot‑reload the `spawn` event is not guaranteed to fire for newly reloaded modules (the bot is already spawned). Do NOT rely solely on `on('spawn', ...)` to start timers/watchers.

Use a reload‑safe start pattern:

```
function start () { if (!timer) timer = setInterval(tick, 1000) }
on('spawn', start)
if (state?.hasSpawned) start()
start() // immediate guarded start to cover hot‑reload install order
```

If you need one‑time “post‑spawn init”, extract a common function (e.g. `initAfterSpawn()`) and call it both from the `spawn` handler and from the hot‑reload path when `state.hasSpawned` is true. See `bot_impl/index.js`’s `initAfterSpawn()` as a reference.

## Coding Style & Naming Conventions
- Language: Node.js (CommonJS). Indentation: 2 spaces; no semicolons (match existing style).
- Names: `camelCase` for variables/functions, `SCREAMING_SNAKE_CASE` for constants, `kebab-case` filenames (e.g., `fire-watch.js`) or `index.js` for module roots.
- Keep modules small and single‑purpose inside `bot_impl/`. No new deps without discussion.

## Testing Guidelines
- No automated tests yet. Validate manually:
  - Connect to a test server; confirm join logs, chat echo, greeting delays, and fire extinguishing.
  - Toggle debug: `MC_DEBUG=0|1` and verify log volume.
- If adding tests, prefer `jest` and place under `__tests__/` mirroring `bot_impl/` paths. Add `npm test` script.

## Commit & Pull Request Guidelines
- Commits: present tense, concise scope. Examples: `feat(greet): add time-of-day salutation`, `fix(watcher): avoid duplicate reloads`.
- PRs: include summary, rationale, screenshots/log snippets if UX/logging changes, and manual test steps (env vars used, server details redacted). Link related issues.

## Security & Configuration Tips
- Never commit credentials. Use environment variables locally or CI secrets.
- Log output may include server info; sanitize before sharing. Avoid enabling verbose debug in production servers.

## Architecture Notes
- Single bot process; `bot_impl` can maintain shared state across reloads via `activate()` return value. Clean up timers/listeners in `deactivate()`.

### Priority & Locks (module coordination)
- `state.externalBusy`: set true while executing player/AI‑triggered tools. Self‑running automations should pause when this is true.
- `state.holdItemLock`: set to a string (e.g. `'fishing_rod'`) to lock the main hand; modules that equip should skip main‑hand changes but may still equip off‑hand (shield).
- `state.autoLookSuspended`: suspend auto‑look loops while a module needs precise aim (e.g., fishing).

Recommended usage in modules:
```
if (state.externalBusy) return // yield to external actions
if (state.holdItemLock) { /* avoid main-hand changes */ }
if (state.autoLookSuspended) { /* skip cosmetic look controls */ }
```

## Agent & Skills Policy
- No placeholders allowed. Do not add, register, or mention any unfinished features or stubbed implementations. If a skill/tool is not production‑ready, keep it out of `bot_impl/` (or behind a disabled flag and not registered) so it never loads during hot reload.
- Prefer fully automatic skills. Skills must encapsulate perception → planning → action → recovery internally. They should not require the LLM to micro‑decide low‑level steps. If a behavior cannot be made fully automatic yet, do not expose it to AI at all.
- Intent‑level interface. Expose only high‑level, goal‑oriented skills (e.g., `go`, `gather`, `craft`). Parameters use “目标描述 + 约束”，并带内置闭环与自我纠错。失败返回结构化事件（如 `missing_material`），但不依赖 AI 决策继续运行。
- Registration gate. Only register completed skills with the runner and list them in prompts. Keep registry and prompts strictly in sync with what is truly implemented. Never leak WIP names to the model.
- Hot‑reload safety. Because `bot_impl/` hot‑reloads on file events, save atomically and only after the feature is fully ready. For multi‑file work, prepare outside `bot_impl/` and move in at once. Never commit partial implementations.
- Observation policy. Basic observer data (生命/饥饿/坐标/附近/背包摘要等) is included directly in AI context to reduce tool calls; richer detail is fetched via explicit tools only when needed, with stable schemas.
- No special cases (接口). Prefer one generalized interface per capability instead of multiple variants. Example: use a single `toss{items:[{name|slot,count?},...]}` to handle single/multiple/slot‑based discards; avoid `toss_hand`/`toss_multi` style forks.
