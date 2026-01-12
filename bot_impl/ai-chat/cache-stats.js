function ensureEmbeddingStoreStats (state) {
  if (!state || typeof state !== 'object') return null
  if (!state.aiCacheStats || typeof state.aiCacheStats !== 'object') state.aiCacheStats = {}
  if (!state.aiCacheStats.embeddingStore || typeof state.aiCacheStats.embeddingStore !== 'object') {
    state.aiCacheStats.embeddingStore = { lookups: 0, hits: 0, misses: 0 }
  }
  const s = state.aiCacheStats.embeddingStore
  if (!Number.isFinite(s.lookups)) s.lookups = 0
  if (!Number.isFinite(s.hits)) s.hits = 0
  if (!Number.isFinite(s.misses)) s.misses = 0
  return s
}

function snapshotEmbeddingStore (state) {
  const s = ensureEmbeddingStoreStats(state)
  return {
    lookups: Number(s?.lookups) || 0,
    hits: Number(s?.hits) || 0,
    misses: Number(s?.misses) || 0
  }
}

function buildEmbeddingStoreHitRateLine ({ before, after, username, phase }) {
  const b = before || { lookups: 0, hits: 0, misses: 0 }
  const a = after || { lookups: 0, hits: 0, misses: 0 }
  const reqLookups = Math.max(0, (a.lookups || 0) - (b.lookups || 0))
  const reqHits = Math.max(0, (a.hits || 0) - (b.hits || 0))
  const reqRate = reqLookups > 0 ? ((reqHits / reqLookups) * 100).toFixed(1) : null
  const totalRate = (a.lookups || 0) > 0 ? (((a.hits || 0) / a.lookups) * 100).toFixed(1) : null
  const who = String(username || '').trim()
  const tag = phase ? String(phase) : 'callAI'
  return (
    `[ai-cache] embeddingStore ${tag}` +
    (who ? ` user=${who}` : '') +
    ` req=${reqRate == null ? 'n/a' : `${reqRate}%`} (${reqHits}/${reqLookups})` +
    ` total=${totalRate == null ? 'n/a' : `${totalRate}%`} (${a.hits || 0}/${a.lookups || 0})`
  )
}

function logEmbeddingStoreHitRate ({ log, state, before, after, username, phase }) {
  if (!log?.info) return
  const b = before || snapshotEmbeddingStore(state)
  const a = after || snapshotEmbeddingStore(state)
  try { log.info(buildEmbeddingStoreHitRateLine({ before: b, after: a, username, phase })) } catch {}
}

module.exports = {
  ensureEmbeddingStoreStats,
  snapshotEmbeddingStore,
  buildEmbeddingStoreHitRateLine,
  logEmbeddingStoreHitRate
}

