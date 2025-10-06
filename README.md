# Mineflayer Bot Helper

## Setup
- **Install dependencies**: `npm install`
- **Configure (optional)**: set `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD` env vars for custom servers.

## Run
- **Standard**: `npm start`
- **Hot reload**: `npm run dev` (watches `bot.js` and restarts the bot automatically)

## Features
- Logs every server message to the terminal.
- Allows interactive chat input (use `/login <password>` after join).
- Automatically searches for nearby fire and extinguishes it.
- Sends anime-style time-of-day greetings to players who join after the bot arrives (fires after they survive 5 seconds) and teases future DeepSeek collab.

## Ideas To Try Next
- Pathfinding patrols via `mineflayer-pathfinder`.
- Resource monitoring: report nearby chests or ores.
- Combat guard mode for base protection.
- DeepSeek-powered dialogue mode with richer replies.
