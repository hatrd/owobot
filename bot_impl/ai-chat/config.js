const DEFAULT_MODEL = process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const DEFAULT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const DEFAULT_PATH = process.env.DEEPSEEK_PATH || '/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AI_TIMEOUT_MS || process.env.DEEPSEEK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25000
})()
const DEFAULT_RECENT_COUNT = (() => {
  const raw = Number(process.env.AI_RECENT_COUNT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50
})()
const DEFAULT_RECENT_WINDOW_SEC = (() => {
  const raw = Number(process.env.AI_RECENT_WINDOW_SEC)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return 24 * 60 * 60
})()
const DEFAULT_MEMORY_STORE_MAX = (() => {
  const raw = Number(process.env.AI_MEMORY_STORE_MAX)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200
})()

function buildDefaultContext () {
  return {
    include: true,
    recentCount: DEFAULT_RECENT_COUNT,
    recentWindowSec: DEFAULT_RECENT_WINDOW_SEC,
    recentStoreMax: 200,
    game: {
      include: true,
      nearPlayerRange: 16,
      nearPlayerMax: 5,
      dropsRange: 8,
      dropsMax: 6,
      invTop: 20
    },
    memory: {
      include: true,
      max: 6,
      storeMax: DEFAULT_MEMORY_STORE_MAX,
      mode: 'keyword',
      // v2/hybrid thresholds: prefer empty over noisy fallback
      minScore: 0.3,
      minRelevance: 0.06,
      // v2/hybrid scoring weights
      wRelevance: 0.6,
      wRecency: 0.2,
      wImportance: 0.2,
      // v2/hybrid scoring knobs
      recencyHalfLifeDays: 14,
      relevanceScale: 18,
      importanceCountSaturation: 20
    }
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE,
  DEFAULT_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_COUNT,
  DEFAULT_RECENT_WINDOW_SEC,
  DEFAULT_MEMORY_STORE_MAX,
  buildDefaultContext
}
