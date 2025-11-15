# AI Chat Pipeline

This document explains how `bot_impl/ai-chat.js` wires the trigger-based DeepSeek chat, proactive "pulse" replies, and long-lived state. Use it as a reference when auditing behavior or introducing new features.

## 1. Shared State & Startup
- **Module scope:** `bot_impl/ai-chat.js` installs off `bot_impl/index.js` and hot-reloads through `activate()/deactivate()`.
- **`state.ai`:** Stores DeepSeek API config (model, base URL, budgets, per-user/global limits) and chat-context options (`recentCount`, windows, observer snapshots, memory inclusion, etc.). Defaults merge on every load.
- **`state.aiRecent` / `state.aiRecentSeq`:** Append-only transcript of *all* chats (players + bot). Each entry is `{t,user,text,kind,seq}`. Overflow beyond `recentStoreMax` is summarized asynchronously into `state.aiLong` for long-term context.
- **`state.aiPulse`:** Tracks proactive reply bookkeeping: `pendingByUser` (Map of `{count,lastAt}`), `totalPending`, `pendingSince`, `lastSeq` (mirrors `aiRecentSeq`), dedupe history, and per-user activation windows.
- **Other stores:** `state.aiMemory` (long-term memories), `state.aiExtras.events` (recent achievements/deaths), `state.aiRecentReplies` (per-user cool-down), and `state.aiStats`/`state.aiSpend` for budgeting.

## 2. Triggered Reply Flow (`handleChat`)
1. **Trigger detection:** Accepts messages beginning with the bot's first 3 alphanumeric characters (fallback `bot`). Prefix tokens and separators are stripped before processing.
2. **Immediate commands:** Certain intents bypass the LLM:
   - Dismount keywords → `actions.dismount` + direct acknowledgement.
   - `isStopCommand` phrases → `actions.reset`.
   - Memory writes via `extractMemoryCommand` enqueue a rewrite job without asking the LLM.
3. **Rate limiting:** `canProceed(username)` enforces per-user/global/day/minute quotas; failures return "太快啦".
4. **Context prep:** `classifyIntent` gives lightweight heuristics for local answers. Game/observer snapshots, memory snippets, and `state.aiRecent` transcript are woven into the DeepSeek prompt.
5. **LLM call (`callAI`):**
   - Builds a system prompt listing available tools and safety notes.
   - Applies budget checks via `projectedCostForCall`/`canAfford`.
   - Sends the DeepSeek function-calling schema (generated from `bot_impl/ai-chat/tool-schemas.js`) so replies land in `message.tool_calls`; each call is routed through `actions.run()` with allowlists and intent guards.
6. **Reply emission:** `sendChatReply` sends chat, records it in `state.aiRecent`, notes the per-user response time, and opens/refreshes the player's activation session (see Section 3). All tool acknowledgements also flow through `sendChatReply`.

## 3. Activation Sessions & Follow-Ups
- **Goal:** After a trigger-based reply, stay attentive to that player for 1 minute.
- **`activateSession(username, reason)`:** Stores `{expiresAt, reason, timer, awaiting}` in `state.aiPulse.activeUsers`. Any new reply clears pending follow-up timers.
- **`scheduleActiveFollowup(username)`:** When the active player speaks again, enqueue a delayed (5 s) proactive check. If the player keeps talking before the timer fires, it re-schedules to avoid interruption.
- **Flush behavior:** When the timer fires, `maybeFlush('active', {username})` immediately asks the pulse system to respond using the full transcript (not just the latest line). Successful proactive replies re-arm the session; failures reschedule if needed.
- **Trigger follow-ups (no pulse needed):** Even with proactive pulses disabled, active sessions enable automatic replies to the same player’s subsequent chats (without trigger words) for 1 minute by directly routing the new message back through the main dialogue stack.
- **Follow-up skip hint:** During these auto follow-ups the LLM prompt adds“若无需回复请输出 SKIP”，and if it does so the turn is silently dropped (explicit `owk` triggers never include this hint).

## 4. Conversation Memory
- **Lifecycle:** When a trigger starts a new session, `activateSession(..., {restart:true})` snapshots the current chat sequence index. As long as the session stays alive, every player/bot message updates `lastSeq` + `lastAt` and records the participants set.
- **Stage end:** Sessions now finalize only when they fall idle for the full active window (默认为 1 分钟) or when they are forcibly reset（热重载/ops 命令）. Repeated触发词 during an active session simply extend the same session instead of creating a new summary. When a session truly ends, `queueConversationSummary` gathers the chat lines (`state.aiRecent`) between `startSeq` and `lastSeq`, then asks DeepSeek for a ≤40字 summary mentioning players + topic. Failures fall back to a heuristic string.
- **Storage:** Summaries land in `state.aiDialogues` (max 60 records) and are persisted via `data/ai-memory.json` so `.ai dialog` survives restarts. Each record keeps `participants[]`, `summary`, `startedAt`, and `endedAt`. No data is deleted from `state.aiRecent`; the summaries are just compact references.
- **Context layering:** `buildConversationMemoryPrompt(username)` selects recent summaries with exponential buckets (≤3d:4, ≤7d:6, ≤15d:8, ≤30d:10). Entries involving the current player are prioritized, and each line is rendered as `N. X天前 玩家A/玩家B: 总结`. The block is appended to the normal recent-chat context before every LLM call (including pulses), giving the model a long-ish but lightweight memory of past conversations.

