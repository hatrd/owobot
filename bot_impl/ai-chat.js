// AI chat dispatcher for in-game dialogue.
// Rule: if a player message starts with the dynamic trigger (first 3 alnum chars of bot name; fallback 'bot'), route it to the DeepSeek-compatible chat API
// and reply concisely. Per‑player short memory is kept across hot reloads via shared state.

const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const DEFAULT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const DEFAULT_PATH = process.env.DEEPSEEK_PATH || '/v1/chat/completions'
const DEFAULT_RECENT_COUNT = 32

const PULSE_MAX_MESSAGES = 20
const PULSE_INTERVAL_MS = 3 * 60 * 1000
const PULSE_CHECK_MS = 60 * 1000
const PULSE_RECENT_REPLY_SUPPRESS_MS = 2 * 60 * 1000
const PULSE_REPEAT_SUPPRESS_MS = 6 * 60 * 1000
const PULSE_PENDING_EXPIRE_MS = 5 * 60 * 1000
const ACTIVE_CHAT_WINDOW_MS = 60 * 1000
const ACTIVE_FOLLOW_DELAY_MS = 5 * 1000
const CONVERSATION_STORE_MAX = 60
const CONVERSATION_BUCKETS = [
  { maxDays: 3, limit: 4 },
  { maxDays: 7, limit: 6 },
  { maxDays: 15, limit: 8 },
  { maxDays: 30, limit: 10 }
]

const fs = require('fs')
const path = require('path')
const H = require('./ai-chat-helpers')
const actionsMod = require('./actions')
const observer = require('./agent/observer')
const memoryStore = require('./memory-store')
const { prepareAiState } = require('./ai-chat/state-init')
const { createAiCliHandler } = require('./ai-chat/cli')
const PROMPT_DIR = path.join(__dirname, 'prompts')

const MEMORY_REWRITE_RULES = [
  '1. 若请求安全且信息充分，status="ok"，必须返回 instruction（简洁中文指令）、triggers（字符串数组，如player:Ameyaku、keyword:金合欢）、summary（≤20字概括）、tags（字符串数组）、tone（可选）。',
  '2. 若内容不应记忆，status="reject"并给出 reason（中文）。',
  '3. 若信息不足需要玩家补充，status="clarify"并给出 question（中文）。',
  '4. status="ok" 时，如 payload.memory_context.position 存在或请求描述具体地点，必须附加 location 对象 {"x":int,"y":int?,"z":int,"radius":int?,"dim":string?}，坐标使用玩家提供或 context 中的值，半径默认 context.radius 或 50。',
  '5. status="ok" 时提供 feature（≤40字、snake_case 或简洁短语）描述该地点用途，若存在 location 且记忆描述的是可供访客使用、值得推荐或欢迎他人前往的地点/设施/资源，应输出 greet_suffix（≤40字）表达邀请或提示，除非玩家明确说明不要打招呼；仅规则、安全或纯信息类记忆才省略 greet_suffix。可选 kind（如world、player）。instruction 和 summary 应包含地点/用途信息。',
  '6. 如描述与已有长期记忆在 instruction、feature 或 location 上重合或冲突，应更新原有内容而非新增重复记忆。',
  '7. 输出必须是合法 JSON，不能包含额外文本、注释或Markdown。'
]

const MEMORY_REWRITE_SYSTEM_PROMPT = `你是Minecraft服务器机器人的记忆整理助手。根据玩家的请求，输出一个JSON对象描述应写入的长期记忆。规则：\n${MEMORY_REWRITE_RULES.join('\n')}`

