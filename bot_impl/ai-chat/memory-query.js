function normalizeText (text) {
  if (typeof text !== 'string') return ''
  try { return text.normalize('NFKC').replace(/\s+/g, ' ').trim() } catch { return text.replace(/\s+/g, ' ').trim() }
}

function normalizeName (name) {
  const n = normalizeText(name)
  return n ? n.slice(0, 40) : ''
}

function normalizeWorldHint (worldHint) {
  if (!worldHint || typeof worldHint !== 'object') return ''
  const pos = worldHint.position && typeof worldHint.position === 'object' ? worldHint.position : worldHint
  const x = Number(pos.x)
  const y = Number(pos.y)
  const z = Number(pos.z)
  if (![x, y, z].every(Number.isFinite)) return ''
  const dimRaw = worldHint.dim || worldHint.dimension || worldHint.world || pos.dim || pos.dimension
  const dim = typeof dimRaw === 'string' && dimRaw.trim() ? normalizeText(dimRaw).toLowerCase() : ''
  const label = `${Math.round(x)},${Math.round(y)},${Math.round(z)}`
  return dim ? `${label} ${dim}` : label
}

function buildMemoryQuery ({ username, message, recentChat, worldHint } = {}) {
  const user = normalizeName(username)
  const msg = normalizeText(message)
  const userKey = user ? user.toLowerCase() : ''

  const lines = Array.isArray(recentChat) ? recentChat : []
  const myLines = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const name = normalizeName(line.user || line.username || line.name || '')
    if (!name) continue
    if (userKey && name.toLowerCase() !== userKey) continue
    const text = normalizeText(line.text || line.content || '')
    if (!text) continue
    myLines.push(text)
  }

  const tail = myLines.slice(-2)
  const parts = [user, msg, ...tail].filter(Boolean)
  return parts.join(' | ')
}

module.exports = { buildMemoryQuery }
