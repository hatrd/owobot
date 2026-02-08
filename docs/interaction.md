# Interaction Contract (First-Class) (.tool + Control Plane)

This repo supports two ways to drive/verify behavior:

1) Human interactive CLI (stdin): commands like `.status`, `.ai ...`, `.tool ...`
2) Scriptable control plane (Unix socket, NDJSON): `node scripts/botctl.js ...`

The goal is to make changes verifiable without guessing what the bot is doing.

## First-Class Verification Rule

`docs/interaction.md` is the project-level interaction contract.

- Any behavior change that can affect runtime interaction must be verified against this contract.
- The default verification path is **dry interaction first**, then optional real run.
- Prefer scriptable control-plane verification (`scripts/botctl.js`, `scripts/interaction-dry-run.js`) over manual ad-hoc checks.

Fast entrypoints:

- `npm run interaction:hello`
- `npm run interaction:list`
- `npm run interaction:observe`
- `npm run interaction:dry`

Related design docs:

- `docs/environment-observation.md` (environment observation algorithm essence + integration roadmap)

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
node scripts/botctl.js observe snapshot
node scripts/botctl.js observe prompt
node scripts/botctl.js observe detail what=inventory radius=12
node scripts/botctl.js chatdry username=kuleizi content="附近小狗小猫有什么" withTools=true maxToolCalls=6
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
- `observe.snapshot` with `{ args }`
- `observe.prompt` with `{ args }`
- `observe.detail` with `{ args }`

## Observer Ops (Control Plane)

Observer endpoints are read-only by design and are intended for low-cost verification.

- `observe.snapshot`: returns structured runtime snapshot (position, vitals, nearby, inventory summary, current task).
- `observe.prompt`: returns `{ prompt, snapshot }` using the same prompt shape consumed by AI context assembly.
- `observe.detail`: returns focused detail (`what=inventory|players|hostiles|entities|blocks|animals|cats|cows|containers|signs|space_snapshot|environment|room_probe`, with `radius`, `max`).
  - For `players|hostiles|entities|animals|cats|cows`, `result.msg` now includes a short top-N preview (name/type/distance) to reduce repetitive count-only replies.
  - For `what=containers`, optional `openAttempts` / `openTimeoutMs` can tune read-only container open retries/timeout in slow servers.

Container inspection (`what=containers`) supports all nearby container categories:

- `chest` / `trapped_chest`（普通箱子）
- `barrel`（木桶）
- `ender_chest`（末影箱）
- `*_shulker_box`（潜影箱）

Optional args for containers:

- `containerType=any|chest|barrel|ender_chest|shulker_box`
- `itemMax=<N>` per-container max item kinds returned
- `full=true` include full aggregated item list (`allItems`)

Examples:

```bash
node scripts/botctl.js observe snapshot invTop=8 nearPlayerRange=16
node scripts/botctl.js observe prompt hostileRange=24
node scripts/botctl.js observe detail what=players radius=24 max=12
node scripts/botctl.js observe detail what=containers radius=6 max=8
node scripts/botctl.js observe detail what=containers containerType=barrel radius=6 max=8
node scripts/botctl.js observe detail what=containers containerType=smoker radius=6 max=8
node scripts/botctl.js observe detail what=containers containerType=hopper radius=6 max=8
node scripts/botctl.js observe detail what=signs radius=24 max=20
node scripts/botctl.js dry observe_detail what=environment radius=12
```

## Dry Interaction Observer

Use one command to verify the full interaction chain after each change:

```bash
npm run interaction:dry
```

It verifies, in order:

1) `hello` (control plane reachable)
2) `tool.list` (allowlist coherence)
3) `observe.snapshot` (observer structured state)
4) `observe.prompt` (prompt rendering)
5) `observe.detail` (focused read path; default `containers`)
6) `tool.dry` (dry-run execution path)
7) `tool.dry observe_detail` (read-only dry output, includes nearby container contents)

By default, it dry-runs `pickup` with `radius=12`. Override if needed:

```bash
node scripts/interaction-dry-run.js --tool pickup --radius 20 --detail containers
node scripts/interaction-dry-run.js --tool pickup --radius 20 --detail containers --timeout-ms 12000

# direct dry-read of nearby container contents via action dry path
node scripts/botctl.js dry observe_detail what=containers radius=20 max=8

# restart current bot process from control plane (detached by default)
node scripts/botctl.js restart
node scripts/botctl.js restart mode=inherit delayMs=500ms
```

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

Recommended resilient mode (auto-restart + inherited stdin/stdout):

- `npm run bot:watch`
  - Starts `scripts/bot-watch.js` as the long-lived parent process.
  - The watcher starts `bot.js` with `stdio: inherit`, so interactive stdin still goes to the running bot child.
  - If `bot.js` exits unexpectedly, watcher restarts it with bounded exponential backoff.
  - If an existing pid from `./.mcbot.pid` is alive, watcher takeover stops it first (`--takeover=true`).

## Troubleshooting

- `connect EPERM .mcbot.sock`
  - Check that the socket file is owned by you and is `srw-------` (0600).
  - If you are running inside a sandboxed environment, the sandbox may block Unix socket connections.
  - Try `ls -la .mcbot.sock` and run the client from the same user and same working directory.

- `tool not allowlisted`
  - The control plane enforces `actions.TOOL_NAMES`. Use `node scripts/botctl.js list` to see what is allowed.

- Bot is running but `hello` says `hasBot: false`
  - The process started but the Mineflayer bot is not created yet, or crashed early. Check stdout/logfile.
