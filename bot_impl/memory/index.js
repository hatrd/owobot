// Durable evidence, independent of chat provider. Protection records are never evicted.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { validRecord } = require('./contract')
const clone = x => JSON.parse(JSON.stringify(x))
function createStore (state, file, worldId) {
  const s = state.knowledge ||= { document: null, error: null }
  if (!s.document) {
    s.document = { version: 1, worldId, revision: 0, records: [] }
    try {
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('knowledge_file_too_large')
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (doc.version !== 1 || doc.worldId !== worldId || !Number.isInteger(doc.revision) || !Array.isArray(doc.records) || doc.records.length > 2000 || !doc.records.every(validRecord) || new Set(doc.records.map(r => r.id)).size !== doc.records.length) throw new Error('invalid_knowledge_document')
      s.document = doc
    } catch (e) { if (e.code !== 'ENOENT') s.error = e.message }
  }
  if (s.document.worldId !== worldId) s.error = 'knowledge_world_mismatch'
  function write (op, args) {
    if (s.error) return { ok: false, error: 'knowledge_unavailable', detail: s.error }
    const doc = clone(s.document)
    const index = doc.records.findIndex(r => r.id === args.id)
    if (op === 'knowledge.put') {
      if (!validRecord(args)) return { ok: false, error: 'invalid_knowledge_record' }
      if (index < 0 && doc.records.length >= 2000) return { ok: false, error: 'knowledge_capacity' }
      const row = { ...clone(args), createdAt: index < 0 ? Date.now() : doc.records[index].createdAt, updatedAt: Date.now() }
      if (index < 0) doc.records.push(row); else doc.records[index] = row
    } else if (op === 'knowledge.remove') {
      if (index < 0) return { ok: false, error: 'knowledge_not_found' }
      doc.records.splice(index, 1)
    } else return { ok: false, error: 'unknown_knowledge_operation' }
    doc.revision++; doc.savedAt = Date.now()
    const encoded = JSON.stringify(doc)
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) return { ok: false, error: 'knowledge_capacity' }
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(tmp, 'wx', 0o600)
      try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, file)
      s.document = doc
      return { ok: true, id: args.id, revision: doc.revision }
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch {}
      s.error = e.message
      return { ok: false, error: 'knowledge_save_failed', detail: e.message }
    }
  }
  function query (args = {}) {
    const rows = s.document.records.filter(r => ['id', 'kind', 'subject', 'dimension'].every(k => args[k] === undefined || args[k] === r[k])).sort((a, b) => b.updatedAt - a.updatedAt)
    return { ok: !s.error, error: s.error, worldId, revision: s.document.revision, total: rows.length, records: clone(rows.slice(args.offset || 0, (args.offset || 0) + (args.max || 10))).map(r => ({ ...r, stale: !!r.expiresAt && r.expiresAt < Date.now() })) }
  }
  return { query, write }
}
function install (bot, { state, on, registerCleanup, log }) {
  const worldId = state.explorationMemory.worldId
  const api = createStore(state, path.resolve('data', `knowledge-${worldId}.json`), worldId)
  state.knowledgeApi = api
  function rememberPlayer (username, content) {
    if (!username || username === bot.username) return
    const player = bot.players?.[username]
    const subject = player?.uuid || username
    const id = `player:encounters:${subject}`
    const previous = api.query({ id }).records?.[0]
    let observations = []
    try { observations = JSON.parse(previous?.fact || '{}').observations || [] } catch {}
    const at = Date.now()
    observations.push({ at, event: content === undefined ? 'seen' : 'chat', ...(content === undefined ? {} : { quote: String(content).slice(0, 240) }) })
    const result = api.write('knowledge.put', { id, kind: 'player', subject, fact: JSON.stringify({ username, uuid: player?.uuid || null, observations: observations.slice(-10) }), source: 'minecraft.player_events', confidence: 'observed' })
    if (!result.ok) log?.error?.('player memory', result)
  }
  on('playerJoined', player => rememberPlayer(player.username))
  on('chat', (username, content) => rememberPlayer(username, content))
  registerCleanup(() => { if (state.knowledgeApi === api) state.knowledgeApi = null })
  return api
}
function read (bot, args = {}) {
  const result = bot.state?.knowledgeApi?.query(args) || { ok: false, error: 'knowledge_unavailable' }
  return { ...result, msg: result.ok ? 'Durable world and player evidence' : result.error, data: result }
}
module.exports = { install, createStore, read }
