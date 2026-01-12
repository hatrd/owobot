function rotateRecentIfNeeded (state, lastEntry) {
  if (!state || typeof state !== 'object') return
  const cs = state.ai?.context || {}
  const recentMax = Math.max(20, cs.recentStoreMax || 200)
  if (!Array.isArray(state.aiRecent) || state.aiRecent.length <= recentMax) return
  const active = state.aiPulse?.activeUsers
  if (active instanceof Map && active.size > 0) return
  state.aiRecent = lastEntry ? [lastEntry] : []
}

function pushRecentChatEntry (state, username, text, kind = 'player', meta = {}, opts = {}) {
  if (!state || typeof state !== 'object') return null
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const requireExisting = opts.requireExisting === true
  const contextBus = opts.contextBus || null

  if (!Array.isArray(state.aiRecent)) {
    if (requireExisting) return null
    state.aiRecent = []
  }
  if (!Number.isFinite(state.aiRecentSeq)) state.aiRecentSeq = 0
  state.aiRecentSeq += 1
  const entry = { t: now(), user: username || '??', text: trimmed.slice(0, 160), kind, seq: state.aiRecentSeq }
  state.aiRecent.push(entry)
  rotateRecentIfNeeded(state, entry)

  if (contextBus) {
    if (kind === 'player') contextBus.pushPlayer(username, trimmed)
    else if (kind === 'bot') {
      const from = String(meta?.from || '').trim()
      if (from && typeof contextBus.pushBotFrom === 'function') contextBus.pushBotFrom(trimmed, from)
      else contextBus.pushBot(trimmed)
    }
  }

  return entry
}

module.exports = { rotateRecentIfNeeded, pushRecentChatEntry }