## 5. Transcript & Context Builders
- **`pushRecentChatEntry`:** Canonical helper invoked by player capture (`onChatCapture`) and bot chat (`recordBotChat` / `sendDirectReply`). Guarantees monotonically increasing `seq` IDs for later diffing.
- **Single source of truth:** `state.aiRecent` now stores every player/机器人对话一次；不再维护额外的“含触发词”缓冲。`buildContextPrompt` 只依赖该数组，默认取最近 32 行（`recentCount`，可通过 `.ai context recent N` 或 `state.ai.context.recentCount` 覆盖）以及 `recentWindowSec`（秒级时间窗，默认 300s）。
- **Overflow handling:** When `state.aiRecent` exceeds `recentStoreMax`, the oldest chunk is summarized through a lightweight DeepSeek call (20–40 chars) and stored in `state.aiLong` before trimming to size. `recentStoreMax` 可用 `.ai context recentmax N` 调整。
- **Prompt assembly:** `buildContextPrompt` 渲染“当前对话玩家 + 最近聊天顺序（旧→新）”。其余上下文块按顺序拼接：`buildGameContext`（observer 快照）、`buildExtrasContext`（最近事件）、`buildMemoryContext`（长期记忆 Top N），最后才是玩家提问文本。`callAI()` 始终以此顺序向 DeepSeek 发送 system 消息。

## 6. Pulse / Proactive Replies
- **Enqueue (`enqueuePulse`):** Every stored chat line (even non-triggered) increments the player's pending count unless they received a reply within `PULSE_RECENT_REPLY_SUPPRESS_MS`. The per-user map keeps only counts and last timestamps; actual text lives in `state.aiRecent`.
- **Dynamic flushing:**
  - `shouldFlushByCount()` considers per-user spam and total pending volume (minimum threshold scales with active speakers) before triggering `flushPulse('count')`.
  - Timers (`PULSE_INTERVAL_MS`) and CLI/manual commands call `maybeFlush` with `force` to override thresholds.
  - Activation follow-ups pass `{username}` so only fresh lines from that player are considered.
- **Batch construction:** `buildPulseBatch()` diff-checks `state.aiRecent` using `state.aiPulse.lastSeq`, ensuring transcripts always include bot lines plus any recent player chatter, capped at `PULSE_MAX_MESSAGES`.
- **LLM request:** Uses `prompts/pulse-system.txt` (BOT_NAME substituted) plus observer/context extras. If the model replies `SKIP`, pending counts are cleared; otherwise, the bot chats the trimmed output and records it.
- **Recovery:** Failures restore `lastSeq`, `pendingByUser`, and re-arm timers to avoid losing messages.

## 7. CLI & Ops Controls
- **`.ai ...`:** Existing controls for enabling/disabling, swapping API keys/models, budgeting, reply length, and context windows. 这些 CLI 现在集中在 `bot_impl/ai-chat/cli.js` 中，便于维护与扩展。`.ai clear` 会同时重置 `state.aiRecent` 与 `state.aiPulse.lastSeq`，保持热重载后一致。常用上下文调节：`.ai context recent 32|64`、`.ai context window 600`、`.ai context recentmax 400`。
- **`.pulse status|on|off|now`:**
  - Proactive replies start **disabled by default**; run `.pulse on` (or pass `--greet on`?) to enable during a session.
  - `status` prints pending counts, active-session totals, last flush time/reason, and top offending players.
  - `on`/`now` force an immediate flush via `maybeFlush(..., {force:true})`.
  - `off` disables proactive replies, clears pending counts, and cancels activation timers.

## 8. Hot Reload Considerations
- `install()` normalizes Maps/Sets on every load (`state.aiPulse.pendingByUser`, `state.aiPulse.activeUsers`, `state.aiRecentSeq`, etc.) so reloads keep history without corrupting shapes.
- `registerCleanup` tears down chat/message listeners, CLI hooks, interval timers, and active-session timers. `resetActiveSessions()` ensures no stray timeouts survive reloads.
- Long-running async operations (`pulseCtrl`, memory rewrites) honor AbortControllers to avoid leaks when the module is swapped mid-request.

## 8. Extension Guidelines
- **Add new fast-path intents** near the top of `handleChat`, before `canProceed`, so they bypass rate limits when appropriate.
- **For new proactive heuristics**, piggyback on `state.aiPulse.pendingByUser` (counts only) and let `state.aiRecent` provide transcripts; never introduce parallel text buffers.
- **Budget enforcement** must pass through `canAfford` / `applyUsage` to keep `.ai budget` accurate.
- **Session-aware features** should respect `state.externalBusy` and consider `activateSession` so that the bot doesn't interleave automation with an ongoing human conversation.

Keeping the above contracts intact ensures AI conversations remain coherent across hot reloads, while proactive replies stay in sync with the actual chat history.
