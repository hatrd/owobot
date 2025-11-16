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
  if (!state.aiExtras || typeof state.aiExtras !== 'object') state.aiExtras = { events: [] }
  if (!Array.isArray(state.aiExtras.events)) state.aiExtras.events = []

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
    buildExtrasContext: pulse.buildExtrasContext
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
