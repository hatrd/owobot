# 仓库指南

## 开发原则
- 内部实现不用考虑兼容，这是一个短平快的项目，一切都以最快迭代效率为准。
- 对外接口（技能/工具）无需保持长期稳定；优先保证简洁优雅、语义清晰，并让 AI 易于调用。可以在迭代中随时调整接口，但需确保当前运行内的一致性，并保持注册表与提示文档严格同步（见“Registration gate”）。
- 安全默认：禁止攻击玩家（除非明确指名玩家名并使用专用工具），禁止默认挖掘（除非显式传入 `dig:true`）。
- 不保留历史注释或占位：删除/重构后的逻辑不保留“已移除/TODO/临时”类注释或废弃接口说明，避免向上下文泄露过时信息。一切以当前最新代码和文档为准。

## 目录结构与组织
- Entry point: `bot.js` (creates Mineflayer bot, sets up hot reload).
- Hot‑reloadable logic: `bot_impl/` with `index.js` exporting `activate`/`deactivate`.
- Runtime deps: `node_modules/`; config via environment variables (`MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_PASSWORD`, `MC_DEBUG`, `MC_GREET`).
- Prefer adding new features under `bot_impl/` to benefit from hot reload. Only touch `bot.js` for loader/core wiring.

## 构建与开发
- `npm install` — install dependencies.
- `npm start` — run the bot once (no process restarts). Supports hot reload by editing files in `bot_impl/`.
- `npm run dev` — run with nodemon (process restarts on file changes). Use only if changing `bot.js`.
- Example: `MC_HOST=localhost MC_PORT=25565 MC_USERNAME=bot npm start`.

