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
   - Supports tool calls by parsing `TOOL {...}` blocks and routing through `actions.run()` with allowlists and intent guards.
6. **Reply emission:** `sendChatReply` sends chat, records it in `state.aiRecent`, notes the per-user response time, and opens/refreshes the player's activation session (see Section 3). All tool acknowledgements also flow through `sendChatReply`.

## 3. Activation Sessions & Follow-Ups
- **Goal:** After a trigger-based reply, stay attentive to that player for 1 minute.
- **`activateSession(username, reason)`:** Stores `{expiresAt, reason, timer, awaiting}` in `state.aiPulse.activeUsers`. Any new reply clears pending follow-up timers.
- **`scheduleActiveFollowup(username)`:** When the active player speaks again, enqueue a delayed (5 s) proactive check. If the player keeps talking before the timer fires, it re-schedules to avoid interruption.
- **Flush behavior:** When the timer fires, `maybeFlush('active', {username})` immediately asks the pulse system to respond using the full transcript (not just the latest line). Successful proactive replies re-arm the session; failures reschedule if needed.

## 4. Transcript & Context Builders
- **`pushRecentChatEntry`:** Canonical helper invoked by player capture (`onChatCapture`) and bot chat (`recordBotChat` / `sendDirectReply`). Guarantees monotonically increasing `seq` IDs for later diffing.
- **Overflow handling:** When `state.aiRecent` exceeds `recentStoreMax`, the oldest chunk is summarized through a lightweight DeepSeek call (20–40 chars) and stored in `state.aiLong` before trimming to size.
- **Prompt assembly:** `buildContextPrompt` slices the latest `recentCount` entries within `recentWindowSec` and crafts an ordered "旧→新" summary. Observer and memory blocks are conditionally added via `buildGameContext`, `buildExtrasContext`, and `selectMemory`.

## 5. Pulse / Proactive Replies
- **Enqueue (`enqueuePulse`):** Every stored chat line (even non-triggered) increments the player's pending count unless they received a reply within `PULSE_RECENT_REPLY_SUPPRESS_MS`. The per-user map keeps only counts and last timestamps; actual text lives in `state.aiRecent`.
- **Dynamic flushing:**
  - `shouldFlushByCount()` considers per-user spam and total pending volume (minimum threshold scales with active speakers) before triggering `flushPulse('count')`.
  - Timers (`PULSE_INTERVAL_MS`) and CLI/manual commands call `maybeFlush` with `force` to override thresholds.
  - Activation follow-ups pass `{username}` so only fresh lines from that player are considered.
- **Batch construction:** `buildPulseBatch()` diff-checks `state.aiRecent` using `state.aiPulse.lastSeq`, ensuring transcripts always include bot lines plus any recent player chatter, capped at `PULSE_MAX_MESSAGES`.
- **LLM request:** Uses `prompts/pulse-system.txt` (BOT_NAME substituted) plus observer/context extras. If the model replies `SKIP`, pending counts are cleared; otherwise, the bot chats the trimmed output and records it.
- **Recovery:** Failures restore `lastSeq`, `pendingByUser`, and re-arm timers to avoid losing messages.

## 6. CLI & Ops Controls
- **`.ai ...`:** Existing controls for enabling/disabling, swapping API keys/models, budgeting, reply length, and context windows. `.ai clear` now resets both `state.aiRecent` and `state.aiPulse.lastSeq` to keep transcripts aligned.
- **`.pulse status|on|off|now`:**
  - Proactive replies start **disabled by default**; run `.pulse on` (or pass `--greet on`?) to enable during a session.
  - `status` prints pending counts, active-session totals, last flush time/reason, and top offending players.
  - `on`/`now` force an immediate flush via `maybeFlush(..., {force:true})`.
  - `off` disables proactive replies, clears pending counts, and cancels activation timers.

## 7. Hot Reload Considerations
- `install()` normalizes Maps/Sets on every load (`state.aiPulse.pendingByUser`, `state.aiPulse.activeUsers`, `state.aiRecentSeq`, etc.) so reloads keep history without corrupting shapes.
- `registerCleanup` tears down chat/message listeners, CLI hooks, interval timers, and active-session timers. `resetActiveSessions()` ensures no stray timeouts survive reloads.
- Long-running async operations (`pulseCtrl`, memory rewrites) honor AbortControllers to avoid leaks when the module is swapped mid-request.

## 8. Extension Guidelines
- **Add new fast-path intents** near the top of `handleChat`, before `canProceed`, so they bypass rate limits when appropriate.
- **For new proactive heuristics**, piggyback on `state.aiPulse.pendingByUser` (counts only) and let `state.aiRecent` provide transcripts; never introduce parallel text buffers.
- **Budget enforcement** must pass through `canAfford` / `applyUsage` to keep `.ai budget` accurate.
- **Session-aware features** should respect `state.externalBusy` and consider `activateSession` so that the bot doesn't interleave automation with an ongoing human conversation.

Keeping the above contracts intact ensures AI conversations remain coherent across hot reloads, while proactive replies stay in sync with the actual chat history.
