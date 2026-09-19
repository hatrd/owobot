const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const clone = x => JSON.parse(JSON.stringify(x))
const { distance } = require('./terrain')
const limits = { missions: 16, visits: 2048, landmarks: 512, attempts: 128 }
const validPosition = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
function validDocument (doc, worldId) {
  return doc?.version === 1 && doc.worldId === worldId && Number.isInteger(doc.revision) &&
    Object.entries(limits).every(([key, max]) => Array.isArray(doc[key]) && doc[key].length <= max) &&
    doc.missions.every(m => typeof m?.id === 'string' && typeof m.objective === 'string' && typeof m.dimension === 'string' && validPosition(m.home) && Number.isFinite(m.maxRadius) && ['active', 'paused'].includes(m.status) && validPosition(m.checkpoint?.position)) &&
    doc.visits.every(v => typeof v?.key === 'string' && typeof v.dimension === 'string' && validPosition(v.position) && Number.isFinite(v.count)) &&
    doc.landmarks.every(v => typeof v?.key === 'string' && typeof v.dimension === 'string' && ['entity', 'sign'].includes(v.kind) && validPosition(v.position) && Number.isFinite(v.observedAt)) &&
    doc.attempts.every(a => typeof a?.taskId === 'string' && typeof a.dimension === 'string' && ['succeeded', 'failed', 'canceled'].includes(a.status) && (!a.target || validPosition(a.target)))
}

function createStore ({ state, file, worldId, now = Date.now }) {
  const runtime = state.explorationMemory ||= { file, worldId, document: null, error: null, savedAt: null }
  if (runtime.worldId !== worldId) throw new Error('exploration_world_mismatch')
  if (!runtime.document) {
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('exploration_file_too_large')
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!validDocument(parsed, worldId)) throw new Error('invalid_exploration_document')
      runtime.document = parsed
      runtime.savedAt = parsed.savedAt || null
      for (const mission of parsed.missions) if (mission.status === 'active') { mission.status = 'paused'; mission.reason = 'process_restarted' }
    } catch (error) {
      if (error.code !== 'ENOENT') runtime.error = String(error.message || error)
      // Do not overwrite a corrupt or foreign file with an empty successful memory.
      runtime.document = { version: 1, worldId, revision: 0, missions: [], visits: [], landmarks: [], attempts: [] }
    }
  }
  function commit (edit) {
    const transaction = async () => {
      if (runtime.error) return { ok: false, error: 'memory_unavailable', detail: runtime.error }
      const next = clone(runtime.document)
      const result = edit(next)
      if (result?.ok === false) return result
      next.revision++
      next.savedAt = now()
      for (const [key, max] of Object.entries(limits)) if (next[key].length > max) next[key].splice(0, next[key].length - max)
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        const fd = await fs.promises.open(tmp, 'wx', 0o600)
        try { await fd.writeFile(JSON.stringify(next)); await fd.sync() } finally { await fd.close() }
        await fs.promises.rename(tmp, file)
        runtime.document = next
        runtime.savedAt = now()
        return { ok: true, ...result, revision: next.revision }
      } catch (error) {
        try { await fs.promises.unlink(tmp) } catch {}
        runtime.error = String(error.message || error)
        return { ok: false, error: 'memory_save_failed', detail: runtime.error }
      }
    }
    const operation = (runtime.pending || Promise.resolve()).then(transaction, transaction)
    runtime.pending = operation.then(() => undefined, () => undefined)
    return operation
  }
  function begin ({ objective, maxRadius, pose }) {
    return commit(doc => {
      if (doc.missions.some(m => m.status === 'active')) return { ok: false, error: 'mission_active' }
      const mission = { id: randomUUID(), objective, dimension: pose.dimension, home: pose.position, maxRadius, status: 'active', createdAt: now(), updatedAt: now(), checkpoint: pose }
      doc.missions.push(mission)
      return { mission: clone(mission) }
    })
  }
  function change (id, status, reason) {
    return commit(doc => {
      const mission = doc.missions.find(m => m.id === id)
      if (!mission) return { ok: false, error: 'mission_not_found' }
      if (status === 'active' && doc.missions.some(m => m.id !== id && m.status === 'active')) return { ok: false, error: 'mission_active' }
      Object.assign(mission, { status, reason, updatedAt: now() })
      return { mission: clone(mission) }
    })
  }
  function checkpoint ({ missionId, pose, landmarks = [], attempt = null }) {
    return commit(doc => {
      const mission = doc.missions.find(m => m.id === missionId)
      if (!mission) return { ok: false, error: 'mission_not_found' }
      if (pose.dimension !== mission.dimension) return { ok: false, error: 'mission_dimension_mismatch' }
      if (!mission.checkpoint?.at || pose.at >= mission.checkpoint.at) mission.checkpoint = clone(pose)
      mission.updatedAt = now()
      const key = `${pose.dimension}:${Math.floor(pose.position.x / 2)},${Math.floor(pose.position.y)},${Math.floor(pose.position.z / 2)}`
      const index = doc.visits.findIndex(v => v.key === key)
      const previous = index < 0 ? null : doc.visits.splice(index, 1)[0]
      doc.visits.push({ key, dimension: pose.dimension, position: pose.position, count: (previous?.count || 0) + 1, firstSeen: previous?.firstSeen ?? now(), lastSeen: now(), vitals: pose.vitals })
      for (const landmark of landmarks) {
        const old = doc.landmarks.findIndex(l => l.key === landmark.key && l.dimension === pose.dimension)
        if (old >= 0) doc.landmarks.splice(old, 1)
        doc.landmarks.push({ ...clone(landmark), dimension: pose.dimension, observedAt: now() })
      }
      if (attempt && !doc.attempts.some(a => a.taskId === attempt.taskId)) doc.attempts.push({ ...clone(attempt), dimension: pose.dimension, at: now() })
      return { missionId, checkpoint: clone(pose) }
    })
  }
  function recall ({ pose, radius = 128, max = 8 }) {
    const doc = runtime.document
    const nearby = list => list.filter(v => v.dimension === pose.dimension && distance(v.position, pose.position) <= radius).sort((a, b) => distance(a.position, pose.position) - distance(b.position, pose.position)).slice(0, max)
    return { ok: !runtime.error, error: runtime.error, worldId, revision: doc.revision, savedAt: runtime.savedAt, limits,
      missions: clone(doc.missions.slice(-4)),
      visits: clone(nearby(doc.visits)),
      landmarks: nearby(doc.landmarks).map(l => ({ ...clone(l), stale: now() - l.observedAt > (l.kind === 'entity' ? 60000 : 86400000) })),
      attempts: clone(doc.attempts.filter(a => a.dimension === pose.dimension).slice(-max)),
      counts: Object.fromEntries(Object.keys(limits).map(key => [key, doc[key].length]))
    }
  }
  return { begin, change, checkpoint, recall, document: () => runtime.document, error: () => runtime.error }
}
module.exports = { createStore, limits }
