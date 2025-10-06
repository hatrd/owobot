# Mineflayer Bot Helper

## Setup
- **Install dependencies**: `npm install`
- **Configure (optional)**: set `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD` env vars for custom servers. Set `MC_DEBUG=0` to disable debug logs (enabled by default).

## Run
- **Standard**: `npm start`
- **Hot reload (no reconnect)**: edit any file under `bot_impl/` while running; the bot reloads logic in-process without disconnecting.
- **Legacy dev (process restart)**: `npm run dev` uses nodemon to restart the process; this causes a reconnect. Prefer the built-in hot reload by editing files in `bot_impl/`.

## Features
- Logs every server message to the terminal.
 - Debug logging for greeting and fire logic (toggle with `MC_DEBUG`).
- Allows interactive chat input (use `/login <password>` after join).
- Automatically searches for nearby fire and extinguishes it.
- Sends anime-style time-of-day greetings to players who join after the bot arrives. The bot waits ~2 seconds after the join event and then greets, regardless of entity availability (leaving the server within that time cancels the greeting).

## Hot Reload Details
- The entry `bot.js` creates one Mineflayer instance and watches the `bot_impl/` directory recursively.
- On any change inside `bot_impl/`, it purges the module cache for all files under that directory, deactivates the old impl, requires the new code, and reattaches listeners/timers in-process.
- You can add new modules/files under `bot_impl/` and require them from `bot_impl/index.js`; they will hot reload too.
- Shared state (e.g., greeted players) persists across reloads when possible.

## Ideas To Try Next
- Pathfinding patrols via `mineflayer-pathfinder`.
- Resource monitoring: report nearby chests or ores.
- Combat guard mode for base protection.
- DeepSeek-powered dialogue mode with richer replies.
