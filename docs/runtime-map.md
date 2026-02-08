# Runtime Map Overview

This project keeps long-lived state in `bot_impl/index.js` so that hot reloads can reuse context without reconnecting. The sections below summarise the key buckets that modules rely on.

## Shared State Structure

`state` is created by `prepareSharedState(...)` in `bot_impl/state.js` and lives across reloads. Important fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `pendingGreets` | `Map<string, Timeout>` | Greetings scheduled for newly joined players. Cleared on spawn and reload. |
| `greetedPlayers` | `Set<string>` | Players already greeted this session. Prevents duplicate welcomes. |
| `greetZones`, `worldMemoryZones` | `Array<object>` | Hot-reload friendly description of greeting suffix zones (static + memory-derived). |
| `cleanups` | `Array<Function>` | Functions registered by modules to run on `deactivate()`; see `registerCleanup`. |
| `externalBusy` / `externalBusyCount` | `boolean` / `number` | Gate for autonomous features to yield while a player-initiated tool is running. Incremented/decremented via `external:begin` / `external:end`. |
| `currentTask` | `object|null` | Lightweight descriptor of the action the bot is performing (tool name, source, start timestamp). Shown in status CLI and reset on completion. |
| `autoLookSuspended` | `boolean` | Hint for visual modules (e.g., fishing) that they have temporarily claimed camera control. |
| `loginPassword` | `string?` | Optional cached server password used by `auto-login`. |
| `voiceChat` | `object` | Simple Voice Chat runtime state (`enabled/available/pluginLoaded/connected`) with last error, last speaker, and last played audio path/time. |
| `aiRecentReplies` | `Map<string, number>` | Tracks recent AI replies to avoid greeting someone immediately after chatting with them. |

All collections are normalised (`Map`/`Set`/`Array`) each time `activate()` runs so modules can depend on consistent shapes.

## Event Hooks

| Event | Handler | Notes |
| --- | --- | --- |
| `external:begin` / `external:end` | Marks `state.externalBusy` and updates `state.currentTask`. Modules should respect `state.externalBusy` before starting background work. |
| `spawn` | Greets players, rebuilds greeting zones, runs one-shot scripts. |
| `death` / `respawn` | Force reset of automation and announce interruption to users. |
| `message` | Mirrors server chat to stdout with log truncation. |

## Module Registry

`bot_impl/module-registry.js` lists every hot-reloadable module with its path, logger namespace, and a brief description. `index.js` iterates over this registry when installing modules, so adding or removing functionality only requires editing one place.

## Tool Metadata

Single source of truth lives in `bot_impl/action-tool-specs.js` (`TOOL_SPECS`).

- `bot_impl/actions/index.js` derives runtime metadata (`TOOL_NAMES`, allowlist checks) from that file.
- `bot_impl/ai-chat/tool-schemas.js` also derives action tool definitions from the same source, then overlays parameter schemas.

Run `node scripts/list-tools.js` to output the current allowlist as JSON.

Keeping these snapshots up to date helps both humans and AI contributors understand the current surface area without reading every module manually.
