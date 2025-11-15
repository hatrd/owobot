function prepareAiState (state, opts = {}) {
  const {
    defaults,
    persistedMemory,
    trimConversationStore: trimConversationStoreFn,
    updateWorldMemoryZones,
    now,
    dayStart,
    monthStart
  } = opts
  const {
    DEFAULT_MODEL,
    DEFAULT_BASE,
    DEFAULT_PATH,
    DEFAULT_RECENT_COUNT
  } = defaults
  state.ai = state.ai || {
    enabled: true,
    key: process.env.DEEPSEEK_API_KEY || null,
    baseUrl: DEFAULT_BASE,
    path: DEFAULT_PATH,
    model: DEFAULT_MODEL,
    maxReplyLen: 240,
    limits: null,
    currency: (process.env.AI_CURRENCY || 'USD'),
    priceInPerKT: parseFloat(process.env.AI_PRICE_IN_PER_KT || '0'),
    priceOutPerKT: parseFloat(process.env.AI_PRICE_OUT_PER_KT || '0'),
    budgetDay: null,
    budgetMonth: null,
    budgetTotal: null,
    maxTokensPerCall: 512,
    notifyOnBudget: true,
    context: { include: true, recentCount: DEFAULT_RECENT_COUNT, recentWindowSec: 300, recentStoreMax: 200 },
    trace: false
  }
  const DEF_CTX = {
    include: true,
    recentCount: DEFAULT_RECENT_COUNT,
    recentWindowSec: 300,
    recentStoreMax: 200,
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
  if (!state.ai.context.userRecentOverride && (!Number.isFinite(state.ai.context.recentCount) || state.ai.context.recentCount < DEFAULT_RECENT_COUNT)) {
    state.ai.context.recentCount = DEFAULT_RECENT_COUNT
  }

  state.aiPulse = state.aiPulse || { enabled: false, lastFlushAt: Date.now(), lastReason: null, lastMessage: null }
  if (!Number.isFinite(state.aiPulse.lastFlushAt)) state.aiPulse.lastFlushAt = Date.now()
  if (!(state.aiPulse.recentKeys instanceof Map)) state.aiPulse.recentKeys = new Map()
  if (!Number.isFinite(state.aiPulse.lastMessageAt)) state.aiPulse.lastMessageAt = 0
  if (!(state.aiPulse.pendingByUser instanceof Map)) {
    const restored = new Map()
    if (state.aiPulse.pendingByUser && typeof state.aiPulse.pendingByUser === 'object') {
      for (const [name, info] of Object.entries(state.aiPulse.pendingByUser)) {
        if (!info) continue
        const count = Number(info.count) || 0
        const lastAt = Number(info.lastAt) || 0
        if (count > 0) restored.set(name, { count, lastAt })
      }
    }
    state.aiPulse.pendingByUser = restored
  }
  if (!Number.isFinite(state.aiPulse.totalPending)) state.aiPulse.totalPending = 0
  state.aiPulse.pendingSince = Number.isFinite(state.aiPulse.pendingSince) ? state.aiPulse.pendingSince : null
  state.aiPulse.pendingLastAt = Number.isFinite(state.aiPulse.pendingLastAt) ? state.aiPulse.pendingLastAt : null
  if (!Number.isFinite(state.aiPulse.lastSeq)) state.aiPulse.lastSeq = 0
  if (!(state.aiPulse.activeUsers instanceof Map)) state.aiPulse.activeUsers = new Map()

  state.aiExtras = state.aiExtras || { events: [] }
  if (!Array.isArray(state.aiExtras.events)) state.aiExtras.events = []
  if (!Array.isArray(state.aiDialogues)) state.aiDialogues = []

  if (!state.aiRecentReplies || !(state.aiRecentReplies instanceof Map)) state.aiRecentReplies = new Map()

  if (!Array.isArray(state.aiDialogues) || state.aiDialogues.length === 0) {
    state.aiDialogues = Array.isArray(persistedMemory.dialogues) ? persistedMemory.dialogues : []
  }
  if (typeof trimConversationStoreFn === 'function') trimConversationStoreFn()

  state.aiRecent = Array.isArray(state.aiRecent) ? state.aiRecent : []
  if (!Number.isFinite(state.aiRecentSeq)) state.aiRecentSeq = 0
  for (const entry of state.aiRecent) {
    if (!entry || typeof entry !== 'object') continue
    if (Number.isFinite(entry.seq)) {
      state.aiRecentSeq = Math.max(state.aiRecentSeq, entry.seq)
    } else {
      state.aiRecentSeq += 1
      entry.seq = state.aiRecentSeq
    }
  }
  state.aiPulse.lastSeq = state.aiRecentSeq
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
  if (typeof updateWorldMemoryZones === 'function') updateWorldMemoryZones()
  state.aiStats = state.aiStats || { perUser: new Map(), global: [] }
  state.aiSpend = state.aiSpend || {
    day: { start: dayStart(), inTok: 0, outTok: 0, cost: 0 },
    month: { start: monthStart(), inTok: 0, outTok: 0, cost: 0 },
    total: { inTok: 0, outTok: 0, cost: 0 }
  }
}

module.exports = { prepareAiState }
