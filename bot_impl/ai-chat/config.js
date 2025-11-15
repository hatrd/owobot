const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const DEFAULT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const DEFAULT_PATH = process.env.DEEPSEEK_PATH || '/v1/chat/completions'
const DEFAULT_RECENT_COUNT = (() => {
  const raw = Number(process.env.AI_RECENT_COUNT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 32
})()
const DEFAULT_MEMORY_STORE_MAX = (() => {
  const raw = Number(process.env.AI_MEMORY_STORE_MAX)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200
})()

function buildDefaultContext () {
  return {
    include: true,
    recentCount: DEFAULT_RECENT_COUNT,
    recentWindowSec: 300,
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
      storeMax: DEFAULT_MEMORY_STORE_MAX
    }
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE,
  DEFAULT_PATH,
  DEFAULT_RECENT_COUNT,
  DEFAULT_MEMORY_STORE_MAX,
  buildDefaultContext
}