function loadPrompt (filename, fallback) {
  try {
    const full = path.join(PROMPT_DIR, filename)
    const text = fs.readFileSync(full, 'utf8')
    if (text && text.trim()) return text
  } catch {}
  return fallback
}

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  const persistedMemory = memoryStore.load()
  prepareAiState(state, {
    defaults: { DEFAULT_MODEL, DEFAULT_BASE, DEFAULT_PATH, DEFAULT_RECENT_COUNT },
    persistedMemory,
    trimConversationStore,
    updateWorldMemoryZones,
    dayStart,
    monthStart
  })

  const ctrl = { busy: false, abort: null, pending: null }
  const PENDING_EXPIRE_MS = 8000
  function queuePending (username, message) {
    const text = String(message || '')
    if (!text) return
    ctrl.pending = { username, message: text, storedAt: now() }
  }
  function takePending () {
    const entry = ctrl.pending
    if (!entry) return null
    ctrl.pending = null
    if (entry.storedAt && (now() - entry.storedAt) > PENDING_EXPIRE_MS) return null
    return entry
  }
  const pulseCtrl = { running: false, abort: null }
  let pulseTimer = null
  const memoryCtrl = { running: false }

  function now () { return Date.now() }
  function trimWindow (arr, windowMs) { const t = now(); return arr.filter(ts => t - ts <= windowMs) }
  function statFor (username) {
    if (!state.aiStats.perUser.has(username)) state.aiStats.perUser.set(username, [])
    return state.aiStats.perUser.get(username)
  }

  function dayStart (t = now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  function monthStart (t = now()) { const d = new Date(t); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() }

  function rollSpendWindows () {
    const t = now()
    const d0 = dayStart(t)
    const m0 = monthStart(t)
    if (state.aiSpend.day.start !== d0) state.aiSpend.day = { start: d0, inTok: 0, outTok: 0, cost: 0 }
    if (state.aiSpend.month.start !== m0) state.aiSpend.month = { start: m0, inTok: 0, outTok: 0, cost: 0 }
  }

  const estTokensFromText = H.estTokensFromText

  function budgetRemaining () {
    rollSpendWindows()
    const { budgetDay, budgetMonth, budgetTotal } = state.ai
    const d = state.aiSpend.day.cost
    const m = state.aiSpend.month.cost
    const tot = state.aiSpend.total.cost
    return {
      day: budgetDay == null ? Infinity : Math.max(0, budgetDay - d),
      month: budgetMonth == null ? Infinity : Math.max(0, budgetMonth - m),
      total: budgetTotal == null ? Infinity : Math.max(0, budgetTotal - tot)
    }
  }

  function projectedCostForCall (promptTok, outTokMax) {
    const { priceInPerKT, priceOutPerKT } = state.ai
    return H.projectedCostForCall(priceInPerKT, priceOutPerKT, promptTok, outTokMax)
  }

  function canAfford (promptTok) {
    const rem = budgetRemaining()
    const maxOutTok = state.ai.maxTokensPerCall || 512
    const proj = projectedCostForCall(promptTok, maxOutTok)
    const ok = (rem.day >= proj) && (rem.month >= proj) && (rem.total >= proj)
    return { ok, proj, rem }
  }

  function applyUsage (inTok, outTok) {
    rollSpendWindows()
    const { priceInPerKT, priceOutPerKT } = state.ai
    const cost = (inTok / 1000) * (priceInPerKT || 0) + (outTok / 1000) * (priceOutPerKT || 0)
    state.aiSpend.day.inTok += inTok; state.aiSpend.day.outTok += outTok; state.aiSpend.day.cost += cost
    state.aiSpend.month.inTok += inTok; state.aiSpend.month.outTok += outTok; state.aiSpend.month.cost += cost
    state.aiSpend.total.inTok += inTok; state.aiSpend.total.outTok += outTok; state.aiSpend.total.cost += cost
  }

  function canProceed (username) {
    const L = state.ai.limits
    if (!L) return { ok: true }
    const t = now()
    const userArr = statFor(username)
    const globArr = state.aiStats.global
    // Cooldown check
    if (L.cooldownMs && userArr.length > 0) {
      const last = userArr[userArr.length - 1]
      if (t - last < L.cooldownMs) return { ok: false, reason: 'cooldown' }
    }
    // Per-user per-minute
    if (L.userPerMin != null) {
      const u1 = trimWindow(userArr, 60_000)
      if (u1.length >= L.userPerMin) return { ok: false, reason: 'userPerMin' }
    }
    // Per-user per-day
    if (L.userPerDay != null) {
      const uD = trimWindow(userArr, 86_400_000)
      if (uD.length >= L.userPerDay) return { ok: false, reason: 'userPerDay' }
    }
    // Global per-minute
    if (L.globalPerMin != null) {
      const g1 = trimWindow(globArr, 60_000)
      if (g1.length >= L.globalPerMin) return { ok: false, reason: 'globalPerMin' }
    }
    // Global per-day
    if (L.globalPerDay != null) {
      const gD = trimWindow(globArr, 86_400_000)
      if (gD.length >= L.globalPerDay) return { ok: false, reason: 'globalPerDay' }
    }
    return { ok: true }
  }

  function noteUsage (username) {
    const t = now()
    state.aiStats.global.push(t)
    const arr = statFor(username)
    arr.push(t)
    // GC arrays
    state.aiStats.global = trimWindow(state.aiStats.global, 86_400_000)
    const recent = trimWindow(arr, 86_400_000)
    state.aiStats.perUser.set(username, recent)
  }

  function traceChat (...args) {
    if (state.ai?.trace && log?.info) {
      try { log.info(...args) } catch {}
    }
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
        queueConversationSummary(name, info, 'expire')
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
      queueConversationSummary(username, entry, 'restart')
    }
    if (!continuing && (restart || !Number.isFinite(entry.startSeq))) {
      const baselineSeq = Number.isFinite(state.aiRecentSeq) ? state.aiRecentSeq : 0
      entry.startSeq = Math.max(0, baselineSeq - 1)
      entry.startedAt = nowTs
      entry.participants = entry.participants instanceof Set ? entry.participants : new Set()
      entry.participants.clear()
      if (username && username !== bot.username) entry.participants.add(username)
      entry.lastSeq = entry.startSeq
      entry.lastAt = entry.startedAt
    } else if (!(entry.participants instanceof Set)) {
      entry.participants = new Set()
      if (username && username !== bot.username) entry.participants.add(username)
    }
    entry.expiresAt = nowTs + ACTIVE_CHAT_WINDOW_MS
    entry.reason = reason || entry.reason || 'trigger'
    entry.awaiting = false
    sessions.set(username, entry)
  }

  function isUserActive (username) {
    if (!username) return false
    cleanupActiveSessions()
    return ensureActiveSessions().has(username)
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
      queueConversationSummary(name, info, 'reset')
      sessions.delete(name)
    }
  }

  function pushRecentChatEntry (username, text, kind = 'player') {
    const trimmed = String(text || '').trim()
    if (!trimmed) return null
    if (!Array.isArray(state.aiRecent)) state.aiRecent = []
    if (!Number.isFinite(state.aiRecentSeq)) state.aiRecentSeq = 0
    state.aiRecentSeq += 1
    const entry = { t: now(), user: username || '??', text: trimmed.slice(0, 160), kind, seq: state.aiRecentSeq }
    state.aiRecent.push(entry)
    enforceRecentLimit()
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
        const url = (state.ai.baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || DEFAULT_PATH)
        const body = { model: state.ai.model || DEFAULT_MODEL, messages, temperature: 0.2, max_tokens: 60, stream: false }
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.ai.key}` }, body: JSON.stringify(body) })
          if (!res.ok) return
          const data = await res.json()
          const sum = data?.choices?.[0]?.message?.content?.trim()
          if (!sum) return
          state.aiLong.push({ t: Date.now(), summary: sum })
          if (state.aiLong.length > 50) state.aiLong.splice(0, state.aiLong.length - 50)
          persistMemoryState()
          if (state.ai.trace && log?.info) log.info('long summary ->', sum)
        } catch {}
      } catch {}
    })()
  }

  function recordBotChat (text) {
    try {
      pushRecentChatEntry(bot?.username || 'bot', text, 'bot')
    } catch {}
  }

  function conversationParticipantsFromLines (lines) {
    const set = new Set()
    for (const line of lines) {
      const name = String(line?.user || '').trim()
      if (!name || name === bot.username) continue
      set.add(name)
    }
    return [...set]
  }

  async function runSummaryModel (messages, maxTokens = 60, temperature = 0.2) {
    const { key, model } = state.ai || {}
    if (!key) return null
    const url = (state.ai.baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || DEFAULT_PATH)
    const body = { model: model || DEFAULT_MODEL, messages, temperature, max_tokens: maxTokens, stream: false }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      })
      if (!res.ok) return null
      const data = await res.json()
      return data?.choices?.[0]?.message?.content?.trim() || null
    } catch { return null }
  }

  function fallbackConversationSummary (lines, participants) {
    const parts = participants.length ? participants.join('、') : '玩家们'
    const recent = lines.slice(-2).map(l => `${l.user}: ${l.text}`).join(' / ')
    return `${parts} 聊天：${recent.slice(0, 50)}`
  }

  async function summarizeConversationLines (lines, participants) {
    if (!lines.length) return ''
    const fallback = fallbackConversationSummary(lines, participants)
    const joined = lines.map(l => `${l.user}: ${l.text}`).join(' | ')
    const sys = '你是Minecraft服务器里的聊天总结助手。请用中文≤40字，概括玩家互动主题，提到参与者名字和关键行动/地点，不要编造。'
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: `玩家：${participants.join('、') || '未知'}\n聊天摘录（旧→新）：${joined}\n请输出一句总结。` }
    ]
    const summary = await runSummaryModel(messages, 80, 0.3)
    if (!summary) return fallback
    return summary.replace(/\s+/g, ' ').trim()
  }

  function queueConversationSummary (username, entry, reason) {
    try {
      if (!entry) return
      const startSeq = Number(entry.startSeq)
      const endSeq = Number(entry.lastSeq || state.aiRecentSeq)
      if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq) || endSeq <= startSeq) return
      const participants = entry.participants instanceof Set ? [...entry.participants] : []
      const payload = {
        id: `conv_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        username,
        participants,
        startSeq,
        endSeq,
        startedAt: entry.startedAt || now(),
        endedAt: entry.lastAt || now(),
        reason
      }
      processConversationSummary(payload).catch(err => traceChat('[chat] summary error', err?.message || err))
    } catch (e) {
      traceChat('[chat] summary queue error', e?.message || e)
    }
  }

  async function processConversationSummary (job) {
    try {
      const lines = (state.aiRecent || []).filter(line => Number(line?.seq) > job.startSeq && Number(line?.seq) <= job.endSeq)
      if (!lines.length) return
      const participants = job.participants && job.participants.length ? job.participants : conversationParticipantsFromLines(lines)
      if (!participants.length) participants.push(job.username || '玩家')
      const summary = await summarizeConversationLines(lines, participants)
      if (!summary) return
      const record = {
        id: job.id,
        participants: participants.map(p => String(p || '').trim()).filter(Boolean),
        summary,
        startedAt: job.startedAt || now(),
        endedAt: job.endedAt || now()
      }
      state.aiDialogues.push(record)
      trimConversationStore()
      persistMemoryState()
    } catch (e) {
      traceChat('[chat] process summary error', e?.message || e)
    }
  }

  function trimConversationStore () {
    if (!Array.isArray(state.aiDialogues)) state.aiDialogues = []
    if (state.aiDialogues.length <= CONVERSATION_STORE_MAX) return
    state.aiDialogues.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
    while (state.aiDialogues.length > CONVERSATION_STORE_MAX) state.aiDialogues.shift()
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

  function sendDirectReply (username, text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    try {
      bot.chat(trimmed)
      recordBotChat(trimmed)
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
    sendDirectReply(username, text)
    activateSession(username, opts.reason || 'chat')
    touchConversationSession(username)
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

  function maybeFlush (reason, options = {}) {
    try {
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
    if (!pulseEnabled()) {
      revert = false
      state.aiPulse.lastMessage = null
      return
    }
    const { key, baseUrl, path, model, maxReplyLen } = state.ai
    if (!key) {
      revert = false
      state.aiPulse.lastMessage = null
      return
    }
    const transcript = batch.entries.map(it => {
      const ts = it?.t ? new Date(it.t).toISOString().slice(11, 19) : ''
      return `${ts ? '[' + ts + '] ' : ''}${it.user || '??'}: ${it.text || ''}`
    }).join('\n')
    if (!transcript.trim()) {
      revert = false
      state.aiPulse.lastMessage = null
      return
    }
    const botName = bot?.username || 'bot'
    const instructions = loadPrompt('pulse-system.txt', [
      '你是Minecraft服务器里的友好机器人。',
      '阅读最近玩家的聊天摘录，判断是否需要你主动回应。如果需要回应，直接输出回应具体内容。',
      '目标：让所有玩家觉得可爱、有趣，并感到被关注，增强参与感。',
      '请用中文，口吻俏皮亲切、简短自然，像平时一起玩的伙伴。',
      '限制：单句或两句，总长度不超过60字；不要暴露这是自动总结。',
      '如果无需回应，请输出单词 SKIP。'
    ].join('\n')).replace(/\{\{BOT_NAME\}\}/g, botName)
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
    const estIn = estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (!afford.ok) {
      revert = false
      state.aiPulse.lastMessage = null
      if (log?.info) log.info('pulse skipped: budget exceeded')
      return
    }
    const url = (state.ai.baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || DEFAULT_PATH)
    const body = {
      model: model || DEFAULT_MODEL,
      messages,
      temperature: 0.5,
      max_tokens: Math.max(80, Math.min(180, state.ai.maxTokensPerCall || 200)),
      stream: false
    }
    pulseCtrl.running = true
    const ac = new AbortController()
    pulseCtrl.abort = ac
    const timeout = setTimeout(() => ac.abort('timeout'), state.ai?.limits?.pulseTimeoutMs || 20000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status))
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      const reply = data?.choices?.[0]?.message?.content || ''
      const trimmed = H.trimReply(reply, Math.min(maxReplyLen || 240, 200)).trim()
      const u = data?.usage || {}
      const inTok = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : estIn
      const outTok = Number.isFinite(u.completion_tokens) ? u.completion_tokens : estTokensFromText(reply)
      applyUsage(inTok, outTok)
      if (!trimmed || /^skip$/i.test(trimmed)) {
        state.aiPulse.lastMessage = null
        markPulseHandled(filteredBatch, nowTs)
        revert = false
        return
      }
      const lastMsg = state.aiPulse.lastMessage || ''
      const lastMsgAt = Number.isFinite(state.aiPulse.lastMessageAt) ? state.aiPulse.lastMessageAt : 0
      if (trimmed === lastMsg && nowTs - lastMsgAt < PULSE_REPEAT_SUPPRESS_MS) {
        state.aiPulse.lastMessageAt = nowTs
        markPulseHandled(filteredBatch, nowTs)
        revert = false
        return
      }
      state.aiPulse.lastMessage = trimmed
      state.aiPulse.lastMessageAt = nowTs
      markPulseHandled(filteredBatch, nowTs)
      revert = false
      if (log?.info) log.info('pulse reply ->', trimmed)
      try {
        bot.chat(trimmed)
        recordBotChat(trimmed)
      } catch (e) { if (log?.warn) log.warn('pulse chat error:', e?.message || e) }
      if (options.username && trigger === 'active') activateSession(options.username, 'pulse_followup')
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

  function onPulseCli (payload) {
    try {
      if (!payload || payload.cmd !== 'pulse') return
      const [sub, ...rest] = payload.args || []
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

  if (state.aiPulse._timer) {
    try { clearInterval(state.aiPulse._timer) } catch {}
    state.aiPulse._timer = null
  }
  pulseTimer = setInterval(() => { maybeFlush('timer') }, PULSE_CHECK_MS)
  state.aiPulse._timer = pulseTimer
  maybeFlush('timer')

  // no per-user memory helpers

  function systemPrompt () {
    const fallback = [
      '你是Minecraft服务器中的简洁助手。',
      '风格：中文、可爱、极简、单句。',
      '如需执行动作，可先说一句话，再单独输出一行：TOOL {"tool":"<名字>","args":{...}}；若无需动作，仅回复文本。',
      '可用工具: observe_detail{what,radius?,max?}, observe_players{names?,world?|dim?,armor_(lt|lte|gt|gte|eq)?,health_(lt|lte|gt|gte|eq)?,max?}, goto{x,y,z,range?}, goto_block{names?|name?|match?,radius?,range?,dig?}, defend_area{radius?,tickMs?,dig?}, defend_player{name,radius?,followRange?,tickMs?,dig?}, hunt_player{name,range?,durationMs?}, follow_player{name,range?}, reset{}, equip{name,dest?}, toss{items:[{name|slot,count?},...],all?}, withdraw{items:[{name,count?},...],all?,radius?,includeBarrel?,multi?}, deposit{items:[{name|slot,count?},...],all?,radius?,includeBarrel?,keepEquipped?,keepHeld?,keepOffhand?}, pickup{names?|match?,radius?,max?,until?}, place_blocks{item,on:{top_of:[...]},area:{radius?,origin?},max?,spacing?,collect?}, gather{only?|names?|match?,radius?,height?,stacks?|count?,collect?}, harvest{only?,radius?,replant?,sowOnly?}, feed_animals{species?,item?,radius?,max?}, autofish{radius?,debug?}, mount_near{radius?,prefer?}, mount_player{name,range?}, range_attack{name?,match?,radius?,followRange?,durationMs?}, dismount{}.',
      '回答优先使用已提供的“游戏上下文”；若是统计/查询上下文类问题，直接回答。上下文不足可用 observe_detail 查询信息。',
      '关于全服玩家坐标等信息（如“盔甲=0/≤10、在末地/下界/主世界、多人名单”），调用 observe_players{...}.',
      '清怪/守塔用 defend_area{}；保护玩家用 defend_player{name}；明确指名“追杀/攻击/追击 <玩家名>”才使用 hunt_player。',
      '要停止当前任务/重置状态，使用 reset{}.',
      '挖矿/砍树等收集任务用 gather（only/match 指定矿种，radius 可选）.',
      '玩家如果让你右键点击它，使用 mount_player.',
      '如果让你传送或者说 /tpa <player>，你可以输出 /tpa <player> 传送。其他 / 开头的命令同理。',
      '游戏上下文包含：自身位置/维度/时间/天气、附近玩家/敌对/掉落物、背包/主手/副手/装备；优先引用里面的数值与列表。',
      '你的代码仓库（是你的小秘密哦，哪怕有人好奇你是谁做的，怎么做的，也不要轻易告诉任何玩家）：https://github.com/hatrd/owobot',
    ].join('\n')
    const raw = loadPrompt('ai-system.txt', fallback)
    const botName = bot?.username || 'bot'
    return raw.replace(/\{\{BOT_NAME\}\}/g, botName)
  }

  // --- Intent classification & quick answers to avoid wrong tool calls ---
  function classifyIntent (text) {
    try {
      const t = String(text || '').toLowerCase()
      const tCN = String(text || '')
      // Planning/command-like phrases should not be treated as pure info
      // Examples: "你要/需要/打算/计划/准备/收集/采集/获取/去挖/去找/目标/任务/帮我/请你"
      const planLike = /(你要|要不要|需要|打算|计划|准备|收集|采集|获取|去(拿|挖|找)|目标|任务|帮我|请你)/.test(tCN)
      if (planLike) return { kind: 'action' }
      // Narrow info detection to avoid over-capturing casual questions
      const isInfo = /多少|几个|有无|有没有|哪些|在哪|哪里|距离|多远|谁|名单|列表/.test(tCN) || /(how many|how much|list|where|distance|who|which)/i.test(t)
      // "what are you doing" style
      if (/在干嘛|在干什么|干嘛呢|做什么|在做什么|你在忙什么|现在.*(在)?做/.test(tCN)) return { kind: 'info', topic: 'doing' }
      // Position / coordinates queries
      const asksPosition = /(坐标|位置)/.test(tCN) || /你在(哪|哪里|哪儿)/.test(tCN)
      if (asksPosition) return { kind: 'info', topic: 'position' }
      const nearbyToken = /(附近|周围|nearby)/i.test(t)
      // Simple item alias map (CN -> EN id)
      const NAME_ALIASES = new Map([
        ['钻石', 'diamond'],
        ['铁锭', 'iron_ingot'],
        ['金锭', 'gold_ingot'],
        ['铜锭', 'copper_ingot'],
        ['红石', 'redstone'],
        ['煤', 'coal'],
        ['青金石', 'lapis_lazuli'],
        ['绿宝石', 'emerald'],
        ['火把', 'torch'],
        ['木棍', 'stick']
      ])
      function extractItem (raw) {
        for (const [cn, en] of NAME_ALIASES) { if (raw.includes(cn)) return en }
        // fallback: simple english tokens
        const toks = ['diamond','iron_ingot','gold_ingot','copper_ingot','coal','redstone','lapis_lazuli','emerald','torch','stick']
        const low = raw.toLowerCase()
        for (const k of toks) { if (low.includes(k)) return k }
        return null
      }
      const item = extractItem(tCN)
      // Minerals bucket: when users ask about "矿/矿物/矿石" counts, treat as inventory mineral summary
      const asksMinerals = /(矿物|矿石|矿)/.test(tCN) && /(多少|几个|有多少|多少个)/.test(tCN)
      const bareHowMany = /^(有多少|多少)\s*[?？。!！]*$/u.test(tCN.trim())
      if (isInfo) {
        if (/背包|包里|inventory/.test(tCN)) return { kind: 'info', topic: 'inventory', item, list: !item }
        if (asksMinerals || bareHowMany) return { kind: 'info', topic: 'inventory', item: null, subset: 'minerals' }
        // Only treat as inventory count if phrased as possession ("有/带着/身上") rather than desire/plan
        if ((/(多少|几个)/.test(tCN) && item && /(有|带着|身上|背包|包里)/.test(tCN))) return { kind: 'info', topic: 'inventory', item }
        if (/敌对|怪|怪物|hostile|敌人/i.test(tCN)) return { kind: 'info', topic: 'hostiles', nearby: nearbyToken }
        if (/实体|entities?|entity/i.test(t)) return { kind: 'info', topic: 'entities', nearby: nearbyToken }
        if (/玩家|people|player/i.test(tCN)) {
          return { kind: 'info', topic: 'players', nearby: nearbyToken }
        }
        if (/掉落|物品|drops|items/i.test(tCN)) return { kind: 'info', topic: 'drops', nearby: nearbyToken }
        return { kind: 'info', topic: 'generic' }
      }
      return { kind: 'action' }
    } catch { return { kind: 'unknown' } }
  }

  function quickAnswer (intent, content) {
    try {
      if (!intent || intent.kind !== 'info') return ''
      const snap = observer.snapshot(bot, {})
      // Inventory count quick answer
      const cnMap = new Map([
        ['diamond', '钻石'],
        ['iron_ingot', '铁锭'],
        ['gold_ingot', '金锭'],
        ['copper_ingot', '铜锭'],
        ['coal', '煤'],
        ['redstone', '红石'],
        ['lapis_lazuli', '青金石'],
        ['emerald', '绿宝石'],
        ['torch', '火把'],
        ['stick', '木棍'],
        ['charcoal', '木炭'],
        ['netherite_scrap', '下界合金碎片'],
        ['raw_iron', '粗铁'],
        ['raw_gold', '粗金'],
        ['raw_copper', '粗铜']
      ])
      const toCN = (name) => cnMap.get(String(name || '').toLowerCase()) || String(name || '').replace(/_/g, ' ')

      if (intent.topic === 'inventory' && intent.item) {
        const name = String(intent.item).toLowerCase()
        let cnt = 0
        try { for (const it of (bot.inventory?.items() || [])) { if (String(it?.name || '').toLowerCase() === name) cnt += (it.count || 0) } } catch {}
        return `${toCN(intent.item)}x${cnt}`
      }
      // Inventory listing (e.g., 背包里都有什么)
      if (intent.topic === 'inventory' && !intent.item && intent.list) {
        const top = Array.isArray(snap?.inv?.top) ? snap.inv.top.slice(0, 8) : []
        if (!top.length) return '背包空空的~'
        const rows = top.map(it => `${toCN(it.name)}x${it.count}`)
        return '背包: ' + rows.join(', ')
      }
      // Minerals summary (e.g., 有多少矿/矿物/矿石)
      if (intent.topic === 'inventory' && !intent.item && intent.subset === 'minerals') {
        const want = ['diamond','iron_ingot','gold_ingot','copper_ingot','coal','redstone','lapis_lazuli','emerald','netherite_scrap']
        const raws = ['raw_iron','raw_gold','raw_copper']
        const bag = new Map()
        try { for (const it of (bot.inventory?.items() || [])) { const n = String(it?.name || '').toLowerCase(); bag.set(n, (bag.get(n) || 0) + (it.count || 0)) } } catch {}
        const parts = []
        for (const n of want) { const c = bag.get(n) || 0; if (c > 0) parts.push(`${toCN(n)}x${c}`) }
        // include raws if ingots are zero or to be thorough
        for (const n of raws) { const c = bag.get(n) || 0; if (c > 0) parts.push(`${toCN(n)}x${c}`) }
        return parts.length ? ('矿物: ' + parts.join(', ')) : '背包没有矿物~'
      }
      if (intent.topic === 'hostiles') {
        if (!intent.nearby) return ''
        const hs = snap.nearby?.hostiles || { count: 0, nearest: null }
        // 如果没有观测到但附近有玩家/夜间，尝试提示“可能正在加载”而不是直接否定
        if (!hs.count) {
          // trace: dump nearby entities to help diagnose
          if (state.ai.trace && log?.info) {
            try {
              const me = bot.entity?.position
              const rows = []
              for (const e of Object.values(bot.entities || {})) {
                try {
                  if (!e || !e.position) continue
                  const d = me ? e.position.distanceTo(me) : null
                  if (!Number.isFinite(d) || d > 24) continue
                  const nm = String(e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || e.kind || e.type || '').replace(/\u00a7./g, '')
                  rows.push({ id: e.id, type: e.type, kind: e.kind || null, name: nm, d: Number(d.toFixed(2)) })
                } catch {}
              }
              rows.sort((a, b) => a.d - b.d)
              log.info('entities(nearest 24m) =', rows.slice(0, 40))
            } catch {}
          }
          return '附近暂未发现敌对~'
        }
        return `附近有${hs.count}个敌对，最近${hs.nearest.name}@${Number(hs.nearest.d).toFixed(1)}m`
      }
      if (intent.topic === 'entities') {
        if (!intent.nearby) return ''
        try {
          const me = bot.entity?.position
          if (!me) return ''
          const radius = 16
          const list = []
          for (const e of Object.values(bot.entities || {})) {
            try {
              if (!e || !e.position || e === bot.entity) continue
              const d = e.position.distanceTo(me)
              if (!Number.isFinite(d) || d > radius) continue
              const nm = String(e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || e.kind || e.type || '').toLowerCase()
              list.push({ name: nm || 'entity', d })
            } catch {}
          }
          list.sort((a, b) => a.d - b.d)
          if (state.ai.trace && log?.info) {
            try {
              const me2 = bot.entity?.position
              const rows = []
              for (const e of Object.values(bot.entities || {})) {
                try {
                  if (!e || !e.position) continue
                  const d = me2 ? e.position.distanceTo(me2) : null
                  if (!Number.isFinite(d) || d > radius) continue
                  const nm = String(e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || e.kind || e.type || '').replace(/\u00a7./g, '')
                  rows.push({ id: e.id, type: e.type, kind: e.kind || null, name: nm, d: Number(d.toFixed(2)) })
                } catch {}
              }
              rows.sort((a, b) => a.d - b.d)
              log.info('entities(nearest 16m) =', rows.slice(0, 40))
            } catch {}
          }
          if (!list.length) return '附近没有实体~'
          const nearest = list[0]
          return `附近实体${list.length}个，最近${nearest.name}@${nearest.d.toFixed(1)}m`
        } catch { return '' }
      }
      if (intent.topic === 'players') {
        if (!intent.nearby) return '' // 非“附近”类查询交给 LLM + observe_players
        const npl = snap.nearby?.players || []
        return npl.length ? `附近玩家${npl.length}个：` + npl.map(x => `${x.name}@${Number(x.d).toFixed(1)}m`).join(', ') : '附近没有玩家~'
      }
      if (intent.topic === 'drops') {
        if (!intent.nearby) return ''
        const dr = snap.nearby?.drops || []
        return dr.length ? `附近掉落物${dr.length}个，最近${Number(dr[0].d).toFixed(1)}m` : '附近没有掉落物~'
      }
      if (intent.topic === 'generic') {
        const memoryAnswer = findLocationMemoryAnswer(content)
        if (memoryAnswer) return memoryAnswer
      }
      if (intent.topic === 'position') {
        const rawText = String(content || '')
        const safeTokens = (() => {
          const set = new Set(['我', '你', '妳', '您', '自己', '咱', '咱们', '我們', '我们', '咱家', '吾'])
          try {
            const uname = String(bot?.username || '').toLowerCase()
            if (uname) set.add(uname)
            const compact = uname.replace(/[^a-z0-9]/g, '')
            if (compact && compact !== uname) set.add(compact)
            const trig = triggerWord()
            if (trig) set.add(String(trig).toLowerCase())
          } catch {}
          return set
        })()
        try {
          const possMatches = [...rawText.matchAll(/([\p{L}\p{N}_-]{1,24})\s*的坐标/gu)]
          if (possMatches.length) {
            let targetOther = false
            for (const match of possMatches) {
              const tok = String(match[1] || '').trim().toLowerCase()
              if (!tok) continue
              if (!safeTokens.has(tok)) { targetOther = true; break }
            }
            if (targetOther) return ''
          }
        } catch {}
        const p = snap.pos
        if (!p) return ''
        const dim = snap.dim || 'overworld'
        return `坐标:${p.x},${p.y},${p.z} | 维度:${dim}`
      }
      if (intent.topic === 'doing') {
        const task = snap?.task?.name
        return task ? `在${task}呢~` : '闲着呢~'
      }
      // For generic info: only answer vitals if explicitly asked
      if (intent.topic === 'generic') {
        try {
          const last = String((state.aiRecent[state.aiRecent.length - 1]?.text) || '')
          const t = last.toLowerCase()
          const tCN = last
          const asksVitals = /(生命|血|血量|状态|饥饿|肚子|hp|health|hunger)/.test(tCN) || /(hp|health|hunger|status)/i.test(t)
          if (asksVitals) {
            const v = snap.vitals || {}
            const hp = v.hp != null ? Math.round(v.hp) : null
            const food = v.food != null ? v.food : null
            const parts = []
            if (hp != null) parts.push(`生命${hp}/20`)
            if (food != null) parts.push(`饥饿${food}/20`)
            return parts.length ? parts.join(' | ') : ''
          }
        } catch {}
        return ''
      }
      return ''
    } catch { return '' }
  }

  function trimReply (text, maxLen) {
    if (typeof text !== 'string') return ''
    const t = text.replace(/\s+/g, ' ').trim()
    if (t.length <= maxLen) return t
    return t.slice(0, Math.max(0, maxLen - 1)) + '…'
  }

  function triggerWord () {
    try {
      const raw = String(bot.username || '').match(/[a-z0-9]/gi)?.join('') || ''
      const pfx = raw.slice(0, 3).toLowerCase()
      return pfx || 'bot'
    } catch { return 'bot' }
  }

  function buildContextPrompt (username) {
    const ctx = state.ai.context || { include: true, recentCount: DEFAULT_RECENT_COUNT, recentWindowSec: 300 }
    const base = H.buildContextPrompt(username, state.aiRecent, { ...ctx, trigger: triggerWord() })
    const conv = buildConversationMemoryPrompt(username)
    return [base, conv].filter(Boolean).join('\n\n')
  }

  function relativeTimeLabel (ts) {
    if (!Number.isFinite(ts)) return '未知时间'
    const delta = now() - ts
    if (delta < 60 * 1000) return '刚刚'
    if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.round(delta / (60 * 1000)))}分钟前`
    if (delta < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(delta / (60 * 60 * 1000)))}小时前`
    const days = Math.max(1, Math.round(delta / (24 * 60 * 60 * 1000)))
    if (days < 7) return `${days}天前`
    const weeks = Math.max(1, Math.round(days / 7))
    return `${weeks}周前`
  }

  function selectDialoguesForContext (username) {
    if (!Array.isArray(state.aiDialogues) || !state.aiDialogues.length) return []
    const sorted = state.aiDialogues.slice().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    const prioritized = username ? sorted.filter(entry => Array.isArray(entry.participants) && entry.participants.includes(username)) : sorted
    const remaining = username ? sorted.filter(entry => !prioritized.includes(entry)) : []
    const combined = username ? prioritized.concat(remaining) : sorted
    const selected = []
    const used = new Set()
    const nowTs = now()
    for (const bucket of CONVERSATION_BUCKETS) {
      let count = 0
      for (const entry of combined) {
        if (!entry) continue
        const key = entry.id || `${entry.endedAt || 0}_${entry.summary || ''}`
        if (used.has(key)) continue
        const ageDays = Number.isFinite(entry.endedAt) ? (nowTs - entry.endedAt) / (24 * 60 * 60 * 1000) : Infinity
        if (!Number.isFinite(ageDays) || ageDays > bucket.maxDays) continue
        selected.push(entry)
        used.add(key)
        count++
        if (count >= bucket.limit) break
      }
    }
    return selected
  }

  function buildConversationMemoryPrompt (username) {
    const entries = selectDialoguesForContext(username)
    if (!entries.length) return ''
    const lines = entries.map((entry, idx) => {
      const label = relativeTimeLabel(entry.endedAt)
      const people = (entry.participants || []).join('、') || '玩家们'
      return `${idx + 1}. ${label} ${people}: ${entry.summary}`
    })
    return `对话记忆：\n${lines.join('\n')}`
  }

  function normalizeMemoryText (text) {
    if (typeof text !== 'string') return ''
    try { return text.normalize('NFKC').replace(/\s+/g, ' ').trim() } catch { return text.replace(/\s+/g, ' ').trim() }
  }

  function delay (ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0))) }

  function extractJsonLoose (raw) {
    if (!raw) return null
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence && fence[1]) return fence[1].trim()
    let depth = 0
    let inString = false
    let start = -1
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (ch === '"' && raw[i - 1] !== '\\') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') {
        if (depth === 0) start = i
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0 && start !== -1) return raw.slice(start, i + 1)
      }
    }
    return null
  }

  function uniqueStrings (arr) {
    if (!Array.isArray(arr)) return []
    const out = []
    const seen = new Set()
    for (const item of arr) {
      const v = normalizeMemoryText(item)
      if (!v) continue
      if (seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
    return out
  }

  function normalizeLocationValue (value) {
    if (!value || typeof value !== 'object') return null
    const src = (typeof value.position === 'object' && value.position) ? value.position : value
    const toNumber = (raw) => {
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }
    const x = toNumber(src.x)
    const z = toNumber(src.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    const out = {
      x: Math.round(x),
      z: Math.round(z)
    }
    const y = toNumber(src.y)
    if (Number.isFinite(y)) out.y = Math.round(y)
    const radiusRaw = value.radius ?? src.radius
    const radius = toNumber(radiusRaw)
    if (Number.isFinite(radius) && radius > 0) out.radius = Math.max(1, Math.round(radius))
    const dimRaw = value.dim || value.dimension || value.world || src.dim || src.dimension
    if (typeof dimRaw === 'string' && dimRaw.trim()) {
      const dimNorm = normalizeMemoryText(dimRaw)
      if (dimNorm) out.dim = dimNorm.toLowerCase()
    }
    return out
  }

  function locationLabel (loc) {
    if (!loc || typeof loc !== 'object') return ''
    const { x, y, z } = loc
    if (!Number.isFinite(x) || !Number.isFinite(z)) return ''
    if (Number.isFinite(y)) return `${x},${y},${z}`
    return `${x},${z}`
  }

  function ensureMemoryEntries () {
    if (!state.aiMemory || typeof state.aiMemory !== 'object') state.aiMemory = { entries: [] }
    if (!Array.isArray(state.aiMemory.entries)) state.aiMemory.entries = []
    const arr = state.aiMemory.entries
    const nowTs = now()
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      if (!item || typeof item !== 'object') {
        arr.splice(i, 1)
        i--
        continue
      }
      if (typeof item.text === 'string') item.text = normalizeMemoryText(item.text)
      if (!item.text) {
        arr.splice(i, 1)
        i--
        continue
      }
      if (!Number.isFinite(item.count) || item.count <= 0) item.count = 1
      if (!Number.isFinite(item.createdAt)) item.createdAt = nowTs
      if (!Number.isFinite(item.updatedAt)) item.updatedAt = item.createdAt
      if (!Array.isArray(item.triggers)) item.triggers = uniqueStrings(item.triggers ? [item.triggers].flat() : [])
      else item.triggers = uniqueStrings(item.triggers)
      if (!Array.isArray(item.tags)) item.tags = uniqueStrings(item.tags)
      if (item.summary) item.summary = normalizeMemoryText(item.summary)
      if (item.tone) item.tone = normalizeMemoryText(item.tone)
      if (item.instruction) item.instruction = normalizeMemoryText(item.instruction)
      if (!item.instruction) item.instruction = item.text
      item.fromAI = item.fromAI !== false
      if (item.location) {
        const loc = normalizeLocationValue(item.location)
        if (loc) item.location = loc
        else delete item.location
      }
      if (item.feature) {
        const feat = normalizeMemoryText(item.feature).slice(0, 48)
        item.feature = feat
      }
      if (item.greetSuffix) {
        item.greetSuffix = normalizeMemoryText(item.greetSuffix).slice(0, 80)
      }
      if (item.kind) {
        item.kind = normalizeMemoryText(item.kind)
      }
    }
    return arr
  }

  function normalizeFeature (value) {
    if (typeof value !== 'string') return ''
    return normalizeMemoryText(value).slice(0, 48)
  }

  function normalizedSummaryText (value) {
    if (typeof value !== 'string') return ''
    return normalizeMemoryText(value)
  }

  function locationMatches (existing, incoming) {
    if (!existing || !incoming) return false
    const ex = Number(existing.x)
    const ez = Number(existing.z)
    const ix = Number(incoming.x)
    const iz = Number(incoming.z)
    if (!Number.isFinite(ex) || !Number.isFinite(ez) || !Number.isFinite(ix) || !Number.isFinite(iz)) return false
    const dimA = typeof existing.dim === 'string' ? existing.dim.toLowerCase() : null
    const dimB = typeof incoming.dim === 'string' ? incoming.dim.toLowerCase() : null
    if (dimA && dimB && dimA !== dimB) return false
    const dx = ex - ix
    const dz = ez - iz
    const distSq = dx * dx + dz * dz
    const ra = Number.isFinite(existing.radius) ? existing.radius : 16
    const rb = Number.isFinite(incoming.radius) ? incoming.radius : 16
    const thresh = Math.max(4, Math.min(64, Math.max(ra, rb)))
    return distSq <= (thresh * thresh)
  }

  function findExistingMemoryEntry (entries, normalizedText, extra) {
    if (!Array.isArray(entries) || entries.length === 0) return null
    const instructNorm = normalizedText
    const featureNorm = normalizeFeature(extra?.feature)
    const summaryNorm = normalizedSummaryText(extra?.summary)
    const locationNorm = extra?.location ? normalizeLocationValue(extra.location) : null
    let match = entries.find(e => normalizeMemoryText(e?.instruction || e?.text) === instructNorm)
    if (match) return match
    if (!match && featureNorm) {
      match = entries.find(e => normalizeFeature(e?.feature) === featureNorm)
      if (match) return match
    }
    if (!match && locationNorm) {
      match = entries.find(e => locationMatches(e?.location, locationNorm))
      if (match) return match
    }
    if (!match && summaryNorm) {
      match = entries.find(e => normalizedSummaryText(e?.summary || e?.text) === summaryNorm)
    }
    return match || null
  }

  function buildWorldMemoryZones () {
    const entries = ensureMemoryEntries()
    const zones = []
    for (const entry of entries) {
      const loc = entry && entry.location
      if (!loc || !Number.isFinite(loc.x) || !Number.isFinite(loc.z)) continue
      const radius = Number.isFinite(loc.radius) && loc.radius > 0 ? loc.radius : 50
      const suffix = (() => {
        if (typeof entry.greetSuffix !== 'string') return ''
        const norm = normalizeMemoryText(entry.greetSuffix)
        return norm.slice(0, 80)
      })()
      if (!suffix) continue
      const zone = {
        name: (() => {
          if (typeof entry.feature === 'string' && entry.feature.trim()) return normalizeMemoryText(entry.feature)
          if (typeof entry.summary === 'string' && entry.summary.trim()) return normalizeMemoryText(entry.summary)
          return `memory-${entry.createdAt || Date.now()}`
        })(),
        x: Math.round(loc.x),
        y: Number.isFinite(loc.y) ? Math.round(loc.y) : 64,
        z: Math.round(loc.z),
        radius: Math.max(1, Math.round(radius)),
        suffix,
        enabled: true,
        source: 'memory'
      }
      if (loc.dim) zone.dim = loc.dim
      if (typeof entry.instruction === 'string' && entry.instruction.trim()) zone.memoryInstruction = normalizeMemoryText(entry.instruction)
      zones.push(zone)
    }
    return zones
  }

  function updateWorldMemoryZones () {
    try {
      const zones = buildWorldMemoryZones()
      if (!Array.isArray(state.worldMemoryZones)) state.worldMemoryZones = []
      state.worldMemoryZones = zones
    } catch (err) {
      log?.warn && log.warn('world memory zone update error:', err?.message || err)
    }
  }

  function memoryStoreLimit () {
    const cfg = state.ai.context?.memory
    const limit = cfg?.storeMax
    if (Number.isFinite(limit) && limit > 0) return limit
    if (Number.isFinite(state.aiMemory?.storeMax) && state.aiMemory.storeMax > 0) return state.aiMemory.storeMax
    return 200
  }

  function persistMemoryState () {
    try {
      const payload = {
        long: Array.isArray(state.aiLong) ? state.aiLong : [],
        memories: ensureMemoryEntries(),
        dialogues: Array.isArray(state.aiDialogues) ? state.aiDialogues : []
      }
      memoryStore.save(payload)
    } catch {}
  }

  function pruneMemories () {
    const entries = ensureMemoryEntries()
    const limit = memoryStoreLimit()
    if (entries.length <= limit) return
    entries
      .sort((a, b) => {
        const cb = (a?.count || 1) - (b?.count || 1)
        if (cb !== 0) return cb
        return (a?.updatedAt || a?.createdAt || 0) - (b?.updatedAt || b?.createdAt || 0)
      })
    while (entries.length > limit) entries.shift()
  }

  function addMemoryEntry ({ text, author, source, importance, extra } = {}) {
    const entries = ensureMemoryEntries()
    const normalized = normalizeMemoryText(text)
    if (!normalized) return { ok: false, reason: 'empty' }
    const nowTs = now()
    const boost = Number.isFinite(importance) ? Math.max(1, Math.floor(importance)) : 1
    let entry = findExistingMemoryEntry(entries, normalized, extra)
    if (entry) {
      entry.count = Math.max(1, (entry.count || 1) + boost)
      entry.updatedAt = nowTs
      if (author) entry.lastAuthor = author
      if (source) entry.lastSource = source
      if (extra) {
        if (extra.summary) entry.summary = normalizeMemoryText(extra.summary)
        if (extra.instruction) {
          entry.instruction = normalizeMemoryText(extra.instruction)
          entry.text = entry.instruction
        } else {
          entry.text = normalized
          entry.instruction = normalized
        }
        if (Array.isArray(extra.triggers)) {
          entry.triggers = uniqueStrings((entry.triggers || []).concat(extra.triggers))
        }
        if (Array.isArray(extra.tags)) {
          entry.tags = uniqueStrings((entry.tags || []).concat(extra.tags))
        }
        if (extra.tone) entry.tone = normalizeMemoryText(extra.tone)
        entry.fromAI = extra.fromAI !== false
        if (extra.location) {
          const loc = normalizeLocationValue(extra.location)
          if (loc) entry.location = loc
        }
        if (extra.feature) {
          const feat = normalizeMemoryText(extra.feature).slice(0, 48)
          if (feat) entry.feature = feat
        }
        if (extra.greetSuffix) {
          const suffix = normalizeMemoryText(extra.greetSuffix).slice(0, 80)
          if (suffix) entry.greetSuffix = suffix
        }
        if (extra.kind) {
          const kind = normalizeMemoryText(extra.kind)
          if (kind) entry.kind = kind
        }
      }
    } else {
      entry = {
        text: normalized,
        count: Math.max(1, boost),
        createdAt: nowTs,
        updatedAt: nowTs,
        firstAuthor: author || null,
        lastAuthor: author || null,
        lastSource: source || null,
        instruction: normalized,
        triggers: uniqueStrings(extra?.triggers || []),
        tags: uniqueStrings(extra?.tags || []),
        summary: extra?.summary ? normalizeMemoryText(extra.summary) : '',
        tone: extra?.tone ? normalizeMemoryText(extra.tone) : '',
        fromAI: extra?.fromAI !== false
      }
      if (extra?.instruction) {
        entry.instruction = normalizeMemoryText(extra.instruction)
        entry.text = entry.instruction
      }
      if (extra?.location) {
        const loc = normalizeLocationValue(extra.location)
        if (loc) entry.location = loc
      }
      if (extra?.feature) {
        const feat = normalizeMemoryText(extra.feature).slice(0, 48)
        if (feat) entry.feature = feat
      }
      if (extra?.greetSuffix) {
        const suffix = normalizeMemoryText(extra.greetSuffix).slice(0, 80)
        if (suffix) entry.greetSuffix = suffix
      }
      if (extra?.kind) {
        const kind = normalizeMemoryText(extra.kind)
        if (kind) entry.kind = kind
      }
      if (!entry.summary) entry.summary = ''
      entries.push(entry)
    }
    pruneMemories()
    persistMemoryState()
    updateWorldMemoryZones()
    return { ok: true, entry }
  }

  function topMemories (limit) {
    const entries = ensureMemoryEntries()
    if (!entries.length) return []
    const top = entries.slice().sort((a, b) => {
      const bc = (b?.count || 1) - (a?.count || 1)
      if (bc !== 0) return bc
      return (b?.updatedAt || b?.createdAt || 0) - (a?.updatedAt || a?.createdAt || 0)
    })
    if (!Number.isFinite(limit) || limit <= 0) return top
    return top.slice(0, limit)
  }

  function recentChatSnippet (count = 5) {
    const lines = (state.aiRecent || []).slice(-Math.max(1, count))
    return lines.map(r => ({ user: r.user, text: r.text })).filter(Boolean)
  }

  async function invokeMemoryRewrite (job) {
    const { key, baseUrl, path, model } = state.ai || {}
    if (!key) return { status: 'error', reason: 'no_key' }
    const url = (baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (path || DEFAULT_PATH)
    const payload = {
      job_id: job.id,
      player: job.player,
      request: job.text,
      original_message: job.original,
      recent_chat: job.recent,
      memory_context: job.context || null,
      existing_triggers: ensureMemoryEntries().map(it => ({ instruction: it.instruction || it.text, triggers: it.triggers || [] })).slice(-10)
    }
    const messages = [
      { role: 'system', content: MEMORY_REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) }
    ]
    const body = {
      model: model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 220,
      stream: false
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => String(res.status))
        return { status: 'error', reason: `HTTP ${res.status}: ${txt.slice(0, 120)}` }
      }
      const data = await res.json()
      const reply = data?.choices?.[0]?.message?.content || ''
      const jsonRaw = extractJsonLoose(reply)
      if (!jsonRaw) return { status: 'error', reason: 'no_json' }
      let parsed = null
      try { parsed = JSON.parse(jsonRaw) } catch (e) { return { status: 'error', reason: 'invalid_json', detail: e?.message } }
      return parsed
    } catch (e) {
      return { status: 'error', reason: e?.message || e }
    }
  }

  async function processMemoryQueue () {
    if (memoryCtrl.running) return
    if (!Array.isArray(state.aiMemory.queue) || !state.aiMemory.queue.length) return
    if (!state.ai?.key) return
    memoryCtrl.running = true
    try {
      while (Array.isArray(state.aiMemory.queue) && state.aiMemory.queue.length) {
        const job = state.aiMemory.queue.shift()
        if (!job) continue
        job.attempts = (job.attempts || 0) + 1
        const result = await invokeMemoryRewrite(job)
        const status = result && result.status ? String(result.status).toLowerCase() : null
        if (!result || status === 'error' || !status) {
          if (job.attempts < 3) {
            state.aiMemory.queue.push(job)
            await delay(200)
          } else {
            try { sendDirectReply(job.player, '我没能整理好这条记忆，下次再试试~') } catch {}
          }
          continue
        }
        if (status === 'reject') {
          const reason = normalizeMemoryText(result.reason || '')
          sendDirectReply(job.player, reason ? `这句记不住：${reason}` : '这句记不住喵~')
          continue
        }
        if (status === 'clarify') {
          const q = normalizeMemoryText(result.question || '')
          sendDirectReply(job.player, q || '要不要再多给我一点提示呀？')
          continue
        }
        if (status === 'ok') {
          const instruction = normalizeMemoryText(result.instruction || '')
          if (!instruction) {
            sendDirectReply(job.player, '这句话有点复杂，先不记啦~')
            continue
          }
          const triggers = uniqueStrings(result.triggers || [])
          const tags = uniqueStrings(result.tags || [])
          const summary = result.summary ? normalizeMemoryText(result.summary) : ''
          const tone = result.tone ? normalizeMemoryText(result.tone) : ''
          let location = normalizeLocationValue(result.location || result.loc || null)
          if (!location && job.context && job.context.position) {
            const hint = {
              x: job.context.position.x,
              y: job.context.position.y,
              z: job.context.position.z,
              radius: job.context.radius,
              dim: job.context.dimension
            }
            location = normalizeLocationValue(hint) || location
          }
          const featureRaw = result.feature || result.feature_name || null
          const greetRaw = result.greet_suffix || result.greetSuffix || null
          const kindRaw = result.kind || null
          const extra = { instruction, triggers, tags, summary, tone, fromAI: true }
          if (location) extra.location = location
          if (typeof featureRaw === 'string' && featureRaw.trim()) extra.feature = featureRaw
          if (typeof greetRaw === 'string' && greetRaw.trim()) extra.greetSuffix = greetRaw
          if (typeof kindRaw === 'string' && kindRaw.trim()) extra.kind = kindRaw
          addMemoryEntry({
            text: instruction,
            author: job.player,
            source: job.source || 'player',
            importance: 1,
            extra
          })
          const confirm = summary || (location ? `记住啦（${locationLabel(location)}）` : '记住啦~')
          sendDirectReply(job.player, confirm)
          continue
        }
        // unknown status
        sendDirectReply(job.player, '这句我还没想明白，下次再试试~')
      }
    } catch (e) {
      log?.warn && log.warn('memory queue error:', e?.message || e)
    } finally {
      memoryCtrl.running = false
    }
  }

  function enqueueMemoryJob (job) {
    if (!job) return
    if (!Array.isArray(state.aiMemory.queue)) state.aiMemory.queue = []
    state.aiMemory.queue.push(job)
    processMemoryQueue().catch(() => {})
  }

  function buildMemoryContext () {
    const cfg = state.ai.context?.memory
    if (cfg && cfg.include === false) return ''
    const limit = cfg?.max || 6
    const top = topMemories(Math.max(1, limit))
    if (!top.length) return ''
    const parts = top.map((m, idx) => memoryLineWithMeta(m, idx))
    return `长期记忆: ${parts.join(' | ')}`
  }

  function memoryLineWithMeta (entry, idx) {
    const baseText = normalizeMemoryText(entry.summary || entry.text)
    const meta = []
    if (entry.location) {
      const locLabel = locationLabel(entry.location)
      if (locLabel) {
        const dim = entry.location.dim ? String(entry.location.dim).replace(/^minecraft:/, '') : null
        const radius = Number.isFinite(entry.location.radius) ? `r${entry.location.radius}` : null
        const pieces = [locLabel, radius, dim].filter(Boolean)
        if (pieces.length) meta.push(pieces.join(' '))
      }
    }
    if (entry.feature) {
      const feat = normalizeMemoryText(entry.feature).slice(0, 40)
      if (feat) meta.push(feat)
    }
    const signed = entry.lastAuthor || entry.firstAuthor
    const parts = [`${idx + 1}. ${baseText}`]
    if (meta.length) parts[0] += `【${meta.join(' | ')}】`
    if (signed) parts[0] += `（${signed}）`
    return parts[0]
  }

  function formatLocationEntry (entry) {
    if (!entry || !entry.location) return null
    const label = locationLabel(entry.location)
    if (!label) return null
    const dim = entry.location.dim ? String(entry.location.dim).replace(/^minecraft:/, '') : null
    const radius = Number.isFinite(entry.location.radius) ? entry.location.radius : null
    const feature = entry.feature ? normalizeMemoryText(entry.feature) : ''
    const summary = entry.summary ? normalizeMemoryText(entry.summary) : normalizeMemoryText(entry.text)
    const parts = [`${summary}`]
    const locParts = [`坐标 ${label}`]
    if (radius) locParts.push(`半径 ${radius}`)
    if (dim) locParts.push(dim)
    parts.push(locParts.join('，'))
    if (feature) parts.push(feature)
    return parts.join('；')
  }

  function findLocationMemoryAnswer (question) {
    if (!question) return null
    const ask = normalizeMemoryText(question)
    if (!ask) return null
    if (!/(在哪|哪儿|哪里|位置|坐标)/.test(ask)) return null
    const stop = new Set(['在哪', '哪里', '哪儿', '位置', '坐标', '你', '我', '那里'])
    const tokens = Array.from(new Set(ask.split(/[\s,，。!?！?]/g).map(t => t.trim()).filter(t => t.length >= 2 && !stop.has(t))))
    const entries = ensureMemoryEntries().filter(e => e && e.location)
    if (!entries.length) return null
    let best = null
    for (const entry of entries) {
      const haystack = [
        normalizeMemoryText(entry.summary || ''),
        normalizeMemoryText(entry.text || ''),
        normalizeMemoryText(entry.feature || '')
      ].join(' ')
      if (!haystack) continue
      if (tokens.length === 0) {
        best = entry
        break
      }
      if (tokens.every(tok => haystack.includes(tok))) {
        best = entry
        break
      }
      if (!best && tokens.some(tok => haystack.includes(tok))) {
        best = entry
      }
    }
    if (!best) return null
    const formatted = formatLocationEntry(best)
    return formatted || null
  }

  function extractMemoryCommand (content) {
    if (!content) return null
    const text = String(content).trim()
    if (!text) return null
    const patterns = [
      /^记住(?:一下)?[:：,，\s]*(.+)$/i,
      /^(?:帮我|请|要)记住[:：,，\s]*(.+)$/i,
      /^记得[:：,，\s]*(.+)$/i,
      /^记一下[:：,，\s]*(.+)$/i,
      /^帮我记[:：,，\s]*(.+)$/i
    ]
    for (const re of patterns) {
      const m = text.match(re)
      if (m && m[1]) {
        const payload = normalizeMemoryText(m[1])
        if (payload) return payload
      }
    }
    return null
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

  function handleSystemMessage (message) {
    try {
      const plain = extractPlainText(message).trim()
      if (!plain) return
      const lower = plain.toLowerCase()
      const selfName = String(bot.username || '')
      if (!selfName) return
      const selfLower = selfName.toLowerCase()
      const isSelf = lower.includes(selfLower)
      if (isSelf) {
        const deathPatterns = [' was slain ', ' was shot ', ' was blown up ', ' was killed ', ' was pricked ', ' hit the ground ', ' fell ', ' drowned', ' burned', ' blew up', ' suffocated', ' starved', ' tried to swim', ' died', ' went up in flames', ' experienced kinetic energy', ' was doomed to fall']
        if (deathPatterns.some(p => lower.includes(p))) recordEvent('death', plain)
        const achievementPatterns = [' has made the advancement ', ' has completed the challenge ', ' has reached the goal ', ' completed the challenge ', ' advancement '] // advancement fallback
        if (achievementPatterns.some(p => lower.includes(p))) recordEvent('achievement', plain)
      }
      if (lower.startsWith('[deathchest]') && lower.includes('deathchest')) recordEvent('death_info', plain)
    } catch {}
  }

  // --- Game context via observer ---
  function buildGameContext () {
    try {
      const g = state.ai.context?.game
      if (!g || g.include === false) return ''
      const snap = observer.snapshot(bot, {
        invTop: g.invTop || 20,
        nearPlayerRange: g.nearPlayerRange || 16,
        nearPlayerMax: g.nearPlayerMax || 5,
        dropsRange: g.dropsRange || 8,
        dropsMax: g.dropsMax || 6,
        hostileRange: 24
      })
      return observer.toPrompt(snap)
    } catch { return '' }
  }
  function selectMemory (username, budgetTok) {
    return H.selectMemory(getMemory(username), budgetTok)
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

  async function callAI (username, content, intent, options = {}) {
    const { key, baseUrl, path, model, maxReplyLen } = state.ai
    if (!key) throw new Error('AI key not configured')
    const url = (baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (path || DEFAULT_PATH)

    // Build messages with per-user memory (short context)
    // Build context from global recent chat and game state
    const contextPrompt = buildContextPrompt(username)
    const gameCtx = buildGameContext()
    const extrasCtx = buildExtrasContext()
    const memoryCtx = buildMemoryContext()
    const allowSkip = options?.allowSkip === true
    const userContent = allowSkip ? `${content}\n\n（如果暂时不需要回复，请只输出单词 SKIP。）` : content
    const messages = [
      { role: 'system', content: systemPrompt() },
      extrasCtx ? { role: 'system', content: extrasCtx } : null,
      gameCtx ? { role: 'system', content: gameCtx } : null,
      memoryCtx ? { role: 'system', content: memoryCtx } : null,
      { role: 'system', content: contextPrompt },
      { role: 'user', content: userContent }
    ].filter(Boolean)

    // Optional trace of contexts
    if (state.ai.trace && log?.info) {
      try {
        log.info('gameCtx ->', buildGameContext())
        log.info('chatCtx ->', buildContextPrompt(username))
        log.info('memoryCtx ->', buildMemoryContext())
      } catch {}
    }

    // Pre-check against budget using a rough input token estimate
    const estIn = estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (state.ai.trace && log?.info) log.info('precheck inTok~=', estIn, 'projCost~=', (afford.proj||0).toFixed(4), 'rem=', afford.rem)
    if (!afford.ok) {
      const msg = state.ai.notifyOnBudget ? 'AI余额不足，稍后再试~' : ''
      throw new Error(msg || 'budget_exceeded')
    }

    const body = {
      model: model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: Math.max(120, Math.min(512, state.ai.maxTokensPerCall || 256)),
      stream: false
    }

    const ac = new AbortController()
    ctrl.abort = ac
    const timeout = setTimeout(() => ac.abort('timeout'), 12000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status))
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      const reply = data?.choices?.[0]?.message?.content || ''
      function extractJsonObject (raw) {
        if (!raw) return null
        let i = 0
        while (i < raw.length && /\s/.test(raw[i])) i++
        if (raw[i] !== '{') return null
        let depth = 0
        let inString = false
        let prev = ''
        for (let j = i; j < raw.length; j++) {
          const ch = raw[j]
          if (inString) {
            if (ch === '"' && prev !== '\\') inString = false
          } else {
            if (ch === '"') {
              inString = true
            } else if (ch === '{') {
              depth++
            } else if (ch === '}') {
              depth--
              if (depth === 0) return raw.slice(i, j + 1)
            }
          }
          prev = ch
        }
        return null
      }
      // Tool-call protocol: reply may contain text then a TOOL {...} block
      const toolMatch = /\bTOOL\b/.exec(reply)
      if (toolMatch) {
        const beforeTool = reply.slice(0, toolMatch.index)
        const afterToolRaw = reply.slice(toolMatch.index + toolMatch[0].length)
        const jsonStr = extractJsonObject(afterToolRaw)
        if (!jsonStr) {
          return H.trimReply(beforeTool || reply, maxReplyLen || 120)
        }
        const speech = beforeTool ? H.trimReply(beforeTool, maxReplyLen || 120) : ''
        let payload = null
        try { payload = JSON.parse(jsonStr) } catch {}
        if (payload && payload.tool) {
          const toolName = String(payload.tool)
          if (toolName === 'write_memory') {
            if (speech) sendChatReply(username, speech)
            const normalized = normalizeMemoryText(payload.args?.text || '')
            if (!normalized) {
              return H.trimReply('没听懂要记什么呢~', maxReplyLen || 120)
            }
            const importanceRaw = Number(payload.args?.importance)
            const importance = Number.isFinite(importanceRaw) ? importanceRaw : 1
            const author = payload.args?.author ? String(payload.args.author) : username
            const source = payload.args?.source ? String(payload.args.source) : 'ai'
            const added = addMemoryEntry({ text: normalized, author, source, importance })
            if (state.ai.trace && log?.info) log.info('tool write_memory ->', { text: normalized, author, source, importance, ok: added.ok })
            if (!added.ok) return H.trimReply('记忆没有保存下来~', maxReplyLen || 120)
            return speech ? '' : H.trimReply('记住啦~', maxReplyLen || 120)
          }
          // Heuristic arg completion for some tools
          try {
            if (String(payload.tool) === 'mount_player') {
              const a = payload.args || {}
              const raw = String(content || '')
              const meTokens = /(\bme\b|我)/i
              if (!a.name || meTokens.test(raw)) {
                a.name = username
                payload.args = a
              }
            }
          } catch {}
          const tools = actionsMod.install(bot, { log })
          // Enforce an allowlist to avoid exposing unsupported/ambiguous tools
          const allow = new Set(['hunt_player','defend_area','defend_player','follow_player','goto','goto_block','reset','equip','toss','pickup','gather','harvest','feed_animals','place_blocks','light_area','deposit','withdraw','autofish','mount_near','mount_player','range_attack','dismount','observe_detail','observe_players','sort_chests'])
          // If the intent is informational, disallow world-changing tools; allow info-only tools
          if (intent && intent.kind === 'info' && !['observe_detail','observe_players','say'].includes(String(payload.tool))) {
            return H.trimReply('我这就看看…', maxReplyLen || 120)
          }
          // Prefer mount over follow when user intent mentions right-click/mount
          if (String(payload.tool) === 'follow_player') {
            const raw = String(content || '')
            if (/(空手|右键|右击|坐我|骑我|骑乘|乘坐|mount)/i.test(raw)) {
              const name = String(payload.args?.name || username || '').trim()
              if (name) payload = { tool: 'mount_player', args: { name } }
            }
          }
          if (!allow.has(String(payload.tool))) {
            return H.trimReply('这个我还不会哟~', maxReplyLen || 120)
          }
          if (speech) sendChatReply(username, speech)
          // Mark external-busy and current task for context; emit begin/end for tracker
          try { state.externalBusy = true; bot.emit('external:begin', { source: 'chat', tool: payload.tool }) } catch {}
          let res
          try {
            res = await tools.run(payload.tool, payload.args || {})
          } finally {
            try { state.externalBusy = false; bot.emit('external:end', { source: 'chat', tool: payload.tool }) } catch {}
          }
          if (state.ai.trace && log?.info) log.info('tool ->', payload.tool, payload.args, res)
          // Acknowledge in chat succinctly
          if (res && res.ok) {
            const okText = H.trimReply(res.msg || '好的', maxReplyLen || 120)
            if (speech) {
              sendChatReply(username, okText)
              return ''
            }
            return okText
          }
          const failText = H.trimReply(res?.msg || '这次没成功！', maxReplyLen || 120)
          if (speech) {
            sendChatReply(username, failText)
            return ''
          }
          return failText
        }
      }
      // Usage accounting (if provided), otherwise rough estimate
      const u = data?.usage || {}
      const inTok = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : estIn
      const outTok = Number.isFinite(u.completion_tokens) ? u.completion_tokens : estTokensFromText(reply)
      applyUsage(inTok, outTok)
      if (state.ai.trace && log?.info) {
        const delta = (inTok / 1000) * (state.ai.priceInPerKT || 0) + (outTok / 1000) * (state.ai.priceOutPerKT || 0)
        log.info('usage inTok=', inTok, 'outTok=', outTok, 'cost+=', delta.toFixed(4))
      }
      return H.trimReply(reply, maxReplyLen || 120)
    } finally {
      clearTimeout(timeout)
      ctrl.abort = null
    }
  }

  function shouldAutoFollowup (username, text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) { traceChat('[chat] followup skip empty', { username }); return false }
    if (!state.ai.enabled) { traceChat('[chat] followup ai-disabled', { username }); return false }
    if (!username || username === bot.username) { traceChat('[chat] followup self/unknown', { username }); return false }
    if (!isUserActive(username)) { traceChat('[chat] followup inactive', { username }); return false }
    const trig = triggerWord()
    if (!trig) return true
    const startRe = new RegExp('^' + trig, 'i')
    return !startRe.test(trimmed)
  }

  async function processChatContent (username, content, raw, source) {
    if (!state.ai.enabled) return
    let text = String(content || '').trim()
    if (!text) return
    traceChat('[chat] process', { source, username, text })
    activateSession(username, source)
    touchConversationSession(username)
    const reasonTag = source === 'followup' ? 'followup' : 'trigger'
    if (/(下坐|下车|下马|dismount|停止\s*(骑|坐|骑乘|乘坐)|不要\s*(骑|坐)|别\s*(骑|坐))/i.test(text)) {
      try {
        const tools = actionsMod.install(bot, { log })
        const res = await tools.run('dismount', {})
        sendChatReply(username, res.ok ? (res.msg || '好的') : (`失败: ${res.msg || '未知'}`), { reason: `${reasonTag}_tool` })
      } catch {}
      return
    }
    if (isStopCommand(text)) {
      try {
        const tools = actionsMod.install(bot, { log })
        await tools.run('reset', {})
      } catch {}
      sendChatReply(username, '好的', { reason: `${reasonTag}_stop` })
      return
    }
    const memoryText = extractMemoryCommand(text)
    if (memoryText) {
      if (!state.ai?.key) {
        sendChatReply(username, '现在记不住呀，AI 没开~', { reason: 'memory_key' })
        return
      }
      const job = {
        id: `mem_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        player: username,
        text: memoryText,
        original: raw,
        recent: recentChatSnippet(6),
        createdAt: now(),
        source: 'player',
        attempts: 0,
        context: (() => {
          try {
            const pos = (() => {
              const entityPos = bot.entity?.position
              if (!entityPos) return null
              return { x: Math.round(entityPos.x), y: Math.round(entityPos.y), z: Math.round(entityPos.z) }
            })()
            const dim = (() => {
              try {
                const rawDim = bot.game?.dimension
                if (typeof rawDim === 'string' && rawDim.length) return rawDim
              } catch {}
              return null
            })()
            if (!pos) return null
            return { position: pos, dimension: dim, radius: 50, featureHint: memoryText }
          } catch { return null }
        })()
      }
      enqueueMemoryJob(job)
      sendChatReply(username, '收到啦，我整理一下~', { reason: 'memory_queue' })
      return
    }
    const allowed = canProceed(username)
    if (!allowed.ok) {
      if (state.ai?.limits?.notify !== false) {
        sendChatReply(username, '太快啦，稍后再试~', { reason: 'limits' })
      }
      return
    }
    try { state.aiPulse.lastFlushAt = now() } catch {}
    const intent = classifyIntent(text)
    if (state.ai.trace && log?.info) { try { log.info('intent ->', intent) } catch {} }
    const acted = await (async () => { return false })()
    if (acted) return
    if (ctrl.busy) {
      queuePending(username, raw)
      return
    }
    ctrl.busy = true
    try {
      if (state.ai.trace && log?.info) log.info('ask <-', text)
      const allowSkip = source === 'followup'
      const reply = await callAI(username, text, intent, { allowSkip })
      if (reply) {
        noteUsage(username)
        if (state.ai.trace && log?.info) log.info('reply ->', reply)
        if (allowSkip && /^skip$/i.test(reply.trim())) {
          traceChat('[chat] followup skipped', { username })
          return
        }
        const replyReason = source === 'followup' ? 'llm_followup' : 'llm_reply'
        sendChatReply(username, reply, { reason: replyReason })
      }
    } catch (e) {
      dlog('ai error:', e?.message || e)
      if (/key not configured/i.test(String(e))) {
        sendChatReply(username, 'AI未配置', { reason: 'error_key' })
      } else if (/budget/i.test(String(e)) && state.ai.notifyOnBudget) {
        sendChatReply(username, 'AI余额不足', { reason: 'error_budget' })
      }
    } finally {
      ctrl.busy = false
      const next = takePending()
      if (next) {
        setTimeout(() => { handleChat(next.username, next.message).catch(() => {}) }, 0)
      }
    }
  }

  async function handleChat (username, message) {
    const raw = String(message || '')
    const trimmed = raw.trim()
    const trig = triggerWord()
    const startRe = new RegExp('^' + trig, 'i')
    if (!startRe.test(trimmed)) {
      if (shouldAutoFollowup(username, trimmed)) {
        traceChat('[chat] followup trigger', { username, text: trimmed })
        await processChatContent(username, trimmed, raw, 'followup')
      } else {
        traceChat('[chat] ignore non-trigger', { username, text: trimmed })
      }
      return
    }
    let content = trimmed.replace(new RegExp('^(' + trig + '[:：,，。.!！\s]*)+', 'i'), '')
    content = content.replace(/^[:：,，。.!！\s]+/, '')
    traceChat('[chat] trigger matched', { username, text: content })
    activateSession(username, 'trigger', { restart: true })
    await processChatContent(username, content, raw, 'trigger')
  }

  const onChat = (username, message) => { handleChat(username, message).catch(() => {}) }
  on('chat', onChat)
  const onMessage = (message) => { handleSystemMessage(message) }
  on('message', onMessage)
  // capture recent chats for context (store even if not starting with trigger)
  const onChatCapture = (username, message) => {
    try {
      if (!username || username === bot.username) return
      const text = String(message || '').trim()
      if (!text) return
      pushRecentChatEntry(username, text, 'player')
      enqueuePulse(username, text)
    } catch {}
  }
  on('chat', onChatCapture)
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChat) } catch {} ; if (ctrl.abort) { try { ctrl.abort.abort() } catch {} } })
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChatCapture) } catch {} })
  registerCleanup && registerCleanup(() => { try { bot.off('message', onMessage) } catch {} })

  processMemoryQueue().catch(() => {})

  const aiCliHandler = require('./ai-chat/cli').createAiCliHandler({
    bot,
    state,
    log,
    actionsMod,
    buildGameContext,
    buildContextPrompt,
    persistMemoryState,
    selectDialoguesForContext,
    relativeTimeLabel,
    DEFAULT_RECENT_COUNT,
    rollSpendWindows,
    dayStart,
    monthStart
  })
  on('cli', onPulseCli)
  on('cli', aiCliHandler)
  registerCleanup && registerCleanup(() => {
    try { bot.off('cli', onPulseCli) } catch {}
    try { bot.off('cli', aiCliHandler) } catch {}
    try { resetActiveSessions() } catch {}
    if (state.aiPulse?._timer) {
      try { clearInterval(state.aiPulse._timer) } catch {}
      state.aiPulse._timer = null
    }
    pulseTimer = null
    if (pulseCtrl.abort && typeof pulseCtrl.abort.abort === 'function') {
      try { pulseCtrl.abort.abort('cleanup') } catch {}
    }
  })
}

module.exports = { install }
  function isStopCommand (text) {
    try {
      const t = String(text || '').toLowerCase()
      const tCN = String(text || '')
      if (/(don't|do not)\s*reset/.test(t)) return false
      if (/不要.*重置|别.*重置|不要.*复位|别.*复位/.test(tCN)) return false
      if (/(stop|cancel|abort|reset)/i.test(t)) return true
      if (/停止|停下|别动|取消|终止|重置|复位|归位|不要.*(追|打|攻击)|停止追击|停止攻击|停止清怪/.test(tCN)) return true
      return false
    } catch { return false }
  }
        // (intentionally no internal keyword-to-tool mappings for farming/feeding; leave to AI)
