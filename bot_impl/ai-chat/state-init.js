const DAY_WINDOW_SHIFT_HOURS = 4
const { ensureEmbeddingStoreStats } = require('./cache-stats')

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
    DEFAULT_TIMEOUT_MS,
    DEFAULT_RECENT_COUNT,
    DEFAULT_RECENT_WINDOW_SEC,
    DEFAULT_MEMORY_STORE_MAX,
    buildDefaultContext
  } = defaults
  const resolveContext = typeof buildDefaultContext === 'function'
    ? buildDefaultContext
    : () => ({
        include: true,
        recentCount: DEFAULT_RECENT_COUNT,
        recentWindowSec: DEFAULT_RECENT_WINDOW_SEC,
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
    maxTokensPerCall: 1024,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notifyOnBudget: true,
    trace: false
  }
  if (typeof state.ai.listenEnabled !== 'boolean') state.ai.listenEnabled = true
  if (!Number.isFinite(state.ai.timeoutMs) || state.ai.timeoutMs <= 0) state.ai.timeoutMs = DEFAULT_TIMEOUT_MS
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
  const legacyWindowSec = 300
  if (!state.ai.context.userWindowOverride &&
    (!Number.isFinite(state.ai.context.recentWindowSec) || state.ai.context.recentWindowSec === legacyWindowSec)) {
    state.ai.context.recentWindowSec = DEFAULT_RECENT_WINDOW_SEC
  }

  state.aiPulse = state.aiPulse || { lastFlushAt: Date.now(), lastReason: null, lastMessageAt: 0 }
  if (!Number.isFinite(state.aiPulse.lastFlushAt)) state.aiPulse.lastFlushAt = Date.now()
  if (!Number.isFinite(state.aiPulse.lastMessageAt)) state.aiPulse.lastMessageAt = 0
  if (!(state.aiPulse.activeUsers instanceof Map)) state.aiPulse.activeUsers = new Map()
  // Legacy: proactive pulse removed, scrub unused fields to keep state minimal across hot reloads.
  for (const k of ['enabled', 'recentKeys', 'pendingByUser', 'totalPending', 'pendingSince', 'pendingLastAt', 'lastSeq', 'lastMessage']) {
    try { delete state.aiPulse[k] } catch {}
  }
  try {
    if (state.aiPulse._timer) {
      try { clearInterval(state.aiPulse._timer) } catch {}
      state.aiPulse._timer = null
    }
  } catch {}

  state.aiSay = state.aiSay || { seq: 0 }
  if (!Number.isFinite(state.aiSay.seq)) state.aiSay.seq = 0
  if (!(state.aiSay.activeByUser instanceof Map)) state.aiSay.activeByUser = new Map()

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
  ensureEmbeddingStoreStats(state)
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
