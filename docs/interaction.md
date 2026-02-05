# Bot Interaction Guide (.tool + Control Plane)

This repo supports two ways to drive/verify behavior:

1) Human interactive CLI (stdin): commands like `.status`, `.ai ...`, `.tool ...`
2) Scriptable control plane (Unix socket, NDJSON): `node scripts/botctl.js ...`

The goal is to make changes verifiable without guessing what the bot is doing.

## Human Interactive CLI (stdin)

When `node bot.js` is running, type into its terminal:

- Lines starting with `.` or `:` are treated as internal CLI commands.
- Other lines are sent as in-game chat.

Common examples:

- `.status` / `.status full` (runtime snapshot)
- `.ai info` / `.ai on` / `.ai off` (AI module control)
- `.tool ...` (unified tool runner; see next section)

## Unified Tool CLI: `.tool ...`

Routing rule:

- If the first token is `list` / `dry` / `run`, it is a subcommand.
- Otherwise, the first token is treated as the tool name (or alias) and will run immediately.

Commands:

- `.tool list`
- `.tool dry <toolOrAlias> [args...]`
- `.tool run <toolOrAlias> [args...]` (alias; optional)
- `.tool <toolOrAlias> [args...]` (default: run)

Args:

- Always supports `key=value` pairs.
- For a few high-frequency tools there is positional sugar:
  - `pickup/collect`:
    - `.tool pick 20` => `{ radius: 20 }`
    - `.tool pick 20 log` => `{ radius: 20, match: "log" }`
    - `.tool pick 20 50` => `{ radius: 20, max: 50 }`
  - `goto`: `.tool goto 10 64 -20 [range]`
  - `say`: `.tool say hello world` => `{ text: "hello world" }`

Notes:

- `.tool dry ...` defaults to the actions-layer dry-run MVP (`validate_only`).
  It returns JSON and usually does not probe world state.
  - Exception: a small set of read-only tools (e.g. `read_book`) may run in dry mode to fetch data without side effects.

## Script Control Plane (UDS): `.mcbot.sock`

`bot.js` starts a Unix Domain Socket server at:

- `./.mcbot.sock` (socket)
- `./.mcbot.pid` (pidfile)

This is the recommended way for scripts/Codex to drive the bot (no stdin attach).

### Client: `scripts/botctl.js`

Usage:

```bash
node scripts/botctl.js hello
node scripts/botctl.js list
node scripts/botctl.js dry pickup radius=20
node scripts/botctl.js run say text="hello from UDS"
```

Options:

- `--sock <path>` override socket path (default: `$PWD/.mcbot.sock`)
- `--token <token>` shared secret (or set env `MCBOT_CTL_TOKEN`)

Limitations:

- `botctl.js` only parses `key=value` args (no positional sugar).
- Values are strings by default; a few numeric-looking fields are auto-coerced to numbers.
- If your value contains spaces, quote it in the shell (e.g. `text="hello world"`).

### Protocol (NDJSON)

Each request is one JSON object per line; each response is one JSON object per line.

- Request: `{ id, op, ... }`
- Response: `{ id, ok, result?, error? }`

Supported ops (MVP):

- `hello`
- `tool.list`
- `tool.dry` with `{ tool, args }`
- `tool.run` with `{ tool, args }`

## Security Model

Baseline protections:

- Socket file permissions are restricted (`0600`) and created under `umask 077` to avoid a brief permissive window.
- `tool.run/tool.dry` are restricted to the allowlist (`actions.TOOL_NAMES`).
- Input buffering is capped to avoid unbounded memory growth on malformed clients.

Optional authentication (recommended if the working directory is writable by other users):

- Set `MCBOT_CTL_TOKEN` (or start with `--ctl-token <token>`)
- Every control-plane request must include `token` (client supports `--token` / env)

Disable control plane completely:

- `MCBOT_CTL=off node bot.js`
- or `node bot.js --ctl off`

## Reload / Restart

Hot reload gate:

- Default gate file: `./open_fire`
- Scriptable: `npm run bot:reload` (equivalent to `touch open_fire`)

Restart helper (local/dev):

- `npm run bot:restart`
  - Sends SIGINT to pid from `./.mcbot.pid`
  - Waits briefly
  - Starts a new `node bot.js` in the foreground

## Troubleshooting

- `connect EPERM .mcbot.sock`
  - Check that the socket file is owned by you and is `srw-------` (0600).
  - If you are running inside a sandboxed environment, the sandbox may block Unix socket connections.
  - Try `ls -la .mcbot.sock` and run the client from the same user and same working directory.

- `tool not allowlisted`
  - The control plane enforces `actions.TOOL_NAMES`. Use `node scripts/botctl.js list` to see what is allowed.

- Bot is running but `hello` says `hasBot: false`
  - The process started but the Mineflayer bot is not created yet, or crashed early. Check stdout/logfile.
