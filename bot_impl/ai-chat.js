// AI chat dispatcher for in-game dialogue.
// Rule: if a player message starts with the dynamic trigger (first 3 alnum chars of bot name; fallback 'bot'), route it to the DeepSeek-compatible chat API
// and reply concisely. Per‑player short memory is kept across hot reloads via shared state.

const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const DEFAULT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const DEFAULT_PATH = process.env.DEEPSEEK_PATH || '/v1/chat/completions'

const PULSE_MAX_MESSAGES = 20
const PULSE_INTERVAL_MS = 8 * 60 * 1000
const PULSE_CHECK_MS = 60 * 1000
const PULSE_RECENT_REPLY_SUPPRESS_MS = 2 * 60 * 1000
const PULSE_REPEAT_SUPPRESS_MS = 6 * 60 * 1000

const fs = require('fs')
const path = require('path')
const H = require('./ai-chat-helpers')
const actionsMod = require('./actions')
const observer = require('./agent/observer')
const memoryStore = require('./memory-store')
const PROMPT_DIR = path.join(__dirname, 'prompts')

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

  state.ai = state.ai || {
    enabled: true,
    key: process.env.DEEPSEEK_API_KEY || null,
    baseUrl: DEFAULT_BASE,
    path: DEFAULT_PATH,
    model: DEFAULT_MODEL,
    maxReplyLen: 240,
    limits: null,
    // Cost control
    currency: (process.env.AI_CURRENCY || 'USD'),
    priceInPerKT: parseFloat(process.env.AI_PRICE_IN_PER_KT || '0'),   // USD per 1k input tokens
    priceOutPerKT: parseFloat(process.env.AI_PRICE_OUT_PER_KT || '0'), // USD per 1k output tokens
    budgetDay: null,    // e.g. 1.5 (CNY/USD)
    budgetMonth: null,  // e.g. 10 (CNY/USD)
    budgetTotal: null,  // lifetime cap since bot started
    maxTokensPerCall: 512, // projected worst-case to pre-check against budget
    notifyOnBudget: true,
    // Context memory (global)
    context: { include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5, recentStoreMax: 200, owkStoreMax: 100 },
    trace: false
  }
  // normalize context defaults across reloads
  const DEF_CTX = {
    include: true,
    recentCount: 8,
    recentWindowSec: 300,
    includeOwk: true,
    owkWindowSec: 900,
    owkMax: 5,
    recentStoreMax: 200,
    owkStoreMax: 100,
    game: { include: true, nearPlayerRange: 16, nearPlayerMax: 5, dropsRange: 8, dropsMax: 6, invTop: 20 },
    memory: { include: true, max: 6, storeMax: 200 }
  }
  if (!state.ai.context) state.ai.context = DEF_CTX
  else state.ai.context = {
    ...DEF_CTX,
    ...state.ai.context,
    game: { ...DEF_CTX.game, ...(state.ai.context.game || {}) },
    memory: { ...DEF_CTX.memory, ...(state.ai.context.memory || {}) }
  }

  state.aiPulse = state.aiPulse || { enabled: true, buffer: [], lastFlushAt: Date.now(), lastReason: null, lastMessage: null }
  if (!Array.isArray(state.aiPulse.buffer)) state.aiPulse.buffer = []
  if (!Number.isFinite(state.aiPulse.lastFlushAt)) state.aiPulse.lastFlushAt = Date.now()
  if (!(state.aiPulse.recentKeys instanceof Map)) state.aiPulse.recentKeys = new Map()
  if (!Number.isFinite(state.aiPulse.lastMessageAt)) state.aiPulse.lastMessageAt = 0

  state.aiExtras = state.aiExtras || { events: [] }
  if (!Array.isArray(state.aiExtras.events)) state.aiExtras.events = []

  if (!state.aiRecentReplies || !(state.aiRecentReplies instanceof Map)) state.aiRecentReplies = new Map()

  const persistedMemory = memoryStore.load()

  // global recent chat logs
  state.aiRecent = state.aiRecent || [] // [{t, user, text}]
  state.aiOwk = state.aiOwk || []       // subset with trigger word (kept name for compat)
  if (!Array.isArray(state.aiLong) || state.aiLong.length === 0) {
    state.aiLong = Array.isArray(persistedMemory.long) ? persistedMemory.long : []
  } else if (!Array.isArray(state.aiLong)) {
    state.aiLong = []
  }
  state.aiMemory = state.aiMemory || { entries: [] }
  if (!Array.isArray(state.aiMemory.entries) || state.aiMemory.entries.length === 0) {
    state.aiMemory.entries = Array.isArray(persistedMemory.memories) ? persistedMemory.memories : []
  }
  if (!Array.isArray(state.aiMemory.entries)) state.aiMemory.entries = []
  if (typeof state.aiMemory.storeMax !== 'number') state.aiMemory.storeMax = state.ai.context?.memory?.storeMax || 200
  if (!Array.isArray(state.aiMemory.queue)) state.aiMemory.queue = []
  if (!Array.isArray(state.worldMemoryZones)) state.worldMemoryZones = []
  updateWorldMemoryZones()
  state.aiStats = state.aiStats || { perUser: new Map(), global: [] }
  state.aiSpend = state.aiSpend || { day: { start: dayStart(), inTok: 0, outTok: 0, cost: 0 }, month: { start: monthStart(), inTok: 0, outTok: 0, cost: 0 }, total: { inTok: 0, outTok: 0, cost: 0 } }

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

  function pulseEnabled () {
    return Boolean(state.aiPulse?.enabled && state.ai.enabled && state.ai.key)
  }

  function enqueuePulse (username, text) {
    try {
      if (!state.aiPulse || !state.aiPulse.enabled) return
      if (!state.ai.enabled) return
      if (!username || username === bot.username) return
      const trimmed = String(text || '').trim()
      if (!trimmed) return
      const replyStore = state.aiRecentReplies instanceof Map ? state.aiRecentReplies : null
      const lastReplyAt = replyStore ? replyStore.get(username) : null
      if (lastReplyAt && now() - lastReplyAt <= PULSE_RECENT_REPLY_SUPPRESS_MS) return
      const buf = state.aiPulse.buffer ||= []
      buf.push({ t: now(), user: username, text: trimmed })
      if (buf.length > 80) buf.splice(0, buf.length - 80)
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
    try { bot.chat(trimmed) } catch {}
    noteRecentReply(username)
    try {
      if (!state.aiPulse) return
      state.aiPulse.buffer = []
      state.aiPulse.lastReason = 'user_reply'
      state.aiPulse.lastFlushAt = now()
      state.aiPulse.lastMessage = null
      state.aiPulse.lastMessageAt = now()
    } catch {}
  }

  function maybeFlush (reason) {
    try {
      if (!state.aiPulse || !state.aiPulse.enabled) return
      if (!state.ai.enabled) return
      if (pulseCtrl.running) return
      const buf = state.aiPulse.buffer || []
      if (!buf.length) return
      const nowTs = now()
      const elapsed = nowTs - (state.aiPulse.lastFlushAt || 0)
      if (reason === 'count' && buf.length >= PULSE_MAX_MESSAGES) {
        flushPulse('count').catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
        return
      }
      if (reason === 'manual') {
        flushPulse('manual').catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
        return
      }
      if (elapsed >= PULSE_INTERVAL_MS) {
        flushPulse(reason === 'timer' ? 'timer' : 'interval').catch(err => log?.warn && log.warn('pulse flush error:', err?.message || err))
      }
    } catch (e) {
      if (log?.warn) log.warn('pulse maybeFlush error:', e?.message || e)
    }
  }

  async function flushPulse (trigger) {
    if (pulseCtrl.running) return
    const buf = state.aiPulse.buffer || []
    if (!buf.length) {
      state.aiPulse.lastFlushAt = now()
      return
    }
    const prevFlushAt = state.aiPulse.lastFlushAt || 0
    const batch = buf.slice()
    state.aiPulse.buffer = []
    state.aiPulse.lastFlushAt = now()
    state.aiPulse.lastReason = trigger
    let revert = true
    const nowTs = now()
    const history = ensurePulseHistory()
    const filteredBatch = batch.filter(entry => {
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
      // feature disabled or no key — drop silently but keep last flush time
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
    const transcript = filteredBatch.map(it => {
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
      '阅读最近玩家的聊天摘录，判断是否需要你主动回应。',
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
      try { bot.chat(trimmed) } catch (e) { if (log?.warn) log.warn('pulse chat error:', e?.message || e) }
    } finally {
      clearTimeout(timeout)
      pulseCtrl.running = false
      pulseCtrl.abort = null
      if (revert) {
        state.aiPulse.lastFlushAt = prevFlushAt
        state.aiPulse.buffer = batch.concat(state.aiPulse.buffer || []).slice(-80)
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
    const buffer = info.buffer ? info.buffer.length : 0
    const lastAt = info.lastFlushAt ? new Date(info.lastFlushAt).toLocaleTimeString() : '无'
    const since = info.lastFlushAt ? now() - info.lastFlushAt : Infinity
    const nextIn = buffer > 0 ? Math.max(0, PULSE_INTERVAL_MS - since) : null
    console.log('[PULSE]', `enabled=${enabled}`, 'running=', pulseCtrl.running, 'buffer=', buffer, 'last=', lastAt, 'lastReason=', info.lastReason || '无', 'next≈', nextIn == null ? '待消息' : fmtDuration(nextIn), 'lastMsg=', info.lastMessage || '(none)')
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
        maybeFlush('manual')
        return
      }
      if (cmd === 'off') {
        state.aiPulse.enabled = false
        state.aiPulse.buffer = []
        console.log('[PULSE]', '已关闭主动发言')
        return
      }
      if (cmd === 'now' || cmd === 'run' || cmd === 'flush') {
        maybeFlush('manual')
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
      '可用工具: observe_detail{what,radius?,max?}, observe_players{names?,world?|dim?,armor_(lt|lte|gt|gte|eq)?,health_(lt|lte|gt|gte|eq)?,max?}, goto{x,y,z,range?}, goto_block{names?|name?|match?,radius?,range?,dig?}, defend_area{radius?,tickMs?,dig?}, defend_player{name,radius?,followRange?,tickMs?,dig?}, hunt_player{name,range?,durationMs?}, follow_player{name,range?}, reset{}, equip{name,dest?}, toss{items:[{name|slot,count?},...],all?}, withdraw{items:[{name,count?},...],all?,radius?,includeBarrel?,multi?}, deposit{items:[{name|slot,count?},...],all?,radius?,includeBarrel?,keepEquipped?,keepHeld?,keepOffhand?}, pickup{names?|match?,radius?,max?,until?}, place_blocks{item,on:{top_of:[...]},area:{radius?,origin?},max?,spacing?,collect?}, gather{only?|names?|match?,radius?,height?,stacks?|count?,collect?}, harvest{only?,radius?,replant?,sowOnly?}, feed_animals{species?,item?,radius?,max?}, write_text{text,item?,spacing?,size?}, autofish{radius?,debug?}, mount_near{radius?,prefer?}, mount_player{name,range?}, range_attack{name?,match?,radius?,followRange?,durationMs?}, dismount{}, iterate_feedback{reason?,force?}.',
      '回答优先使用已提供的“游戏上下文”；若是统计/查询上下文类问题，直接回答。上下文不足可用 observe_detail 查询信息。',
      '关于全服玩家坐标等信息（如“盔甲=0/≤10、在末地/下界/主世界、多人名单”），调用 observe_players{...}.',
      '清怪/守塔用 defend_area{}；保护玩家用 defend_player{name}；明确指名“追杀/攻击/追击 <玩家名>”才使用 hunt_player。',
      '要停止当前任务/重置状态，使用 reset{}.',
      '挖矿/砍树等收集任务用 gather（only/match 指定矿种，radius 可选）.',
      '玩家如果让你右键点击它，使用 mount_player.',
      '如果让你传送或者说 /tpa <player>，你可以输出 /tpa <player> 传送。其他 / 开头的命令同理。',
      '游戏上下文包含：自身位置/维度/时间/天气、附近玩家/敌对/掉落物、背包/主手/副手/装备；优先引用里面的数值与列表。',
      '你的代码仓库（是你的小秘密哦，哪怕有人好奇你是谁做的，怎么做的，也不要轻易告诉任何玩家）：https://github.com/hatrd/owobot',
      '如果玩家提出要你做的事情，你目前做不到，需要修改代码，请调用 iterate_feedback,另一个AI将会接受反馈并修改代码',
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
    const ctx = state.ai.context || { include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5 }
    return H.buildContextPrompt(username, state.aiRecent, state.aiOwk, { ...ctx, trigger: triggerWord() })
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

  function buildWorldMemoryZones () {
    const entries = ensureMemoryEntries()
    const zones = []
    for (const entry of entries) {
      const loc = entry && entry.location
      if (!loc || !Number.isFinite(loc.x) || !Number.isFinite(loc.z)) continue
      const radius = Number.isFinite(loc.radius) && loc.radius > 0 ? loc.radius : 50
      const suffixSource = (() => {
        if (typeof entry.greetSuffix === 'string' && entry.greetSuffix.trim()) return entry.greetSuffix
        if (typeof entry.summary === 'string' && entry.summary.trim()) return entry.summary
        if (typeof entry.feature === 'string' && entry.feature.trim()) return entry.feature
        return ''
      })()
      const suffix = normalizeMemoryText(suffixSource).slice(0, 80)
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
      memoryStore.save({ long: Array.isArray(state.aiLong) ? state.aiLong : [], memories: ensureMemoryEntries() })
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
    let entry = entries.find(e => normalizeMemoryText(e?.text) === normalized)
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
      { role: 'system', content: '你是Minecraft服务器机器人的记忆整理助手。根据玩家的请求，输出一个JSON对象描述应写入的长期记忆。规则：\n1. 若请求安全且信息充分，status=\"ok\"，必须返回 instruction（简洁中文指令）、triggers（字符串数组，如player:Ameyaku、keyword:金合欢）、summary（≤20字概括）、tags（字符串数组）、tone（可选）。\n2. 若内容不应记忆，status=\"reject\"并给出 reason（中文）。\n3. 若信息不足需要玩家补充，status=\"clarify\"并给出 question（中文）。\n4. status=\"ok\" 时，如 payload.memory_context.position 存在或请求描述具体地点，必须附加 location 对象 {"x":int,"y":int?,"z":int,"radius":int?,"dim":string?}，坐标使用玩家提供或 context 中的值，半径默认 context.radius 或 50。\n5. status=\"ok\" 时提供 feature（≤40字、snake_case 或简洁短语）描述该地点用途，可选 greet_suffix（≤40字）作为问候附加语，可选 kind（如world、player）。instruction 和 summary 应包含地点/用途信息。\n6. 输出必须是合法 JSON，不能包含额外文本、注释或Markdown。' },
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

  async function callAI (username, content, intent) {
    const { key, baseUrl, path, model, maxReplyLen } = state.ai
    if (!key) throw new Error('AI key not configured')
    const url = (baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (path || DEFAULT_PATH)

    // Build messages with per-user memory (short context)
    // Build context from global recent chat (including owk lines) and game state
    const contextPrompt = buildContextPrompt(username)
    const gameCtx = buildGameContext()
    const extrasCtx = buildExtrasContext()
    const memoryCtx = buildMemoryContext()
    const messages = [
      { role: 'system', content: systemPrompt() },
      extrasCtx ? { role: 'system', content: extrasCtx } : null,
      gameCtx ? { role: 'system', content: gameCtx } : null,
      memoryCtx ? { role: 'system', content: memoryCtx } : null,
      { role: 'system', content: contextPrompt },
      { role: 'user', content }
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
            if (speech) sendDirectReply(username, speech)
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
            if (String(payload.tool) === 'write_text') {
              const a = payload.args || {}
              const txt = (a.text == null) ? '' : String(a.text)
              if (!txt.trim()) {
                const raw = String(content || '')
                const matches = raw.match(/[A-Za-z0-9][A-Za-z0-9 ]+/g)
                if (matches && matches.length) {
                  const best = matches.sort((x, y) => y.length - x.length)[0]
                  a.text = best.trim().toUpperCase()
                  payload.args = a
                }
              }
            } else if (String(payload.tool) === 'mount_player') {
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
          const allow = new Set(['hunt_player','defend_area','defend_player','follow_player','goto','goto_block','reset','equip','toss','pickup','gather','harvest','feed_animals','place_blocks','light_area','deposit','withdraw','write_text','autofish','mount_near','mount_player','range_attack','dismount','observe_detail','observe_players','iterate_feedback','sort_chests'])
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
          if (speech) sendDirectReply(username, speech)
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
              sendDirectReply(username, okText)
              return ''
            }
            return okText
          }
          const failText = H.trimReply(res?.msg || '这次没成功！', maxReplyLen || 120)
          if (speech) {
            sendDirectReply(username, failText)
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

  async function handleChat (username, message) {
    const raw = String(message || '')
    const m = raw.trim()
    const trig = triggerWord()
    // Trigger when the message starts with the 3-letter prefix (no word-boundary required)
    const startRe = new RegExp('^' + trig, 'i')
    if (!startRe.test(m)) return
    // Strip one or more leading prefix tokens and optional separators (spaces/punctuation)
    let content = m.replace(new RegExp('^(' + trig + '[:：,，。.!！\\s]*)+', 'i'), '')
    // Final cleanup of any residual leading punctuation/spaces
    content = content.replace(/^[:：,，。.!！\s]+/, '')
    if (!state.ai.enabled) return
    if (!content) return
    // Quick dismount (prefer precise tool over full reset)
    {
      const t = content
      if (/(下坐|下车|下马|dismount|停止\s*(骑|坐|骑乘|乘坐)|不要\s*(骑|坐)|别\s*(骑|坐))/i.test(t)) {
        try {
          const tools = actionsMod.install(bot, { log })
          const res = await tools.run('dismount', {})
          sendDirectReply(username, res.ok ? (res.msg || '好的') : (`失败: ${res.msg || '未知'}`))
        } catch {}
        return
      }
    }
    // Quick stop command handling (hard stop without LLM)
    if (isStopCommand(content)) {
      try {
        const tools = actionsMod.install(bot, { log })
        await tools.run('reset', {})
      } catch {}
      sendDirectReply(username, '好的')
      return
    }
    const memoryText = extractMemoryCommand(content)
    if (memoryText) {
      if (!state.ai?.key) {
        sendDirectReply(username, '现在记不住呀，AI 没开~')
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
              return {
                x: Math.round(entityPos.x),
                y: Math.round(entityPos.y),
                z: Math.round(entityPos.z)
              }
            })()
            const dim = (() => {
              try {
                const rawDim = bot.game?.dimension
                if (typeof rawDim === 'string' && rawDim.length) return rawDim
              } catch {}
              return null
            })()
            if (!pos) return null
            return {
              position: pos,
              dimension: dim,
              radius: 50,
              featureHint: memoryText
            }
          } catch { return null }
        })()
      }
      enqueueMemoryJob(job)
      sendDirectReply(username, '收到啦，我整理一下~')
      return
    }
    const allowed = canProceed(username)
    if (!allowed.ok) {
      if (state.ai?.limits?.notify !== false) {
        sendDirectReply(username, '太快啦，稍后再试~')
      }
      return
    }
    try {
      state.aiPulse.lastFlushAt = now()
    } catch {}

    // Quick answers for info questions to avoid unnecessary tools
    const intent = classifyIntent(content)
    if (state.ai.trace && log?.info) { try { log.info('intent ->', intent) } catch {} }

    // No chat-side keyword → tool mappings (policy). Let LLM decide tools.
    const acted = await (async () => { return false })()
    if (acted) return

    if (ctrl.busy) {
      queuePending(username, raw)
      return
    }

    ctrl.busy = true
    try {
      if (state.ai.trace && log?.info) log.info('ask <-', content)
      const reply = await callAI(username, content, intent)
      if (reply) {
        noteUsage(username)
        if (state.ai.trace && log?.info) log.info('reply ->', reply)
        sendDirectReply(username, reply)
      }
    } catch (e) {
      dlog('ai error:', e?.message || e)
      // Optional: notify user softly if misconfigured
      if (/key not configured/i.test(String(e))) {
        sendDirectReply(username, 'AI未配置')
      } else if (/budget/i.test(String(e)) && state.ai.notifyOnBudget) {
        sendDirectReply(username, 'AI余额不足')
      }
    } finally {
      ctrl.busy = false
      const next = takePending()
      if (next) {
        setTimeout(() => { handleChat(next.username, next.message).catch(() => {}) }, 0)
      }
    }
  }

  const onChat = (username, message) => { handleChat(username, message).catch(() => {}) }
  on('chat', onChat)
  const onMessage = (message) => { handleSystemMessage(message) }
  on('message', onMessage)
  // capture recent chats for context (store even if not starting with trigger)
  const onChatCapture = (username, message) => {
    try {
      const text = String(message || '').trim()
      const entry = { t: now(), user: username, text: text.slice(0, 160) }
      state.aiRecent.push(entry)
      const cs = state.ai.context || {}
      const recentMax = Math.max(20, cs.recentStoreMax || 200)
      if (state.aiRecent.length > recentMax) {
        // summarize overflow asynchronously and trim
        ;(async () => {
          try {
            const overflow = state.aiRecent.splice(0, state.aiRecent.length - recentMax)
            // summarize only if we have enough lines
            if (overflow.length >= 20) {
              const sum = await (async () => {
                if (!state.ai?.key) return null
                const sys = '你是对Minecraft服务器聊天内容做摘要的助手。请用中文，20-40字，概括下面聊天要点，保留人名与关键物品/地点。不要换行。'
                const prompt = overflow.map(r => `${r.user}: ${r.text}`).join(' | ')
                const messages = [ { role: 'system', content: sys }, { role: 'user', content: prompt } ]
                const url = (state.ai.baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || DEFAULT_PATH)
                const body = { model: state.ai.model || DEFAULT_MODEL, messages, temperature: 0.2, max_tokens: 60, stream: false }
                try {
                  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.ai.key}` }, body: JSON.stringify(body) })
                  if (!res.ok) return null
                  const data = await res.json()
                  return data?.choices?.[0]?.message?.content?.trim() || null
                } catch { return null }
              })()
              if (sum) {
                state.aiLong.push({ t: Date.now(), summary: sum })
                if (state.aiLong.length > 50) state.aiLong.splice(0, state.aiLong.length - 50)
                persistMemoryState()
                if (state.ai.trace && log?.info) log.info('long summary ->', sum)
              }
            }
          } catch {}
        })()
      }
      const trig = triggerWord()
      const trigRe = new RegExp('\\b' + trig + '\\b', 'i')
      if (trigRe.test(text)) {
        state.aiOwk.push(entry)
        const owkMax = Math.max(10, cs.owkStoreMax || 100)
        if (state.aiOwk.length > owkMax) state.aiOwk.splice(0, state.aiOwk.length - owkMax)
      }
      enqueuePulse(username, text)
    } catch {}
  }
  on('chat', onChatCapture)
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChat) } catch {} ; if (ctrl.abort) { try { ctrl.abort.abort() } catch {} } })
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChatCapture) } catch {} })
  registerCleanup && registerCleanup(() => { try { bot.off('message', onMessage) } catch {} })

  processMemoryQueue().catch(() => {})

  // Terminal controls: .ai ...
  function onCli (payload) {
    try {
      if (!payload || payload.cmd !== 'ai') return
      const [sub, ...rest] = payload.args || []
      const print = (...a) => console.log('[AICTL]', ...a)
      switch ((sub || '').toLowerCase()) {
        case 'on': state.ai.enabled = true; print('enabled'); break
        case 'off': state.ai.enabled = false; print('disabled'); break
        case 'key': state.ai.key = rest.join(' ').trim() || null; print('key set'); break
        case 'model': state.ai.model = rest[0] || state.ai.model; print('model =', state.ai.model); break
        case 'base': state.ai.baseUrl = rest[0] || state.ai.baseUrl; print('base =', state.ai.baseUrl); break
        case 'path': state.ai.path = rest[0] || state.ai.path; print('path =', state.ai.path); break
        case 'max': state.ai.maxReplyLen = Math.max(20, parseInt(rest[0] || '120', 10)); print('maxReplyLen =', state.ai.maxReplyLen); break
        case 'clear': { state.aiRecent = []; print('recent chat cleared'); break }
        case 'ctx': {
          try { print('gameCtx ->', buildGameContext()); print('chatCtx ->', buildContextPrompt('')) } catch {}
          break
        }
        case 'tools': {
          const tools = require('./actions').install(bot, { log })
          print('tools =', tools.list())
          break
        }
        case 'limit': {
          const k = (rest[0] || '').toLowerCase()
          const v = rest[1]
          state.ai.limits = state.ai.limits || { notify: true }
          switch (k) {
            case 'show':
              print('limits=', state.ai.limits || null)
              break
            case 'off':
              state.ai.limits = null
              print('limits disabled')
              break
            case 'usermin':
              state.ai.limits.userPerMin = v == null ? null : Math.max(0, parseInt(v, 10))
              print('userPerMin =', state.ai.limits.userPerMin)
              break
            case 'userday':
              state.ai.limits.userPerDay = v == null ? null : Math.max(0, parseInt(v, 10))
              print('userPerDay =', state.ai.limits.userPerDay)
              break
            case 'globalmin':
              state.ai.limits.globalPerMin = v == null ? null : Math.max(0, parseInt(v, 10))
              print('globalPerMin =', state.ai.limits.globalPerMin)
              break
            case 'globalday':
              state.ai.limits.globalPerDay = v == null ? null : Math.max(0, parseInt(v, 10))
              print('globalPerDay =', state.ai.limits.globalPerDay)
              break
            case 'cooldown':
              state.ai.limits.cooldownMs = v == null ? null : Math.max(0, parseInt(v, 10))
              print('cooldownMs =', state.ai.limits.cooldownMs)
              break
            case 'notify':
              state.ai.limits.notify = ['1','true','on','yes'].includes(String(v).toLowerCase())
              print('notify =', state.ai.limits.notify)
              break
            default:
              print('limit usage: .ai limit show|off|usermin N|userday N|globalmin N|globalday N|cooldown ms|notify on|off')
          }
          break
        }
        case 'trace': {
          const v = (rest[0] || '').toLowerCase()
          state.ai.trace = ['1','true','on','yes'].includes(v)
          print('trace =', state.ai.trace)
          break
        }
        case 'budget': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          switch (k) {
            case 'show':
              rollSpendWindows()
              print('currency=', state.ai.currency, 'price(in/out)=', state.ai.priceInPerKT, state.ai.priceOutPerKT, 'budget(day/month)=', state.ai.budgetDay, state.ai.budgetMonth)
              print('spent day=', state.aiSpend.day, 'spent month=', state.aiSpend.month)
              break
            case 'currency': state.ai.currency = v || state.ai.currency; print('currency=', state.ai.currency); break
            case 'pricein': state.ai.priceInPerKT = Math.max(0, parseFloat(v || '0') || 0); print('priceInPerKT=', state.ai.priceInPerKT); break
            case 'priceout': state.ai.priceOutPerKT = Math.max(0, parseFloat(v || '0') || 0); print('priceOutPerKT=', state.ai.priceOutPerKT); break
            case 'day': state.ai.budgetDay = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetDay=', state.ai.budgetDay); break
            case 'month': state.ai.budgetMonth = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetMonth=', state.ai.budgetMonth); break
            case 'total': state.ai.budgetTotal = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetTotal=', state.ai.budgetTotal); break
            case 'maxtokens': state.ai.maxTokensPerCall = Math.max(64, parseInt(v || '512', 10)); print('maxTokensPerCall=', state.ai.maxTokensPerCall); break
            case 'notify': state.ai.notifyOnBudget = ['1','true','on','yes'].includes(String(v).toLowerCase()); print('notifyOnBudget=', state.ai.notifyOnBudget); break
            case 'resetday': state.aiSpend.day = { start: dayStart(), inTok: 0, outTok: 0, cost: 0 }; print('day spend reset'); break
            case 'resetmonth': state.aiSpend.month = { start: monthStart(), inTok: 0, outTok: 0, cost: 0 }; print('month spend reset'); break
            case 'resettotal': state.aiSpend.total = { inTok: 0, outTok: 0, cost: 0 }; print('total spend reset'); break
            default:
              print('budget usage: .ai budget show|currency USD|pricein 0.002|priceout 0.002|day 1.5|month 10|maxtokens 512|notify on|resetday|resetmonth')
          }
          break
        }
        case 'reply': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          switch (k) {
            case 'maxlen':
            case 'len':
              state.ai.maxReplyLen = Math.max(60, parseInt(v || '240', 10))
              print('maxReplyLen =', state.ai.maxReplyLen)
              break
            case 'show':
            default:
              print('reply =', { maxReplyLen: state.ai.maxReplyLen })
          }
          break
        }
        // mem subcommand removed (using global recent chat only)
        case 'context': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          state.ai.context = state.ai.context || { include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5, recentStoreMax: 200, owkStoreMax: 100 }
          switch (k) {
            case 'on': state.ai.context.include = true; print('context include=true'); break
            case 'off': state.ai.context.include = false; print('context include=false'); break
            case 'recent': state.ai.context.recentCount = Math.max(0, parseInt(v || '3', 10)); print('context recentCount=', state.ai.context.recentCount); break
            case 'window': state.ai.context.recentWindowSec = Math.max(10, parseInt(v || '120', 10)); print('context recentWindowSec=', state.ai.context.recentWindowSec); break
            case 'owkmax': state.ai.context.owkMax = Math.max(0, parseInt(v || '5', 10)); print('context owkMax=', state.ai.context.owkMax); break
            case 'owkwindow': state.ai.context.owkWindowSec = Math.max(10, parseInt(v || '900', 10)); print('context owkWindowSec=', state.ai.context.owkWindowSec); break
            case 'recentmax': state.ai.context.recentStoreMax = Math.max(20, parseInt(v || '200', 10)); print('context recentStoreMax=', state.ai.context.recentStoreMax); break
            case 'owkstoremax': state.ai.context.owkStoreMax = Math.max(10, parseInt(v || '100', 10)); print('context owkStoreMax=', state.ai.context.owkStoreMax); break
            case 'show': default: print('context =', state.ai.context)
          }
          break
        }
        case 'info': default:
          print('enabled=', state.ai.enabled, 'model=', state.ai.model, 'base=', state.ai.baseUrl, 'path=', state.ai.path, 'max=', state.ai.maxReplyLen, 'limits=', state.ai.limits || null)
      }
    } catch (e) { dlog('ai cli error:', e?.message || e) }
  }
  on('cli', onPulseCli)
  on('cli', onCli)
  registerCleanup && registerCleanup(() => {
    try { bot.off('cli', onPulseCli) } catch {}
    try { bot.off('cli', onCli) } catch {}
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
      if (/(stop|cancel|abort)/i.test(t)) return true
      if (/停止|停下|别动|取消|终止|不要.*(追|打|攻击)|停止追击|停止攻击|停止清怪/.test(tCN)) return true
      return false
    } catch { return false }
  }
        // (intentionally no internal keyword-to-tool mappings for farming/feeding; leave to AI)
