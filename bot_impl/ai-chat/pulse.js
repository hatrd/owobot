const PULSE_MAX_MESSAGES = 20
const PULSE_INTERVAL_MS = 3 * 60 * 1000
const PULSE_CHECK_MS = 60 * 1000
const PULSE_RECENT_REPLY_SUPPRESS_MS = 2 * 60 * 1000
const PULSE_REPEAT_SUPPRESS_MS = 6 * 60 * 1000
const PULSE_PENDING_EXPIRE_MS = 5 * 60 * 1000
const ACTIVE_CHAT_WINDOW_MS = 60 * 1000
const ACTIVE_FOLLOW_DELAY_MS = 5 * 1000
const PLAYER_CHAT_DEDUPE_MS = 1200
const CHAT_EVENT_DEDUPE_MS = 250
const DEATHCHEST_DEDUPE_MS = 8000

function createPulseService ({
  state,
  bot,
  log,
  now = () => Date.now(),
  H,
  defaults,
  canAfford,
  applyUsage,
  buildContextPrompt,
  buildGameContext,
  traceChat = () => {},
  memory,
  feedbackCollector = null,
  contextBus = null
}) {
  const pulseCtrl = { running: false, abort: null }
  let pulseTimer = null
  const sayCtrlByUser = new Map()

  const SAY_LIMITS = {
    maxSteps: 24,
    maxTotalMs: 45000,
    maxReplyLen: 120
  }

  const SAY_TYPING_DEFAULTS = {
    enabled: true,
    cps: 12,
    baseMs: 220,
    minMs: 120,
    maxMs: 1500,
    jitterMs: 120
  }

  function ensureSayState () {
    if (!state.aiSay || typeof state.aiSay !== 'object') state.aiSay = {}
    if (!Number.isFinite(state.aiSay.seq)) state.aiSay.seq = 0
    if (!(state.aiSay.activeByUser instanceof Map)) state.aiSay.activeByUser = new Map()
    return state.aiSay
  }

  function abortSayCtrl (ctrl, reason = 'cancel') {
    if (!ctrl || typeof ctrl !== 'object') return
    ctrl.aborted = true
    ctrl.reason = reason
    if (ctrl.timer) {
      try { clearTimeout(ctrl.timer) } catch {}
      ctrl.timer = null
    }
    if (typeof ctrl.resolve === 'function') {
      try { ctrl.resolve(false) } catch {}
    }
    ctrl.resolve = null
  }

  function cancelSay (username, reason = 'cancel') {
    if (!username) return false
    const ctrl = sayCtrlByUser.get(username)
    if (!ctrl) return false
    sayCtrlByUser.delete(username)
    try { ensureSayState().activeByUser.delete(username) } catch {}
    abortSayCtrl(ctrl, reason)
    return true
  }

  function delayMs (msRaw, ctrl) {
    const ms = Math.max(0, Math.floor(Number(msRaw) || 0))
    if (!ms) return Promise.resolve(true)
    if (!ctrl || ctrl.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
      ctrl.resolve = resolve
      ctrl.timer = setTimeout(() => {
        ctrl.timer = null
        ctrl.resolve = null
        resolve(!ctrl.aborted)
      }, ms)
    })
  }

  function normalizeTypingCfg (raw) {
    const cfg = { ...SAY_TYPING_DEFAULTS }
    if (!raw || typeof raw !== 'object') return cfg
    if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled
    const cps = Number(raw.cps)
    if (Number.isFinite(cps) && cps > 0) cfg.cps = cps
    for (const k of ['baseMs', 'minMs', 'maxMs', 'jitterMs']) {
      const v = Number(raw[k])
      if (Number.isFinite(v) && v >= 0) cfg[k] = Math.floor(v)
    }
    if (cfg.maxMs < cfg.minMs) cfg.maxMs = cfg.minMs
    return cfg
  }

  function computeTypingDelay (text, cfg) {
    if (!cfg?.enabled) return 0
    const t = String(text || '')
    const len = t.length
    const cps = Number(cfg.cps) || SAY_TYPING_DEFAULTS.cps
    const base = Number(cfg.baseMs) || 0
    const jitter = Number(cfg.jitterMs) || 0
    const raw = base + (len / Math.max(1, cps)) * 1000
    const jittered = raw + (jitter ? ((Math.random() * 2 - 1) * jitter) : 0)
    const min = Number.isFinite(cfg.minMs) ? cfg.minMs : 0
    const max = Number.isFinite(cfg.maxMs) ? cfg.maxMs : min
    return Math.max(0, Math.min(max, Math.max(min, Math.floor(jittered))))
  }

  function normalizeSayScript (args = {}, fallbackText = '') {
    const typingCfg = normalizeTypingCfg(args?.typing)
    const gapMsRaw = Number(args?.gapMs)
    const gapMs = Number.isFinite(gapMsRaw) ? Math.max(0, Math.floor(gapMsRaw)) : 300
    const cancelPrevious = args?.cancelPrevious !== false
    const maxLen = Math.max(40, Math.min(240, Number(state.ai?.maxReplyLen) || SAY_LIMITS.maxReplyLen))

    const rawSteps = Array.isArray(args?.steps) ? args.steps
      : Array.isArray(args?.messages) ? args.messages.map((t, idx) => ({ text: t, pauseMs: idx === args.messages.length - 1 ? 0 : gapMs }))
        : (args?.text ? [{ text: args.text }] : (fallbackText ? [{ text: fallbackText }] : []))

    const out = []
    let totalMs = 0
    const pushPause = (pauseMs) => {
      const ms = Math.max(0, Math.floor(Number(pauseMs) || 0))
      if (!ms) return
      totalMs += ms
      out.push({ kind: 'pause', pauseMs: ms })
    }

    const pushText = (text, step) => {
      const trimmed = H.trimReply(text, maxLen)
      if (!trimmed) return
      const typing = typeof step?.typing === 'boolean' ? step.typing : null
      const pauseMs = step?.pauseMs ?? step?.waitMs ?? step?.delayMs
      out.push({ kind: 'text', text: trimmed, typing, pauseMs })
      const ms = Math.max(0, Math.floor(Number(pauseMs) || 0))
      if (ms) totalMs += ms
    }

    for (const step of rawSteps) {
      if (out.length >= SAY_LIMITS.maxSteps) break
      if (typeof step === 'string') {
        const lines = String(step).split(/\n+/g).map(s => s.trim()).filter(Boolean)
        for (const line of lines) {
          if (out.length >= SAY_LIMITS.maxSteps) break
          pushText(line, { pauseMs: gapMs })
        }
        continue
      }
      if (!step || typeof step !== 'object') continue
      const pauseOnly = step.pauseMs ?? step.waitMs ?? step.delayMs
      const text = step.text ?? step.message ?? step.content
      if (text) {
        const lines = String(text).split(/\n+/g).map(s => s.trim()).filter(Boolean)
        if (lines.length <= 1) pushText(lines[0] || '', step)
        else {
          for (let i = 0; i < lines.length && out.length < SAY_LIMITS.maxSteps; i++) {
            pushText(lines[i], { ...step, pauseMs: i === lines.length - 1 ? pauseOnly : gapMs })
          }
        }
      } else if (pauseOnly != null) {
        pushPause(pauseOnly)
      }
    }

    if (totalMs > SAY_LIMITS.maxTotalMs) {
      // Best-effort clamp: keep steps but cap total pause time.
      let remaining = SAY_LIMITS.maxTotalMs
      for (const entry of out) {
        if (entry.kind !== 'pause' && entry.kind !== 'text') continue
        const ms = Math.max(0, Math.floor(Number(entry.pauseMs) || 0))
        if (!ms) continue
        if (remaining <= 0) entry.pauseMs = 0
        else if (ms > remaining) { entry.pauseMs = remaining; remaining = 0 } else remaining -= ms
      }
    }

    return { steps: out, typingCfg, cancelPrevious }
  }

  function say (username, args = {}, opts = {}) {
    const fallbackText = String(opts?.fallbackText || '')
    const normalized = normalizeSayScript(args, fallbackText)
    const steps = normalized.steps
    if (!username || !steps.length) return false

    if (normalized.cancelPrevious) cancelSay(username, 'superseded')

    const sayState = ensureSayState()
    sayState.seq += 1
    const token = sayState.seq
    sayState.activeByUser.set(username, { token, startedAt: now() })
    const ctrl = { aborted: false, reason: null, timer: null, resolve: null, token }
    sayCtrlByUser.set(username, ctrl)

    ;(async () => {
      const lastTextIdx = (() => {
        for (let i = steps.length - 1; i >= 0; i--) if (steps[i]?.kind === 'text') return i
        return -1
      })()
      for (let i = 0; i < steps.length; i++) {
        if (ctrl.aborted) return
        if (sayCtrlByUser.get(username) !== ctrl) return
        const step = steps[i]
        if (!step) continue
        if (step.kind === 'pause') {
          if (!(await delayMs(step.pauseMs, ctrl))) return
          continue
        }
        if (step.kind !== 'text') continue
        const typingEnabled = typeof step.typing === 'boolean' ? step.typing : normalized.typingCfg.enabled
        if (typingEnabled) {
          const ms = computeTypingDelay(step.text, normalized.typingCfg)
          if (ms && !(await delayMs(ms, ctrl))) return
        }
        const isLastText = i === lastTextIdx
        sendChatReply(username, step.text, {
          ...opts,
          reason: opts.reason || 'say',
          toolUsed: opts.toolUsed || 'say',
          suppressFeedback: !isLastText
        })
        if (step.pauseMs) {
          if (!(await delayMs(step.pauseMs, ctrl))) return
        }
      }
    })().catch(err => log?.warn && log.warn('say script error:', err?.message || err))
      .finally(() => {
        if (sayCtrlByUser.get(username) === ctrl) sayCtrlByUser.delete(username)
        try {
          const active = ensureSayState().activeByUser.get(username)
          if (active?.token === token) ensureSayState().activeByUser.delete(username)
        } catch {}
      })

    return true
  }

  function pulseEnabled () {
    return Boolean(state.aiPulse?.enabled && state.ai.enabled && state.ai.key)
  }

  function ensurePendingStore () {
    if (!(state.aiPulse.pendingByUser instanceof Map)) state.aiPulse.pendingByUser = new Map()
    return state.aiPulse.pendingByUser
  }

  function prunePendingStore () {
    const store = ensurePendingStore()
    const cutoff = now() - PULSE_PENDING_EXPIRE_MS
    let total = state.aiPulse.totalPending || 0
    for (const [name, info] of store.entries()) {
      if (!info || info.count <= 0 || !Number.isFinite(info.lastAt) || info.lastAt < cutoff) {
        total -= info?.count || 0
        store.delete(name)
      }
    }
    if (store.size > 40) {
      const ordered = [...store.entries()].sort((a, b) => (a[1]?.lastAt || 0) - (b[1]?.lastAt || 0))
      while (ordered.length > 40) {
        const [key, info] = ordered.shift()
        total -= info?.count || 0
        store.delete(key)
      }
    }
    state.aiPulse.totalPending = Math.max(0, total)
    if (!state.aiPulse.totalPending) {
      state.aiPulse.pendingSince = null
      state.aiPulse.pendingLastAt = null
    }
  }

  function clonePendingStore () {
    const store = ensurePendingStore()
    const clone = new Map()
    for (const [name, info] of store.entries()) {
      if (!info || !info.count) continue
      clone.set(name, { count: info.count, lastAt: Number(info.lastAt) || now() })
    }
    return clone
  }

  function restorePendingStore (backup) {
    const store = ensurePendingStore()
    store.clear()
    if (!(backup instanceof Map)) {
      state.aiPulse.totalPending = 0
      state.aiPulse.pendingSince = null
      state.aiPulse.pendingLastAt = null
      return
    }
    let total = 0
    let earliest = null
    let latest = null
    for (const [name, info] of backup.entries()) {
      const count = Number(info?.count) || 0
      if (count <= 0) continue
      const lastAt = Number(info.lastAt) || now()
      store.set(name, { count, lastAt })
      total += count
      if (earliest == null || lastAt < earliest) earliest = lastAt
      if (latest == null || lastAt > latest) latest = lastAt
    }
    state.aiPulse.totalPending = total
    state.aiPulse.pendingSince = total > 0 ? earliest : null
    state.aiPulse.pendingLastAt = total > 0 ? latest : null
  }

  function resetPendingStore () {
    const store = ensurePendingStore()
    store.clear()
    state.aiPulse.totalPending = 0
    state.aiPulse.pendingSince = null
    state.aiPulse.pendingLastAt = null
  }

  function pendingCountFor (username) {
    if (!username) return 0
    const entry = ensurePendingStore().get(username)
    return entry ? (entry.count || 0) : 0
  }

  function ensureActiveSessions () {
    if (!(state.aiPulse.activeUsers instanceof Map)) state.aiPulse.activeUsers = new Map()
    return state.aiPulse.activeUsers
  }

  function cleanupActiveSessions () {
    const sessions = ensureActiveSessions()
    const nowTs = now()
    for (const [name, info] of sessions.entries()) {
      if (!info || !Number.isFinite(info.expiresAt) || info.expiresAt <= nowTs) {
        if (info?.timer) {
          try { clearTimeout(info.timer) } catch {}
        }
        sessions.delete(name)
        memory.dialogue.queueSummary(name, info, 'expire')
      }
    }
  }

  function activateSession (username, reason, options = {}) {
    if (!username) return
    cleanupActiveSessions()
    const sessions = ensureActiveSessions()
    let entry = sessions.get(username)
    const restart = options.restart === true
    const nowTs = now()
    if (!entry) entry = {}
    const stillActive = Number.isFinite(entry.expiresAt) && entry.expiresAt > nowTs
    const continuing = restart && stillActive
    if (entry.timer) {
      try { clearTimeout(entry.timer) } catch {}
      entry.timer = null
    }
    if (restart && Number.isFinite(entry.startSeq) && !continuing) {
      const summaryEntry = { ...entry, lastSeq: entry.lastSeq || entry.startSeq }
      memory.dialogue.queueSummary(username, summaryEntry, 'restart')
      entry.startSeq = null
    }
    if (!Number.isFinite(entry.startSeq)) {
      entry.startSeq = Number.isFinite(state.aiRecentSeq) ? state.aiRecentSeq : 0
    }
    if (!Number.isFinite(entry.startedAt)) entry.startedAt = nowTs
    if (!(entry.participants instanceof Set)) entry.participants = new Set()
    if (username && username !== bot.username) entry.participants.add(username)
    entry.expiresAt = nowTs + ACTIVE_CHAT_WINDOW_MS
    entry.reason = reason || entry.reason || 'trigger'
    entry.awaiting = false
    sessions.set(username, entry)
  }

  function touchConversationSession (username, extraParticipants = []) {
    if (!username) return
    const sessions = ensureActiveSessions()
    const entry = sessions.get(username)
    if (!entry) return
    if (!(entry.participants instanceof Set)) entry.participants = new Set()
    if (username !== bot.username) entry.participants.add(username)
    for (const name of extraParticipants) {
      if (!name || name === bot.username) continue
      entry.participants.add(name)
    }
    entry.lastSeq = Number.isFinite(state.aiRecentSeq) ? state.aiRecentSeq : entry.lastSeq
    entry.lastAt = now()
  }

  function scheduleActiveFollowup (username) {
    if (!pulseEnabled()) return
    if (!username) return
    cleanupActiveSessions()
    const sessions = ensureActiveSessions()
    const entry = sessions.get(username)
    if (!entry) return
    if (entry.timer) {
      try { clearTimeout(entry.timer) } catch {}
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      maybeFlush('active', { username })
    }, ACTIVE_FOLLOW_DELAY_MS)
    entry.awaiting = true
    entry.lastMessageAt = now()
    sessions.set(username, entry)
  }

  function clearActiveFollowup (username) {
    if (!username) return
    const sessions = ensureActiveSessions()
    const entry = sessions.get(username)
    if (!entry) return
    if (entry.timer) {
      try { clearTimeout(entry.timer) } catch {}
      entry.timer = null
    }
    entry.awaiting = false
    sessions.set(username, entry)
  }

  function resetActiveSessions () {
    const sessions = ensureActiveSessions()
    for (const [name, info] of sessions.entries()) {
      if (info?.timer) {
        try { clearTimeout(info.timer) } catch {}
      }
      memory.dialogue.queueSummary(name, info, 'reset')
      sessions.delete(name)
    }
  }

  function pushRecentChatEntry (username, text, kind = 'player', meta = {}) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return null
    if (!Array.isArray(state.aiRecent)) state.aiRecent = []
    if (!Number.isFinite(state.aiRecentSeq)) state.aiRecentSeq = 0
    state.aiRecentSeq += 1
    const entry = { t: now(), user: username || '??', text: trimmed.slice(0, 160), kind, seq: state.aiRecentSeq }
    state.aiRecent.push(entry)
    enforceRecentLimit()
    if (contextBus) {
      if (kind === 'player') contextBus.pushPlayer(username, trimmed)
      else if (kind === 'bot') {
        const from = String(meta?.from || '').trim()
        if (from && typeof contextBus.pushBotFrom === 'function') contextBus.pushBotFrom(trimmed, from)
        else contextBus.pushBot(trimmed)
      }
    }
    return entry
  }

  function enforceRecentLimit () {
    const cs = state.ai.context || {}
    const recentMax = Math.max(20, cs.recentStoreMax || 200)
    if (state.aiRecent.length <= recentMax) return
    const overflow = state.aiRecent.splice(0, state.aiRecent.length - recentMax)
    scheduleOverflowSummary(overflow)
  }

  function scheduleOverflowSummary (overflow) {
    if (!overflow || overflow.length < 20) return
    ;(async () => {
      try {
        if (!state.ai?.key) return
        const sys = '你是对Minecraft服务器聊天内容做摘要的助手。请用中文，20-40字，概括下面聊天要点，保留人名与关键物品/地点。不要换行。'
        const prompt = overflow.map(r => `${r.user}: ${r.text}`).join(' | ')
        const messages = [ { role: 'system', content: sys }, { role: 'user', content: prompt } ]
        const url = (state.ai.baseUrl || defaults.DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || defaults.DEFAULT_PATH)
        const body = { model: state.ai.model || defaults.DEFAULT_MODEL, messages, temperature: 0.2, max_tokens: 60, stream: false }
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.ai.key}` }, body: JSON.stringify(body) })
          if (!res.ok) return
          const data = await res.json()
          const sum = data?.choices?.[0]?.message?.content?.trim()
          if (!sum) return
          state.aiLong.push({ t: Date.now(), summary: sum })
          if (state.aiLong.length > 50) state.aiLong.splice(0, state.aiLong.length - 50)
          memory.longTerm.persistState()
          if (state.ai.trace && log?.info) log.info('long summary ->', sum)
        } catch {}
      } catch {}
    })()
  }

  function recordBotChat (text, meta = {}) {
    try {
      pushRecentChatEntry(bot?.username || 'bot', text, 'bot', meta)
    } catch {}
  }

  function recordToolOutput (text) {
    try {
      if (contextBus) contextBus.pushTool(text)
    } catch {}
  }

  function enqueuePulse (username, text) {
    try {
      if (!pulseEnabled()) return
      if (!username || username === bot.username) return
      const trimmed = String(text || '').trim()
      if (!trimmed) return
      const replyStore = state.aiRecentReplies instanceof Map ? state.aiRecentReplies : null
      const lastReplyAt = replyStore ? replyStore.get(username) : null
      if (lastReplyAt && now() - lastReplyAt <= PULSE_RECENT_REPLY_SUPPRESS_MS) return
      prunePendingStore()
      const store = ensurePendingStore()
      const entry = store.get(username) || { count: 0, lastAt: 0 }
      entry.count = (entry.count || 0) + 1
      entry.lastAt = now()
      store.set(username, entry)
      const prevTotal = state.aiPulse.totalPending || 0
      state.aiPulse.totalPending = prevTotal + 1
      if (!prevTotal) state.aiPulse.pendingSince = entry.lastAt
      state.aiPulse.pendingLastAt = entry.lastAt
      if (isUserActive(username)) scheduleActiveFollowup(username)
      maybeFlush('count')
    } catch (e) {
      if (log?.warn) log.warn('pulse enqueue error:', e?.message || e)
    }
  }

  function ensurePulseHistory () {
    if (!(state.aiPulse.recentKeys instanceof Map)) state.aiPulse.recentKeys = new Map()
    return state.aiPulse.recentKeys
  }

  function normalizePulseText (text) {
    if (typeof text !== 'string') return ''
    return text.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  function stripMcFormatting (text) {
    try {
      return String(text ?? '').replace(/\u00a7[0-9A-FK-OR]/gi, '')
    } catch {
      return ''
    }
  }

  function normalizeDeathChestText (text) {
    return stripMcFormatting(text).replace(/\s+/g, ' ').trim()
  }

  function ensureDeathChestSeen () {
    if (!state.aiPulse) state.aiPulse = {}
    if (!(state.aiPulse.deathChestSeen instanceof Map)) state.aiPulse.deathChestSeen = new Map()
    return state.aiPulse.deathChestSeen
  }

  function markDeathChestSeen (text) {
    try {
      const store = ensureDeathChestSeen()
      const ts = now()
      store.set(text, ts)
      const cutoff = ts - DEATHCHEST_DEDUPE_MS
      for (const [msg, seen] of store.entries()) {
        if (!Number.isFinite(seen) || seen < cutoff) store.delete(msg)
      }
    } catch {}
  }

  function seenDeathChestRecently (text) {
    try {
      const store = ensureDeathChestSeen()
      const seen = store.get(text)
      return Number.isFinite(seen) && (now() - seen <= DEATHCHEST_DEDUPE_MS)
    } catch {
      return false
    }
  }

  function handleDeathChestNotice (text, username = '') {
    const normalized = normalizeDeathChestText(text)
    if (!normalized) return false
    const lower = normalized.toLowerCase()
    const isPluginUser = String(username || '').trim().toLowerCase() === 'deathchest'
    if (!isPluginUser && !lower.includes('deathchest')) return false
    const canonical = normalized.replace(/^\[deathchest\]\s*/i, '')
    const payloadText = /^\[deathchest\]/i.test(normalized) ? normalized : `[DeathChest] ${canonical}`
    if (seenDeathChestRecently(canonical)) {
      markDeathChestSeen(canonical)
      return true
    }
    markDeathChestSeen(canonical)
    recordEvent('death_info', payloadText)
    if (contextBus) contextBus.pushEvent('death_info', payloadText)
    return true
  }

  function parseAngleBracketPlayerChat (plain) {
    const cleaned = stripMcFormatting(plain).trim()
    const m = cleaned.match(/^<([^>]{1,40})>\s*(.+)$/)
    if (!m) return null
    const name = String(m[1] || '').trim()
    const content = String(m[2] || '').trim()
    if (!name || !content) return null
    if (/\s/.test(name)) return null
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return null
    if (/^server$/i.test(name)) return null
    return { name, content }
  }

  function ensureSeenPlayerChats () {
    if (!(state.aiPulse.seenPlayerChats instanceof Map)) state.aiPulse.seenPlayerChats = new Map()
    return state.aiPulse.seenPlayerChats
  }

  function playerChatKey (username, text) {
    const entry = { user: username, text }
    return pulseKey(entry)
  }

  function seenPlayerChatRecently (username, text, windowMs) {
    try {
      if (!state.aiPulse) return false
      const store = ensureSeenPlayerChats()
      const key = playerChatKey(username, text)
      if (!key) return false
      const ts = store.get(key)
      const win = Number.isFinite(Number(windowMs)) ? Math.max(0, Math.floor(Number(windowMs))) : PLAYER_CHAT_DEDUPE_MS
      return Number.isFinite(ts) && (now() - ts <= win)
    } catch {
      return false
    }
  }

  function markPlayerChatSeen (username, text) {
    try {
      if (!state.aiPulse) state.aiPulse = {}
      const store = ensureSeenPlayerChats()
      const key = playerChatKey(username, text)
      if (!key) return
      const ts = now()
      store.set(key, ts)
      const cutoff = ts - PLAYER_CHAT_DEDUPE_MS
      for (const [k, seen] of store.entries()) {
        if (!Number.isFinite(seen) || seen < cutoff) store.delete(k)
      }
      if (store.size > 256) {
        const ordered = [...store.entries()].sort((a, b) => (a[1] || 0) - (b[1] || 0))
        while (ordered.length > 200) {
          const [k] = ordered.shift()
          store.delete(k)
        }
      }
    } catch {}
  }

  function pulseKey (entry) {
    if (!entry) return ''
    const user = String(entry.user || '').trim().toLowerCase()
    const text = normalizePulseText(entry.text || '')
    if (!user && !text) return ''
    return `${user}#${text}`
  }

  function markPulseHandled (entries, ts) {
    try {
      if (!entries || !entries.length) return
      const history = ensurePulseHistory()
      for (const entry of entries) {
        const key = pulseKey(entry)
        if (!key) continue
        history.set(key, ts)
      }
      const cutoff = ts - PULSE_REPEAT_SUPPRESS_MS
      for (const [key, seen] of history.entries()) {
        if (seen < cutoff) history.delete(key)
      }
      if (history.size > 160) {
        const ordered = [...history.entries()].sort((a, b) => a[1] - b[1])
        while (history.size > 120 && ordered.length) {
          const [key] = ordered.shift()
          history.delete(key)
        }
      }
    } catch {}
  }

  function noteRecentReply (username) {
    if (!username) return
    try {
      if (!(state.aiRecentReplies instanceof Map)) state.aiRecentReplies = new Map()
      const store = state.aiRecentReplies
      const nowTs = now()
      store.set(username, nowTs)
      const EXPIRE_MS = 2 * 60 * 1000
      for (const [name, ts] of [...store.entries()]) {
        if (nowTs - ts > EXPIRE_MS) store.delete(name)
      }
      if (store.size > 64) {
        const ordered = [...store.entries()].sort((a, b) => a[1] - b[1])
        while (ordered.length > 64) {
          const [name] = ordered.shift()
          store.delete(name)
        }
      }
    } catch {}
  }

  function recordCommandDid (text) {
    try {
      const trimmed = String(text || '').trim()
      if (!trimmed.startsWith('/')) return
      const cmd = trimmed.slice(1).split(/\s+/, 1)[0].toLowerCase()
      const tracked = new Set(['tpa', 'tpaccept', 'sit', 'lay', 'sitdown', 'gsit', 'glay', 'gstand'])
      if (!tracked.has(cmd)) return
      try { contextBus?.pushEvent?.('command', cmd) } catch {}
      const ms = (() => { try { return require('../minimal-self').getInstance() } catch { return null } })()
      if (!ms) return
      try { ms.getIdentity?.().recordSkillOutcome?.(cmd, true, 0.95) } catch {}
      try { ms.getNarrative?.().recordDid?.(`指令:${cmd}`, null, 'command') } catch {}
    } catch {}
  }

  function sendDirectReply (username, text, opts = {}) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    try {
      bot.chat(trimmed)
      recordCommandDid(trimmed)
      recordBotChat(trimmed, opts)
      if (state.aiPulse && Number.isFinite(state.aiRecentSeq)) state.aiPulse.lastSeq = state.aiRecentSeq
    } catch {}
    noteRecentReply(username)
    try {
      if (!state.aiPulse) return
      resetPendingStore()
      state.aiPulse.lastReason = 'user_reply'
      state.aiPulse.lastFlushAt = now()
      state.aiPulse.lastMessage = null
      state.aiPulse.lastMessageAt = now()
      clearActiveFollowup(username)
    } catch {}
  }

  function sendChatReply (username, text, opts = {}) {
    sendDirectReply(username, text, opts)
    activateSession(username, opts.reason || 'chat')
    touchConversationSession(username)
    // REFS: 打开反馈窗口
    if (!opts.suppressFeedback && feedbackCollector && typeof feedbackCollector.openFeedbackWindow === 'function') {
      try {
        feedbackCollector.openFeedbackWindow({
          botMessage: text,
          targetUser: username,
          memoryRefs: opts.memoryRefs || [],
          toolUsed: opts.toolUsed || null,
          context: opts.reason || 'chat'
        })
      } catch {}
    }
  }

  function shouldFlushByCount () {
    const store = ensurePendingStore()
    if (!store.size) return false
    let total = 0
    let hasSpam = false
    for (const info of store.values()) {
      const count = Number(info?.count) || 0
      if (count >= 2) hasSpam = true
      total += count
    }
    if (total <= 0) return false
    if (hasSpam) return true
    const dynamic = Math.min(PULSE_MAX_MESSAGES, Math.max(3, store.size * 2))
    return total >= dynamic
  }

  function pendingUsers () {
    const out = new Set()
    const store = ensurePendingStore()
    for (const [name, info] of store.entries()) {
      if (!info || info.count <= 0) continue
      out.add(name)
    }
    return out
  }

  function buildPulseBatch (options = {}) {
    const lines = Array.isArray(state.aiRecent) ? state.aiRecent : []
    if (!lines.length) return null
    const lastSeq = Number(state.aiPulse.lastSeq) || 0
    const focusUsers = pendingUsers()
    if (!focusUsers.size && !options.force) return null
    const MAX_SCAN = 200
    const window = []
    for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < MAX_SCAN; i--, scanned++) {
      const entry = lines[i]
      if (!entry || typeof entry !== 'object') continue
      const user = entry.user
      const include = focusUsers.has(user) || entry?.kind === 'bot' || options.force
      if (include) window.push(entry)
    }
    if (!window.length) return null
    window.reverse()
    const capped = window.slice(-PULSE_MAX_MESSAGES)
    const processed = capped.filter(entry => focusUsers.has(entry?.user) && Number(entry?.seq) > lastSeq)
    if (!processed.length && !options.force) return null
    const nextSeq = processed.length ? processed[processed.length - 1].seq : lastSeq
    return { entries: capped, processed, lastSeq: nextSeq }
  }

  async function runPulseModel ({ transcript, signal }) {
    const { key, baseUrl, path, model } = state.ai || {}
    if (!key) return ''
    const botName = bot?.username || 'bot'
    const instructions = loadPulsePrompt(botName)
    const gameCtx = buildGameContext()
    const sharedCtx = buildContextPrompt(botName)
    const extrasCtx = buildExtrasContext()
    const messages = [
      { role: 'system', content: instructions },
      extrasCtx ? { role: 'system', content: extrasCtx } : null,
      gameCtx ? { role: 'system', content: gameCtx } : null,
      sharedCtx ? { role: 'system', content: sharedCtx } : null,
      { role: 'user', content: `机器人昵称：${botName}\n以下是最近的玩家聊天（时间顺序）：\n${transcript}\n\n请给出是否需要回应。` }
    ].filter(Boolean)
    const estIn = H.estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (!afford.ok) return ''
    const url = (baseUrl || defaults.DEFAULT_BASE).replace(/\/$/, '') + (path || defaults.DEFAULT_PATH)
    const body = {
      model: model || defaults.DEFAULT_MODEL,
      messages,
      temperature: 0.5,
      max_tokens: Math.max(80, Math.min(180, state.ai.maxTokensPerCall || 200)),
      stream: false
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
      signal
    })
    if (!res.ok) return ''
    const data = await res.json()
    const reply = data?.choices?.[0]?.message?.content || ''
    const usage = data?.usage || {}
    const inTok = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : estIn
    const outTok = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : H.estTokensFromText(reply)
    applyUsage(inTok, outTok)
    return H.trimReply(reply, Math.max(60, state.ai.maxReplyLen || 120))
  }

  function loadPulsePrompt (botName) {
    const fs = require('fs')
    const path = require('path')
    const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'pulse-system.txt')
    let raw = null
    try { raw = fs.readFileSync(PROMPT_FILE, 'utf8') } catch {}
    if (!raw) {
      raw = [
        '你是Minecraft服务器里的友好机器人。',
        '阅读最近玩家的聊天摘录，判断是否需要你主动回应。如果需要回应，直接输出回应具体内容。',
        '目标：让所有玩家觉得可爱、有趣，并感到被关注，增强参与感。',
        '请用中文，口吻俏皮亲切、简短自然，像平时一起玩的伙伴。',
        '限制：单句或两句，总长度不超过60字；不要暴露这是自动总结。',
        '如果无需回应，请输出单词 SKIP。'
      ].join('\n')
    }
    return raw.replace(/{{BOT_NAME}}/g, botName)
  }

  async function flushPulse (trigger, options = {}) {
    if (pulseCtrl.running) return
    const prevFlushAt = state.aiPulse.lastFlushAt || 0
    const prevReason = state.aiPulse.lastReason
    const prevSeq = Number(state.aiPulse.lastSeq) || 0
    const prevPending = clonePendingStore()
    const prevTotal = state.aiPulse.totalPending || 0
    const prevSince = state.aiPulse.pendingSince
    const prevLastAt = state.aiPulse.pendingLastAt
    const batch = buildPulseBatch(options)
    if (!batch) {
      state.aiPulse.lastMessage = null
      return
    }
    state.aiPulse.lastFlushAt = now()
    state.aiPulse.lastReason = trigger
    state.aiPulse.lastSeq = batch.lastSeq
    resetPendingStore()
    let revert = true
    const nowTs = now()
    const history = ensurePulseHistory()
    const filteredBatch = batch.processed.filter(entry => {
      const key = pulseKey(entry)
      if (!key) return false
      const seen = history.get(key)
      if (seen && nowTs - seen < PULSE_REPEAT_SUPPRESS_MS) return false
      return true
    })
    if (!filteredBatch.length) {
      state.aiPulse.lastMessage = null
      revert = false
      return
    }
    const transcript = filteredBatch.map(r => `${r.user}: ${r.text}`).join('\n')
    pulseCtrl.running = true
    let summary = ''
    let timeout = null
    try {
      const ac = new AbortController()
      pulseCtrl.abort = ac
      const timeoutMs = Number.isFinite(state.ai?.timeoutMs) && state.ai.timeoutMs > 0
        ? state.ai.timeoutMs
        : defaults.DEFAULT_TIMEOUT_MS
      timeout = setTimeout(() => ac.abort('pulse_timeout'), timeoutMs)
      summary = await runPulseModel({ transcript, signal: ac.signal })
      if (!summary) {
        revert = false
        return
      }
      const trimmed = summary.trim()
      if (!trimmed) return
      if (/^skip$/i.test(trimmed)) {
        state.aiPulse.lastMessage = null
        revert = false
        return
      }
      markPulseHandled(filteredBatch, now())
      state.aiPulse.lastMessage = trimmed
      state.aiPulse.lastMessageAt = now()
      if (log?.info) log.info('pulse reply ->', trimmed)
      try {
        bot.chat(trimmed)
        recordBotChat(trimmed, { from: 'LLM' })
      } catch (e) { if (log?.warn) log.warn('pulse chat error:', e?.message || e) }
      if (options.username && trigger === 'active') activateSession(options.username, 'pulse_followup')
      revert = false
    } catch (err) {
      if (log?.warn) log.warn('pulse flush error:', err?.message || err)
    } finally {
      clearTimeout(timeout)
      pulseCtrl.running = false
      pulseCtrl.abort = null
      if (revert) {
        state.aiPulse.lastFlushAt = prevFlushAt
        state.aiPulse.lastReason = prevReason
        state.aiPulse.lastSeq = prevSeq
        restorePendingStore(prevPending)
        state.aiPulse.totalPending = prevTotal
        state.aiPulse.pendingSince = prevSince
        state.aiPulse.pendingLastAt = prevLastAt
        if (options.username && trigger === 'active') scheduleActiveFollowup(options.username)
        if (log?.warn) log.warn('pulse flush failed; batch restored')
      }
    }
  }

  function maybeFlush (reason, options = {}) {
    try {
      if (memory?.dialogue?.maybeRunAggregation) {
        Promise.resolve(memory.dialogue.maybeRunAggregation()).catch(err => log?.warn && log.warn('dialog aggregation error:', err?.message || err))
      }
      if (!pulseEnabled()) return
      if (pulseCtrl.running) return
      prunePendingStore()
      cleanupActiveSessions()
      if (options.force) {
        flushPulse(reason, options).catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
        return
      }
      if (reason === 'active') {
        const target = options.username
        if (!target) return
        if (pendingCountFor(target) <= 0) return
        clearActiveFollowup(target)
        flushPulse('active', options).catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
        return
      }
      const total = state.aiPulse.totalPending || 0
      if (total <= 0) return
      if (reason === 'count' && shouldFlushByCount()) {
        flushPulse('count', options).catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
        return
      }
      if (reason === 'manual') {
        flushPulse('manual', options).catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
        return
      }
      const since = now() - (state.aiPulse.pendingSince || state.aiPulse.lastFlushAt || 0)
      if (since >= PULSE_INTERVAL_MS) {
        flushPulse(reason === 'timer' ? 'timer' : 'interval', options).catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
      }
    } catch (e) {
      if (log?.warn) log.warn('pulse maybeFlush error:', e?.message || e)
    }
  }

  function captureChat (username, message) {
    try {
      if (!username || username === bot.username) return
      const text = String(message || '').trim()
      if (!text) return
      if (handleDeathChestNotice(text, username)) return
      if (seenPlayerChatRecently(username, text, CHAT_EVENT_DEDUPE_MS)) return
      markPlayerChatSeen(username, text)
      pushRecentChatEntry(username, text, 'player')
      enqueuePulse(username, text)
    } catch {}
  }

  function start () {
    if (!state.aiPulse) state.aiPulse = {}
    if (state.aiPulse._timer) {
      try { clearInterval(state.aiPulse._timer) } catch {}
      state.aiPulse._timer = null
    }
    pulseTimer = setInterval(() => { maybeFlush('timer') }, PULSE_CHECK_MS)
    state.aiPulse._timer = pulseTimer
    maybeFlush('timer')
  }

  function stop () {
    for (const username of [...sayCtrlByUser.keys()]) cancelSay(username, 'cleanup')
    try { resetActiveSessions() } catch {}
    if (state.aiPulse?._timer) {
      try { clearInterval(state.aiPulse._timer) } catch {}
      state.aiPulse._timer = null
    }
    if (pulseTimer) {
      try { clearInterval(pulseTimer) } catch {}
      pulseTimer = null
    }
    if (pulseCtrl.abort && typeof pulseCtrl.abort.abort === 'function') {
      try { pulseCtrl.abort.abort('cleanup') } catch {}
    }
  }

  function fmtDuration (ms) {
    if (!Number.isFinite(ms) || ms < 0) return '未知'
    if (ms >= 60 * 1000) return `${Math.round(ms / 60000)}分钟`
    if (ms >= 1000) return `${Math.round(ms / 1000)}秒`
    return `${ms}毫秒`
  }

  function pulseStatus () {
    const info = state.aiPulse || {}
    const enabled = info.enabled !== false
    const pending = info.totalPending || 0
    const lastAt = info.lastFlushAt ? new Date(info.lastFlushAt).toLocaleTimeString() : '无'
    const since = info.lastFlushAt ? now() - info.lastFlushAt : Infinity
    const nextIn = pending > 0 ? Math.max(0, PULSE_INTERVAL_MS - since) : null
    cleanupActiveSessions()
    const active = ensureActiveSessions().size
    const topPending = [...ensurePendingStore().entries()].map(([name, data]) => `${name}:${data?.count || 0}`).filter(Boolean).slice(0, 3).join(', ') || 'none'
    console.log('[PULSE]', `enabled=${enabled}`, 'running=', pulseCtrl.running, 'pending=', pending, 'active=', active, 'last=', lastAt, 'lastReason=', info.lastReason || '无', 'next≈', nextIn == null ? '待消息' : fmtDuration(nextIn), 'lastMsg=', info.lastMessage || '(none)', 'top=', topPending)
  }

  function handlePulseCli (payload) {
    try {
      if (!payload || payload.cmd !== 'pulse') return
      const [sub] = payload.args || []
      const cmd = (sub || '').toLowerCase()
      if (!cmd || cmd === 'status') { pulseStatus(); return }
      if (cmd === 'on') {
        state.aiPulse.enabled = true
        console.log('[PULSE]', '已开启主动发言')
        maybeFlush('manual', { force: true })
        return
      }
      if (cmd === 'off') {
        state.aiPulse.enabled = false
        resetPendingStore()
        resetActiveSessions()
        console.log('[PULSE]', '已关闭主动发言')
        return
      }
      if (cmd === 'now' || cmd === 'run' || cmd === 'flush') {
        maybeFlush('manual', { force: true })
        return
      }
      console.log('[PULSE]', '未知子命令，支持: status|on|off|now')
    } catch (e) {
      if (log?.warn) log.warn('pulse cli error:', e?.message || e)
    }
  }

  function captureSystemMessage (message) {
    try {
      const plain = extractPlainText(message).trim()
      if (!plain) return
      if (handleDeathChestNotice(plain)) return
      const maybePlayer = parseAngleBracketPlayerChat(plain)
      if (maybePlayer) {
        const selfName = String(bot.username || '').trim()
        if (selfName && selfName.toLowerCase() === String(maybePlayer.name).toLowerCase()) return
        if (seenPlayerChatRecently(maybePlayer.name, maybePlayer.content, PLAYER_CHAT_DEDUPE_MS)) return
        captureChat(maybePlayer.name, maybePlayer.content)
        return
      }
      const lower = plain.toLowerCase()
      const selfName = String(bot.username || '')
      if (!selfName) return
      const selfLower = selfName.toLowerCase()
      const isSelf = lower.includes(selfLower)
      if (isSelf) {
        const deathPatterns = [' was slain ', ' was shot ', ' was blown up ', ' was killed ', ' was pricked ', ' hit the ground ', ' fell ', ' drowned', ' burned', ' blew up', ' suffocated', ' starved', ' tried to swim', ' died', ' went up in flames', ' experienced kinetic energy', ' was doomed to fall']
        if (deathPatterns.some(p => lower.includes(p))) {
          recordEvent('death', plain)
          if (contextBus) contextBus.pushEvent('death', plain)
        }
        const achievementPatterns = [' has made the advancement ', ' has completed the challenge ', ' has reached the goal ', ' completed the challenge ', ' advancement ']
        if (achievementPatterns.some(p => lower.includes(p))) {
          recordEvent('achievement', plain)
          if (contextBus) contextBus.pushEvent('achievement', plain)
        }
      }
      if (contextBus && !isSelf) {
        contextBus.pushServer(plain)
      }
    } catch {}
  }

  function extractPlainText (message) {
    if (!message) return ''
    try {
      if (typeof message.getText === 'function') return message.getText()
    } catch {}
    try {
      if (typeof message.toString === 'function') return message.toString()
    } catch {}
    try { return String(message) } catch { return '' }
  }

  function recordEvent (type, text) {
    try {
      const entry = { t: now(), type, text: String(text || '').trim() }
      if (!entry.text) return
      const events = state.aiExtras.events
      const last = events[events.length - 1]
      if (last && last.type === entry.type && last.text === entry.text) {
        last.t = entry.t
        return
      }
      events.push(entry)
      const max = 12
      if (events.length > max) events.splice(0, events.length - max)
    } catch {}
  }

  function buildExtrasContext () {
    try {
      const events = state.aiExtras.events || []
      if (!events.length) return ''
      const nowTs = now()
      const keep = events.filter(ev => nowTs - (ev.t || 0) <= 15 * 60 * 1000)
      if (!keep.length) return ''
      const MAX_LINES = 5
      const slice = keep.slice(-MAX_LINES)
      const label = (type) => {
        if (type === 'death') return '死亡'
        if (type === 'death_info') return '死亡信息'
        if (type === 'achievement') return '成就'
        return type || '事件'
      }
      const clock = (ts) => {
        const date = new Date(ts)
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
      }
      const parts = slice.map(ev => `${clock(ev.t)} ${label(ev.type)}: ${ev.text}`)
      return `近期事件: ${parts.join(' | ')}`
    } catch { return '' }
  }

  function isUserActive (username) {
    if (!username) return false
    cleanupActiveSessions()
    return ensureActiveSessions().has(username)
  }

  return {
    start,
    stop,
    sendChatReply,
    sendDirectReply,
    say,
    cancelSay,
    activateSession,
    touchConversationSession,
    enqueuePulse,
    captureChat,
    captureSystemMessage,
    handlePulseCli,
    pushRecentChatEntry,
    recordBotChat,
    recordToolOutput,
    buildExtrasContext,
    isUserActive
  }
}

module.exports = { createPulseService }