### 运行时配置（环境变量/CLI）
- Env vars: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH` (`offline|microsoft`), `MC_PASSWORD`, `MC_DEBUG` (`0|1`), `MC_GREET` (`0|1`).
- CLI overrides (take precedence over env): `--host`, `--port`, `--username|--user`, `--auth`, `--password`, `--greet on|off`.
- Examples:
  - Disable greeting: `MC_GREET=0 npm start` or `npm start -- --greet off`.
  - Change bot name: `MC_USERNAME=MyBot npm start` or `npm start -- --username MyBot`.
  - Reduce logs: `MC_DEBUG=0 npm start`.
  - Increase AI reply size: `.ai budget maxtokens 512` and/or `.ai reply maxlen 240`.

## 热重载流程
- 重载闸门（默认启用）：为避免半成品被热重载，仓库默认启用闸门文件 `open_fire`，只有在触碰该文件后才会真正 reload。
  - 使用方式：先在 `bot_impl/` 完成所有修改；准备好后执行 `touch open_fire`，此时才会应用热重载。
  - 如需关闭闸门（恢复到改动即重载）：CLI `--reload-gate off` 或设置环境变量 `HOT_RELOAD_GATE=off`。

### 热重载下的启动约定

Under hot‑reload the `spawn` event is not guaranteed to fire for newly reloaded modules (the bot is already spawned). Do NOT rely solely on `on('spawn', ...)` to start timers/watchers.

Use a reload‑safe start pattern:

```
function start () { if (!timer) timer = setInterval(tick, 1000) }
on('spawn', start)
if (state?.hasSpawned) start()
start() // immediate guarded start to cover hot‑reload install order
```

If you need one‑time “post‑spawn init”, extract a common function (e.g. `initAfterSpawn()`) and call it both from the `spawn` handler and from the hot‑reload path when `state.hasSpawned` is true. See `bot_impl/index.js`’s `initAfterSpawn()` as a reference.

## 代码风格
- Language: Node.js (CommonJS). Indentation: 2 spaces; no semicolons (match existing style).
- Names: `camelCase` for variables/functions, `SCREAMING_SNAKE_CASE` for constants, `kebab-case` filenames (e.g., `fire-watch.js`) or `index.js` for module roots.
- Keep modules small and single‑purpose inside `bot_impl/`. No new deps without discussion.

## 架构
- Single bot process; `bot_impl` can maintain shared state across reloads via `activate()` return value. Clean up timers/listeners in `deactivate()`.

### 已移除模块
- 如果移除了一个模块，就不要保留任何信息。包括写一条注释说这个模块已经移除。

### 协调（优先级与锁）
- `state.externalBusy`: set true while executing player/AI‑triggered tools. Self‑running automations should pause when this is true.
- `state.holdItemLock`: set to a normalized item name (e.g. `'fishing_rod'`) to lock the main hand; modules that equip should skip main‑hand changes but may still equip off‑hand (shield). Use the actual item name you expect to keep equipped so the owning module can still re-equip it while the lock is active.
- `state.autoLookSuspended`: suspend auto‑look loops while a module needs precise aim (e.g., fishing).

Recommended usage in modules:
```
if (state.externalBusy) return // yield to external actions
if (state.holdItemLock) { /* avoid main-hand changes */ }
if (state.autoLookSuspended) { /* skip cosmetic look controls */ }
```

## Agent 与工具策略
- No placeholders allowed. Do not add, register, or mention any unfinished features or stubbed implementations. If a skill/tool is not production‑ready, keep it out of `bot_impl/` (or behind a disabled flag and not registered) so it never loads during hot reload.
- Prefer fully automatic skills. Skills must encapsulate perception → planning → action → recovery internally. They should not require the LLM to micro‑decide low‑level steps. If a behavior cannot be made fully automatic yet, do not expose it to AI at all.
- Intent‑level interface. Expose only high‑level, goal‑oriented skills (e.g., `go`, `gather`, `craft`). Parameters use “目标描述 + 约束”，并带内置闭环与自我纠错。失败返回结构化事件（如 `missing_material`），但不依赖 AI 决策继续运行。
- Registration gate. Only register completed skills with the runner and list them in prompts. Keep registry and prompts strictly in sync with what is truly implemented. Never leak WIP names to the model.
- Observation policy. Basic observer data (生命/饥饿/坐标/附近/背包摘要等) is included directly in AI context to reduce tool calls; richer detail is fetched via explicit tools only when needed, with stable schemas.
- No special cases (接口). Prefer one generalized interface per capability instead of multiple variants. Example: use a single `toss{items:[{name|slot,count?},...]}` to handle single/multiple/slot‑based discards; avoid `toss_hand`/`toss_multi` style forks.
- 工具应做通用化设计：例如玩家观察统一使用 `observe_players{names?, world?|dim?}` 来兼容单人/多人/按维度查询；不保留旧别名，接口即最新且唯一。
- 外部AI决策优先：除非为安全/资源保护需要的硬性保护（如禁止攻击玩家/默认不挖掘），不要在聊天侧做意图到工具的本地关键词映射或“自动纠错”。将意图解析交给外部AI，避免双重决策与不可见的偏差。
  - 明确例外：玩家定位与信息查询一律通过外部AI 触发 `observe_players{...}`（或 `observe_detail{...}` 等查询工具），不要添加任何基于正则/关键词的本地快捷匹配（即便是“<名字> 在哪里/坐标/位置”这类）。这样可利用AI对拼写/别名/上下文的强纠错能力。
  - 允许的本地硬性保护/快捷处理仅限安全相关（如 `reset{}`、`dismount{}` 的强制停止），且应尽量简单、可证明安全。

### 现有工具面（AI 使用）
- 查询类：`observe_detail{what,radius?,max?}`；优先直接回答上下文，禁止为查询调用修改世界的工具。
- 玩家观察：`observe_players{names?, world?|dim?, armor_(lt|lte|gt|gte|eq)?, health_(lt|lte|gt|gte|eq)?, max?}`。支持单人/多人/按维度筛选，以及生命/盔甲阈值过滤（如 `armor_eq:0` 或 `armor_lte:10`）。
- 寻路：`goto{x,y,z,range?}`；`goto_block{names?|name?|match?,radius?,range?,dig?}`（默认不挖掘，仅 `dig:true` 允许）。
- 战斗/防御：`defend_area{radius?,tickMs?,dig?}`（驻守清怪）、`defend_player{name,radius?,followRange?,tickMs?,dig?}`（护卫玩家）、`cull_hostiles{radius?,tickMs?}`（半径清怪）。不建议使用 `hunt_player`，除非用户明确要求并指名玩家。
- 物品与交互：`equip`、`toss`、`collect|pickup`、`deposit|deposit_all`、`place_blocks`、`break_blocks`、`gather`、`harvest`、`autofish`、`mount_near|dismount`、`say`、`reset|stop|stop_all`。

Notes
- The tool allowlist and prompt text are maintained in `bot_impl/ai-chat.js`; only list tools that exist.

### 寻路与挖掘（精简后的默认）
- 默认不挖掘：除非显式传入 `dig:true`，以下通用动作不会破坏方块：`goto`、`goto_block`、`follow_player`、`collect|pickup`、`mount_near`、`mount_player`、`place_blocks`、`cull_hostiles`。
- 专用挖掘类：`break_blocks` / `gather` / `harvest` 自带挖掘流程（无需 `dig:true`），会在内部选择合适工具并执行安全检查。
- 矿脉挖掘（mine_ore）：为提高效率，使用更激进的 Movements（允许更灵活的跳跃/贴边等）。该策略仅在矿工技能内启用，不影响其他工具的保守寻路。
