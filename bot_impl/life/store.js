const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { validate } = require('./contract')
const clone = value => JSON.parse(JSON.stringify(value))
const validPosition = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
// Small bounded journal. Commit before publishing state; errors fail closed.
function createStore ({ state, file, worldId, now = Date.now }) {
  const s = state.life ||= { document: null, error: null, runtime: null }
  if (!s.document) {
    s.document = { version: 1, worldId, revision: 0, enabled: false, home: null, maxRadius: 32, wanderIntervalMs: 20000, feedCooldownMs: 600000, feedAttempts: [], visits: [], failures: [] }
    try {
      if (fs.statSync(file).size > 128 * 1024) throw new Error('life_file_too_large')
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      const config = { maxRadius: doc.maxRadius, wanderIntervalMs: doc.wanderIntervalMs, feedCooldownMs: doc.feedCooldownMs }
      if (doc.version !== 1 || doc.worldId !== worldId || typeof doc.enabled !== 'boolean' || !Number.isInteger(doc.revision) || !validate('enable', config).ok ||
        (doc.home !== null && (!validPosition(doc.home) || typeof doc.home.dimension !== 'string')) || (doc.enabled && !doc.home) ||
        !['feedAttempts', 'visits', 'failures'].every(k => Array.isArray(doc[k]) && doc[k].length <= 64) ||
        !doc.feedAttempts.every(r => typeof r.uuid === 'string' && Number.isFinite(r.at)) ||
        ![...doc.visits, ...doc.failures].every(r => validPosition(r.position) && typeof r.dimension === 'string' && Number.isFinite(r.at))) throw new Error('invalid_life_document')
      s.document = doc
    } catch (error) { if (error.code !== 'ENOENT') s.error = error.message }
  }
  if (s.document.worldId !== worldId) s.error = 'life_world_mismatch'
  function commit (edit) {
    if (s.error) return { ok: false, error: 'life_storage_unavailable', detail: s.error }
    const next = clone(s.document)
    edit(next)
    next.revision++; next.savedAt = now()
    for (const key of ['feedAttempts', 'visits', 'failures']) next[key] = next[key].slice(-64)
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(tmp, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, file)
      s.document = next
      return { ok: true }
    } catch (error) {
      try { fs.unlinkSync(tmp) } catch {}
      s.error = error.message
      return { ok: false, error: 'life_save_failed', detail: s.error }
    }
  }
  return { document: () => s.document, error: () => s.error, commit }
}
module.exports = { createStore }
