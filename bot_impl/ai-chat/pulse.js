const ACTIVE_CHAT_WINDOW_MS = 120 * 1000
const ACTIVE_CHAT_CLEANUP_MS = 5000
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
  traceChat = () => {},
  memory,
  feedbackCollector = null,
  contextBus = null
}) {
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
    const configuredMaxLen = Number(state.ai?.maxReplyLen)
    const maxLen = Number.isFinite(configuredMaxLen) && configuredMaxLen > 0
      ? Math.floor(configuredMaxLen)
      : Infinity

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

    for (const step of rawSteps) {
      if (out.length >= SAY_LIMITS.maxSteps) break
      if (typeof step === 'string') {
        const lines = String(step).split(/\n+/g).map(s => s.trim()).filter(Boolean)
        for (const line of lines) {
          if (out.length >= SAY_LIMITS.maxSteps) break
          const text = line.slice(0, maxLen)
          if (!text) continue
          out.push({ kind: 'text', text, pauseMs: gapMs })
          totalMs += gapMs
        }
        continue
      }
      if (!step || typeof step !== 'object') continue
      const kind = step.kind || 'text'
      if (kind === 'pause') {
        pushPause(step.pauseMs ?? step.ms ?? step.delayMs ?? gapMs)
        continue
      }
      if (kind !== 'text') continue
      const text = String(step.text || '').trim().slice(0, maxLen)
      if (!text) continue
      out.push({
        kind: 'text',
        text,
        pauseMs: Number.isFinite(Number(step.pauseMs)) ? Math.max(0, Math.floor(Number(step.pauseMs))) : gapMs,
        typing: typeof step.typing === 'boolean' ? step.typing : undefined
      })
      totalMs += Number(out[out.length - 1].pauseMs) || 0
    }

    if (totalMs > SAY_LIMITS.maxTotalMs) {
      let remaining = SAY_LIMITS.maxTotalMs
      for (const entry of out) {
        if (entry?.kind !== 'pause' && entry?.kind !== 'text') continue
        const ms = Math.max(0, Math.floor(Number(entry.pauseMs) || 0))
        if (!ms) continue
        if (remaining <= 0) entry.pauseMs = 0
        else if (ms > remaining) { entry.pauseMs = remaining; remaining = 0 } else remaining -= ms
      }
    }

    const lastTextIdx = (() => {
      for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === 'text') return i
      return -1
    })()

    return { steps: out, lastTextIdx, typingCfg, cancelPrevious }
  }

  function say (username, args = {}, opts = {}) {
    const text = String(args?.text || '').trim()
    const normalized = normalizeSayScript(args, text)
    if (!normalized.steps.length) return false
    if (!username || username === bot.username) return false

    try {
      if (contextBus) {
        const from = String(opts?.from || '').trim()
        for (const step of normalized.steps) {
          if (!step || step.kind !== 'text') continue
          const line = String(step.text || '').trim()
          if (!line) continue
          if (from && typeof contextBus.pushBotFrom === 'function') contextBus.pushBotFrom(line, from)
          else if (typeof contextBus.pushBot === 'function') contextBus.pushBot(line)
        }
      }
    } catch {}

    const cancelPrevious = normalized.cancelPrevious !== false
    if (cancelPrevious) cancelSay(username, 'superseded')

    const token = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`
    const ctrl = { token, aborted: false, timer: null, resolve: null }
    sayCtrlByUser.set(username, ctrl)
    try {
      ensureSayState().activeByUser.set(username, { token, startedAt: now() })
    } catch {}

    ;(async () => {
      const lastTextIdx = normalized.lastTextIdx
      for (let i = 0; i < normalized.steps.length; i++) {
        if (ctrl.aborted) return
        const step = normalized.steps[i]
        if (!step || step.kind === 'pause') {
          if (!(await delayMs(step?.pauseMs ?? 0, ctrl))) return
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
          suppressRecord: true,
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

  function ensureActiveSessions () {
    if (!state.aiPulse || typeof state.aiPulse !== 'object') state.aiPulse = {}
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
        try { memory?.dialogue?.queueSummary?.(name, info, 'expire') } catch {}
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
      try { memory?.dialogue?.queueSummary?.(username, summaryEntry, 'restart') } catch {}
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
    sessions.set(username, entry)
  }

  function startSessionCleanupTimer () {
    try {
      if (!state.aiPulse || typeof state.aiPulse !== 'object') state.aiPulse = {}
      if (state.aiPulse._timer) return
      state.aiPulse._timer = setInterval(() => {
        try { cleanupActiveSessions() } catch {}
      }, ACTIVE_CHAT_CLEANUP_MS)
      try { state.aiPulse._timer.unref && state.aiPulse._timer.unref() } catch {}
    } catch {}
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

  function resetActiveSessions () {
    const sessions = ensureActiveSessions()
    for (const [name, info] of sessions.entries()) {
      if (info?.timer) {
        try { clearTimeout(info.timer) } catch {}
      }
      try { memory?.dialogue?.queueSummary?.(name, info, 'reset') } catch {}
      sessions.delete(name)
    }
  }

  function isUserActive (username) {
    if (!username) return false
    cleanupActiveSessions()
    return ensureActiveSessions().has(username)
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
        if (typeof H?.buildAiUrl !== 'function' || typeof H?.extractAssistantText !== 'function') return
        const sys = '你是对Minecraft服务器聊天内容做摘要的助手。请用中文，20-40字，概括下面聊天要点，保留人名与关键物品/地点。不要换行。'
        const prompt = overflow.map(r => `${r.user}: ${r.text}`).join(' | ')
        const messages = [ { role: 'system', content: sys }, { role: 'user', content: prompt } ]
        const apiPath = state.ai.pathOverride || state.ai.path || defaults.DEFAULT_PATH
        const url = H.buildAiUrl({ baseUrl: state.ai.baseUrl, path: apiPath, defaultBase: defaults.DEFAULT_BASE, defaultPath: defaults.DEFAULT_PATH })
        const useResponses = typeof H.isResponsesApiPath === 'function' && H.isResponsesApiPath(apiPath)
        const body = useResponses
          ? { model: state.ai.model || defaults.DEFAULT_MODEL, input: messages, max_output_tokens: 1024 }
          : { model: state.ai.model || defaults.DEFAULT_MODEL, messages, temperature: 0.2, max_tokens: 1024, stream: false }
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.ai.key}` }, body: JSON.stringify(body) })
          if (!res.ok) {
            if (state.ai?.trace && log?.info) {
              try {
                const text = await res.text().catch(() => '')
                log.info('[overflow] http error', res.status, text.slice(0, 240))
              } catch {}
            }
            return
          }
          const data = await res.json().catch((err) => {
            if (state.ai?.trace && log?.info) log.info('[overflow] json parse error', err?.message || err)
            return null
          })
          if (!data) return
          const sum = typeof H.extractAssistantTextFromApiResponse === 'function'
            ? H.extractAssistantTextFromApiResponse(data, { allowReasoning: false }).trim()
            : H.extractAssistantText(data?.choices?.[0]?.message ?? data?.choices?.[0] ?? data, { allowReasoning: false }).trim()
          if (!sum) return
          if (!Array.isArray(state.aiLong)) state.aiLong = []
          state.aiLong.push({ t: Date.now(), summary: sum })
          if (state.aiLong.length > 50) state.aiLong.splice(0, state.aiLong.length - 50)
          try { memory?.longTerm?.persistState?.() } catch {}
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
    if (!state.aiPulse || typeof state.aiPulse !== 'object') state.aiPulse = {}
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
    try { contextBus?.pushEvent?.('death_info', payloadText) } catch {}
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

  function parseWhisperToYou (plain) {
    const cleaned = stripMcFormatting(plain).trim()
    const m = cleaned.match(/^([A-Za-z0-9_]{1,16})\s+whispers to you:\s*(.+)$/i)
    if (!m) return null
    const name = String(m[1] || '').trim()
    const content = String(m[2] || '').trim()
    if (!name || !content) return null
    if (/^server$/i.test(name)) return null
    return { name, content }
  }

  function pulseKey (entry) {
    if (!entry) return ''
    const user = String(entry.user || '').trim().toLowerCase()
    const text = normalizePulseText(entry.text || '')
    if (!user && !text) return ''
    return `${user}#${text}`
  }

  function ensureSeenPlayerChats () {
    if (!state.aiPulse || typeof state.aiPulse !== 'object') state.aiPulse = {}
    if (!(state.aiPulse.seenPlayerChats instanceof Map)) state.aiPulse.seenPlayerChats = new Map()
    return state.aiPulse.seenPlayerChats
  }

  function playerChatKey (username, text) {
    const entry = { user: username, text }
    return pulseKey(entry)
  }

  function seenPlayerChatRecently (username, text, windowMs) {
    try {
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
    } catch {}
  }

  function sendDirectReply (username, text, opts = {}) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    try {
      bot.chat(trimmed)
      recordCommandDid(trimmed)
      if (!opts || opts.suppressRecord !== true) recordBotChat(trimmed, opts)
    } catch {}
    noteRecentReply(username)
    try {
      if (!state.aiPulse || typeof state.aiPulse !== 'object') state.aiPulse = {}
      state.aiPulse.lastReason = opts.reason || 'user_reply'
      state.aiPulse.lastFlushAt = now()
      state.aiPulse.lastMessageAt = now()
    } catch {}
  }

  function sendChatReply (username, text, opts = {}) {
    sendDirectReply(username, text, opts)
    activateSession(username, opts.reason || 'chat')
    touchConversationSession(username)
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

  function captureChat (username, message) {
    try {
      if (!username || username === bot.username) return
      const text = String(message || '').trim()
      if (!text) return
      if (handleDeathChestNotice(text, username)) return
      if (seenPlayerChatRecently(username, text, CHAT_EVENT_DEDUPE_MS)) return
      markPlayerChatSeen(username, text)
      pushRecentChatEntry(username, text, 'player')
    } catch {}
  }

  function captureSystemMessage (message) {
    try {
      const plain = extractPlainText(message).trim()
      if (!plain) return
      if (handleDeathChestNotice(plain)) return
      const whisperChat = parseWhisperToYou(plain)
      if (whisperChat) {
        const selfName = String(bot.username || '').trim()
        if (selfName && selfName.toLowerCase() === String(whisperChat.name).toLowerCase()) return
        if (seenPlayerChatRecently(whisperChat.name, whisperChat.content, PLAYER_CHAT_DEDUPE_MS)) return
        captureChat(whisperChat.name, whisperChat.content)
        return whisperChat
      }
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
          try { contextBus?.pushEvent?.('death', plain) } catch {}
        }
        const achievementPatterns = [' has made the advancement ', ' has completed the challenge ', ' has reached the goal ', ' completed the challenge ', ' advancement ']
        if (achievementPatterns.some(p => lower.includes(p))) {
          try { contextBus?.pushEvent?.('achievement', plain) } catch {}
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

  function stop () {
    for (const username of [...sayCtrlByUser.keys()]) cancelSay(username, 'cleanup')
    try { resetActiveSessions() } catch {}
    if (state.aiPulse?._timer) {
      try { clearInterval(state.aiPulse._timer) } catch {}
      state.aiPulse._timer = null
    }
  }

  startSessionCleanupTimer()

  return {
    stop,
    sendChatReply,
    sendDirectReply,
    say,
    cancelSay,
    activateSession,
    touchConversationSession,
    resetActiveSessions,
    captureChat,
    captureSystemMessage,
    isUserActive
  }
}

module.exports = { createPulseService }
