const DAY_WINDOW_SHIFT_HOURS = 4

function startOfHour (ts) {
  const d = new Date(ts)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

function startOfDailyWindow (ts) {
  const d = new Date(ts)
  d.setHours(DAY_WINDOW_SHIFT_HOURS, 0, 0, 0)
  if (ts < d.getTime()) d.setDate(d.getDate() - 1)
  return d.getTime()
}

function startOfWeeklyWindow (ts) {
  const dayStart = startOfDailyWindow(ts)
  const d = new Date(dayStart)
  const day = d.getDay() === 0 ? 7 : d.getDay()
  d.setDate(d.getDate() - (day - 1))
  return d.getTime()
}

function earliestTierTimestamp (entries, tier) {
  if (!Array.isArray(entries)) return null
  let minTs = Infinity
  for (const entry of entries) {
    if (!entry || (tier && entry.tier !== tier)) continue
    const ts = Number(entry.endedAt ?? entry.startedAt)
    if (!Number.isFinite(ts)) continue
    if (ts < minTs) minTs = ts
  }
  return Number.isFinite(minTs) ? minTs : null
}

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
    DEFAULT_RECENT_COUNT,
    DEFAULT_MEMORY_STORE_MAX,
    buildDefaultContext
  } = defaults
  const resolveContext = typeof buildDefaultContext === 'function'
    ? buildDefaultContext
    : () => ({
        include: true,
        recentCount: DEFAULT_RECENT_COUNT,
        recentWindowSec: 300,
        recentStoreMax: 200,
        game: { include: true, nearPlayerRange: 16, nearPlayerMax: 5, dropsRange: 8, dropsMax: 6, invTop: 20 },
      memory: { include: true, max: 6, storeMax: DEFAULT_MEMORY_STORE_MAX || 200 }
      })
  const DEF_CTX = resolveContext()
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
    trace: false
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
  if (!state.aiDialogueBuckets || typeof state.aiDialogueBuckets !== 'object') state.aiDialogueBuckets = {}
  const nowTs = Date.now()
  const rawTs = earliestTierTimestamp(state.aiDialogues, 'raw') || nowTs
  if (!Number.isFinite(state.aiDialogueBuckets.hourlyEnd)) state.aiDialogueBuckets.hourlyEnd = startOfHour(rawTs)
  const hourTs = earliestTierTimestamp(state.aiDialogues, 'hour') || rawTs
  if (!Number.isFinite(state.aiDialogueBuckets.dailyEnd)) state.aiDialogueBuckets.dailyEnd = startOfDailyWindow(hourTs)
  const dayTs = earliestTierTimestamp(state.aiDialogues, 'day') || hourTs
  if (!Number.isFinite(state.aiDialogueBuckets.weeklyEnd)) state.aiDialogueBuckets.weeklyEnd = startOfWeeklyWindow(dayTs)
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
  if (typeof state.aiMemory.storeMax !== 'number') state.aiMemory.storeMax = state.ai.context?.memory?.storeMax || DEFAULT_MEMORY_STORE_MAX || 200
  if (!Array.isArray(state.aiMemory.queue)) state.aiMemory.queue = []
  if (!Array.isArray(state.worldMemoryZones)) state.worldMemoryZones = []
  if (typeof updateWorldMemoryZones === 'function') updateWorldMemoryZones()
  state.aiStats = state.aiStats || { perUser: new Map(), global: [] }
  state.aiSpend = state.aiSpend || {
    day: { start: dayStart(), inTok: 0, outTok: 0, cost: 0 },
    month: { start: monthStart(), inTok: 0, outTok: 0, cost: 0 },
    total: { inTok: 0, outTok: 0, cost: 0 }
  }

  // --- REFS: 反馈系统状态初始化 ---
  const persistedEvolution = opts.persistedEvolution || {}
  const persistedRecentSignals = Array.isArray(persistedEvolution.recentFeedback)
    ? persistedEvolution.recentFeedback
    : []

  // 反馈收集状态
  state.aiFeedback = state.aiFeedback || {
    windows: new Map(),
    stats: {
      positive: persistedEvolution.feedbackStats?.positive || 0,
      negative: persistedEvolution.feedbackStats?.negative || 0,
      actionSuccess: persistedEvolution.feedbackStats?.actionSuccess || 0,
      actionFail: persistedEvolution.feedbackStats?.actionFail || 0
    },
    recentSignals: persistedRecentSignals.slice(-100),
    lastWindowId: null
  }
  if (!(state.aiFeedback.windows instanceof Map)) state.aiFeedback.windows = new Map()
  if (!Array.isArray(state.aiFeedback.recentSignals)) state.aiFeedback.recentSignals = []

  // 人格特质状态
  const defaultTraits = { playfulness: 0.7, helpfulness: 0.8, curiosity: 0.6, assertiveness: 0.4, emotionality: 0.5 }
  state.aiPersonality = state.aiPersonality || {
    traits: { ...defaultTraits, ...(persistedEvolution.personality?.traits || {}) },
    modifiers: { ...(persistedEvolution.personality?.modifiers || {}) },
    lastAdjustment: persistedEvolution.personality?.lastAdjustment || null
  }

  // 情感状态
  state.aiEmotionalState = state.aiEmotionalState || {
    current: persistedEvolution.emotionalState?.current || 'content',
    intensity: persistedEvolution.emotionalState?.intensity ?? 0.5,
    lastUpdate: persistedEvolution.emotionalState?.lastUpdate || nowTs,
    triggers: []
  }
  if (!Array.isArray(state.aiEmotionalState.triggers)) state.aiEmotionalState.triggers = []

  // 自省历史
  state.aiIntrospection = state.aiIntrospection || {
    history: Array.isArray(persistedEvolution.introspectionHistory) ? persistedEvolution.introspectionHistory : [],
    lastRun: persistedEvolution.lastIntrospection || null,
    consecutiveNegative: 0
  }
}

module.exports = { prepareAiState }
