const H = require('./ai-chat-helpers')
const actionsMod = require('./actions')
const observer = require('./agent/observer')
const memoryStore = require('./memory-store')
const { prepareAiState } = require('./ai-chat/state-init')
const { createAiCliHandler } = require('./ai-chat/cli')
const { createPulseService } = require('./ai-chat/pulse')
const { createMemoryService } = require('./ai-chat/memory')
const { createChatExecutor } = require('./ai-chat/executor')
const {
  DEFAULT_MODEL,
  DEFAULT_BASE,
  DEFAULT_PATH,
  DEFAULT_RECENT_COUNT,
  DEFAULT_MEMORY_STORE_MAX,
  buildDefaultContext
} = require('./ai-chat/config')
const {
  initMemoryRetrievalPrompt,
  createMemoryRetrievalSystem
} = require('./mai_core/memory-retrieval')
const { createThinkingBackStore } = require('./mai_core/thinking-back-store')
const { createThinkingBackDao } = require('./mai_core/thinking-back-dao')
const { globalConfig, modelConfig } = require('./mai_core/config')

const LOCAL_JARGON_MAP = new Map([
  ['tp', '向其他玩家发送传送请求（/tpa <玩家名>）'],
  ['rtp', '随机传送到一个安全位置'],
  ['back', '返回上一次死亡点或传送点'],
  ['spawn', '传送回主城/出生点'],
  ['home', '传送到家，即 /home'],
  ['ls', '整理背包或储物箱的命令（loot sort）']
])

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...args) => log.debug(...args)

  function now () { return Date.now() }

  function traceChat (...args) {
    if (state.ai?.trace && log?.info) {
      try { log.info(...args) } catch {}
    }
  }

  function dayStart (t = now()) {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  function monthStart (t = now()) {
    const d = new Date(t)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  function rollSpendWindows () {
    const t = now()
    const d0 = dayStart(t)
    const m0 = monthStart(t)
    if (state.aiSpend.day.start !== d0) state.aiSpend.day = { start: d0, inTok: 0, outTok: 0, cost: 0 }
    if (state.aiSpend.month.start !== m0) state.aiSpend.month = { start: m0, inTok: 0, outTok: 0, cost: 0 }
  }

  function projectedCostForCall (promptTok, outTokMax) {
    const { priceInPerKT, priceOutPerKT } = state.ai
    return H.projectedCostForCall(priceInPerKT, priceOutPerKT, promptTok, outTokMax)
  }

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
    state.aiSpend.day.inTok += inTok
    state.aiSpend.day.outTok += outTok
    state.aiSpend.day.cost += cost
    state.aiSpend.month.inTok += inTok
    state.aiSpend.month.outTok += outTok
    state.aiSpend.month.cost += cost
    state.aiSpend.total.inTok += inTok
    state.aiSpend.total.outTok += outTok
    state.aiSpend.total.cost += cost
  }

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

  const defaults = { DEFAULT_MODEL, DEFAULT_BASE, DEFAULT_PATH, DEFAULT_RECENT_COUNT, DEFAULT_MEMORY_STORE_MAX, buildDefaultContext }
  const memory = createMemoryService({ state, log, memoryStore, defaults, bot, traceChat, now })
  const persistedMemory = memoryStore.load()
  prepareAiState(state, {
    defaults,
    persistedMemory,
    trimConversationStore: memory.dialogue.trimStore,
    updateWorldMemoryZones: memory.longTerm.updateWorldZones,
    dayStart,
    monthStart
  })
  globalConfig.botName = bot?.username || state.ai?.botName || 'MaiBot'
  globalConfig.enableDebugLog = Boolean(state.ai?.trace)
  modelConfig.model = state.ai?.model || DEFAULT_MODEL
  modelConfig.temperature = 0.25
  modelConfig.maxTokens = state.ai?.maxTokensPerCall || 256
  if (!state.aiExtras || typeof state.aiExtras !== 'object') state.aiExtras = { events: [] }
  if (!Array.isArray(state.aiExtras.events)) state.aiExtras.events = []

  const thinkingBackStore = createThinkingBackStore({ dao: createThinkingBackDao(), now })

  function searchChatHistory ({ keywords = [], limit = 12, sinceMs } = {}) {
    const rows = Array.isArray(state.aiRecent) ? state.aiRecent : []
    const terms = (Array.isArray(keywords) ? keywords : [keywords])
      .map(k => String(k || '').trim().toLowerCase())
      .filter(Boolean)
    const since = Number.isFinite(sinceMs) ? sinceMs : 0
    const matches = rows
      .filter(line => !Number.isFinite(line?.t) || line.t >= since)
      .filter(line => {
        if (!terms.length) return true
        const text = String(line?.text || '').toLowerCase()
        return terms.some(term => text.includes(term))
      })
      .slice(-Math.max(limit, 8))
    return matches.map(line => ({
      user: line?.user || '?',
      text: String(line?.text || '').slice(0, 200),
      seq: line?.seq,
      at: line?.t
    }))
  }

  function lookupJargon ({ terms = [] } = {}) {
    const entries = []
    for (const raw of terms) {
      const key = String(raw || '').trim().toLowerCase()
      if (!key) continue
      const meaning = LOCAL_JARGON_MAP.get(key) || '无内置解释，请结合聊天上下文理解。'
      entries.push({ term: raw, meaning })
    }
    return entries
  }

  function lookupPlayerProfile ({ players = [], max = 3 } = {}) {
    const results = []
    const entries = Array.isArray(state.aiMemory?.entries) ? state.aiMemory.entries : []
    for (const nameRaw of players) {
      const name = String(nameRaw || '').trim()
      if (!name) continue
      const matched = entries.filter(entry => {
        const summary = String(entry?.summary || entry?.text || '')
        return summary.includes(name)
      }).slice(-Math.max(1, max))
      results.push({
        player: name,
        notes: matched.map(entry => ({
          summary: entry.summary || entry.text,
          tags: entry.tags || [],
          updatedAt: entry.updatedAt
        }))
      })
    }
    return results
  }

  function lookupMcServerState () {
    const zones = Array.isArray(state.worldMemoryZones) ? state.worldMemoryZones.slice(-5) : []
    const extras = Array.isArray(state.aiExtras?.events) ? state.aiExtras.events.slice(-5) : []
    return {
      worldMemoryZones: zones,
      recentEvents: extras,
      observerSnapshot: buildGameContext()
    }
  }

  initMemoryRetrievalPrompt({
    chatHistorySearch: async (input) => searchChatHistory(input),
    jargonLookup: async (input) => lookupJargon(input),
    playerInfoLookup: async (input) => lookupPlayerProfile(input),
    mcServerLookup: async () => lookupMcServerState()
  })

  async function runDeepseekCompletion ({ prompt, maxTokens = 256, temperature = 0.2 }) {
    const { key, baseUrl, path, model } = state.ai
    if (!key) throw new Error('AI key not configured')
    const url = (baseUrl || defaults.DEFAULT_BASE).replace(/\/$/, '') + (path || defaults.DEFAULT_PATH)
    const messages = [{ role: 'user', content: String(prompt || '') }]
    const estIn = H.estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (!afford.ok) throw new Error('budget_exceeded')
    const body = {
      model: model || defaults.DEFAULT_MODEL,
      messages,
      temperature,
      max_tokens: Math.max(96, Math.min(maxTokens, state.ai.maxTokensPerCall || 256)),
      stream: false
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status))
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    const reply = data?.choices?.[0]?.message?.content || ''
    const usage = data?.usage || {}
    const inTok = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : estIn
    const outTok = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : H.estTokensFromText(reply)
    applyUsage(inTok, outTok)
    return reply
  }

  const memoryRetrieval = createMemoryRetrievalSystem({
    llmClient: {
      complete: async (payload) => runDeepseekCompletion(payload)
    },
    thinkingBackStore,
    now: () => new Date()
  })

  let executor
  const pulse = createPulseService({
    state,
    bot,
    log,
    now,
    H,
    defaults,
    canAfford,
    applyUsage,
    buildContextPrompt: (name) => executor.buildContextPrompt(name),
    buildGameContext,
    traceChat,
    memory
  })
  executor = createChatExecutor({
    state,
    bot,
    log,
    actionsMod,
    H,
    defaults,
    now,
    traceChat,
    pulse,
    memory,
    canAfford,
    applyUsage,
    buildGameContext,
    buildExtrasContext: pulse.buildExtrasContext,
    memoryRetrieval
  })

  memory.setMessenger(pulse.sendDirectReply)

  const onChat = (username, message) => { executor.handleChat(username, message).catch(() => {}) }
  const onChatCapture = (username, message) => pulse.captureChat(username, message)
  const onMessage = (message) => pulse.captureSystemMessage(message)
  on('chat', onChat)
  on('chat', onChatCapture)
  on('message', onMessage)

  pulse.start()
  memory.rewrite.processQueue().catch(() => {})

  const aiCliHandler = createAiCliHandler({
    bot,
    state,
    log,
    actionsMod,
    buildGameContext,
    buildContextPrompt: executor.buildContextPrompt,
    persistMemoryState: memory.longTerm.persistState,
    selectDialoguesForContext: memory.dialogue.selectForContext,
    formatDialogueEntriesForDisplay: memory.dialogue.formatEntriesForDisplay,
    DEFAULT_RECENT_COUNT,
    rollSpendWindows,
    dayStart,
    monthStart
  })

  on('cli', pulse.handlePulseCli)
  on('cli', aiCliHandler)

  registerCleanup && registerCleanup(() => {
    try { bot.off('chat', onChat) } catch {}
    try { bot.off('chat', onChatCapture) } catch {}
    try { bot.off('message', onMessage) } catch {}
    try { bot.off('cli', pulse.handlePulseCli) } catch {}
    try { bot.off('cli', aiCliHandler) } catch {}
    pulse.stop()
    executor.abortActive()
  })
}

module.exports = { install }
