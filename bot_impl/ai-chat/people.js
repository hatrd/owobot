const { randomUUID } = require('crypto')

function normalizeName (name) {
  return String(name || '').replace(/\u00a7./g, '').trim().slice(0, 40)
}

function normalizeKey (name) {
  const clean = normalizeName(name)
  return clean ? clean.toLowerCase() : ''
}

function safeArray (value) {
  return Array.isArray(value) ? value : []
}

function safeObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function normalizeCommitmentStatus (raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (!v) return 'pending'
  if (['pending', 'todo', 'open'].includes(v)) return 'pending'
  if (['done', 'fulfilled', 'complete', 'completed'].includes(v)) return 'done'
  if (['failed', 'fail', 'canceled', 'cancelled', 'abandoned'].includes(v)) return 'failed'
  return 'pending'
}

function createPeopleService ({ state, peopleStore, now = () => Date.now(), trace = () => {} } = {}) {
  function ensureState () {
    if (!state || typeof state !== 'object') return null
    if (!state.aiPeople || typeof state.aiPeople !== 'object') state.aiPeople = {}
    const slice = state.aiPeople
    if (!slice.profiles || typeof slice.profiles !== 'object' || Array.isArray(slice.profiles)) slice.profiles = {}
    if (!Array.isArray(slice.commitments)) slice.commitments = []
    if (typeof slice._loaded !== 'boolean') slice._loaded = false
    return slice
  }

  function load () {
    const slice = ensureState()
    if (!slice) return
    if (slice._loaded) return
    if (!peopleStore || typeof peopleStore.load !== 'function') {
      slice._loaded = true
      return
    }
    const persisted = peopleStore.load()
    slice.profiles = safeObject(persisted?.profiles)
    slice.commitments = safeArray(persisted?.commitments)
    slice._loaded = true
  }

  function persist () {
    const slice = ensureState()
    if (!slice) return false
    if (!peopleStore || typeof peopleStore.save !== 'function') return false
    try {
      peopleStore.save({ profiles: slice.profiles, commitments: slice.commitments })
      return true
    } catch {
      return false
    }
  }

  function listProfiles () {
    load()
    const slice = ensureState()
    const profiles = safeObject(slice?.profiles)
    return Object.entries(profiles).map(([key, value]) => {
      const rec = value && typeof value === 'object' ? value : {}
      const name = normalizeName(rec.name || rec.player || key)
      const profile = typeof rec.profile === 'string' ? rec.profile.trim() : ''
      return { key, name: name || key, profile, updatedAt: Number(rec.updatedAt) || null }
    })
  }

  function buildAllProfilesContext () {
    const items = listProfiles().filter(p => p.profile).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    if (!items.length) return ''
    const lines = ['人物画像：']
    for (const it of items) {
      lines.push(`${it.name}：${it.profile}`)
    }
    return lines.join('\n')
  }

  function listCommitments () {
    load()
    const slice = ensureState()
    const items = safeArray(slice?.commitments)
    return items.map(c => {
      const rec = c && typeof c === 'object' ? c : {}
      const player = normalizeName(rec.player || rec.name || rec.playerName || rec.playerKey || '')
      const playerKey = normalizeKey(rec.playerKey || player)
      const action = typeof rec.action === 'string' ? rec.action.trim() : ''
      const status = normalizeCommitmentStatus(rec.status)
      const deadlineMs = Number.isFinite(rec.deadlineMs)
        ? rec.deadlineMs
        : (Number.isFinite(rec.deadline) ? rec.deadline : (Number.isFinite(rec.deadline_ms) ? rec.deadline_ms : null))
      const createdAt = Number.isFinite(rec.createdAt) ? rec.createdAt : null
      const updatedAt = Number.isFinite(rec.updatedAt) ? rec.updatedAt : null
      const id = typeof rec.id === 'string' ? rec.id : null
      return { id, player, playerKey, action, status, deadlineMs, createdAt, updatedAt }
    }).filter(c => c.playerKey && c.action)
  }

  function buildAllCommitmentsContext () {
    const items = listCommitments().filter(c => c.status === 'pending')
      .sort((a, b) => (a.player.localeCompare(b.player, 'zh')) || (a.action.localeCompare(b.action, 'zh')))
    if (!items.length) return ''
    const lines = ['承诺（未完成）：']
    for (const c of items) {
      lines.push(`${c.player}：${c.action}`)
    }
    return lines.join('\n')
  }

  function setProfile ({ player, profile, source, persist: shouldPersist = true } = {}) {
    load()
    const slice = ensureState()
    if (!slice) return { ok: false, reason: 'no_state' }
    const name = normalizeName(player)
    const key = normalizeKey(name)
    if (!key) return { ok: false, reason: 'empty_player' }
    const text = typeof profile === 'string' ? profile.replace(/\s+/g, ' ').trim() : ''
    slice.profiles[key] = {
      name,
      profile: text,
      updatedAt: now(),
      source: typeof source === 'string' ? source.slice(0, 40) : null
    }
    if (shouldPersist) persist()
    return { ok: true, key }
  }

  function upsertCommitment ({ player, action, status, deadlineMs, source, persist: shouldPersist = true } = {}) {
    load()
    const slice = ensureState()
    if (!slice) return { ok: false, reason: 'no_state' }
    const name = normalizeName(player)
    const playerKey = normalizeKey(name)
    const act = typeof action === 'string' ? action.replace(/\s+/g, ' ').trim() : ''
    if (!playerKey || !act) return { ok: false, reason: 'empty' }

    const st = normalizeCommitmentStatus(status)
    const nowTs = now()
    const list = safeArray(slice.commitments)
    const needle = `${playerKey}::${act.toLowerCase()}`
    let existing = null
    for (const c of list) {
      if (!c || typeof c !== 'object') continue
      const k = normalizeKey(c.playerKey || c.player || c.name || '')
      const a = typeof c.action === 'string' ? c.action.trim().toLowerCase() : ''
      if (!k || !a) continue
      if (`${k}::${a}` === needle) { existing = c; break }
    }
    if (!existing) {
      const id = (() => {
        try { return randomUUID() } catch { return `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }
      })()
      const rec = {
        id,
        player: name,
        playerKey,
        action: act,
        status: st,
        deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : null,
        createdAt: nowTs,
        updatedAt: nowTs,
        source: typeof source === 'string' ? source.slice(0, 40) : null
      }
      list.push(rec)
      slice.commitments = list
      if (shouldPersist) persist()
      return { ok: true, id }
    }

    existing.player = name
    existing.playerKey = playerKey
    existing.action = act
    existing.status = st
    existing.deadlineMs = Number.isFinite(deadlineMs) ? deadlineMs : (Number.isFinite(existing.deadlineMs) ? existing.deadlineMs : null)
    if (!Number.isFinite(existing.createdAt)) existing.createdAt = nowTs
    existing.updatedAt = nowTs
    existing.source = typeof source === 'string' ? source.slice(0, 40) : (existing.source || null)
    if (shouldPersist) persist()
    return { ok: true, id: existing.id || null }
  }

  function applyPatch ({ profiles, commitments, source } = {}) {
    load()
    const slice = ensureState()
    if (!slice) return { ok: false, reason: 'no_state' }
    const profArr = safeArray(profiles)
    const comArr = safeArray(commitments)
    let changed = false

    for (const p of profArr) {
      if (!p || typeof p !== 'object') continue
      const player = p.player || p.name
      const profile = p.profile ?? p.description ?? p.text
      if (typeof player !== 'string') continue
      if (typeof profile !== 'string') continue
      const res = setProfile({ player, profile, source, persist: false })
      if (res.ok) changed = true
    }

    for (const c of comArr) {
      if (!c || typeof c !== 'object') continue
      const player = c.player || c.name
      const action = c.action || c.text
      const status = c.status
      const deadlineMs = c.deadlineMs ?? c.deadline_ms ?? c.deadline
      const res = upsertCommitment({ player, action, status, deadlineMs, source, persist: false })
      if (res.ok) changed = true
    }

    if (changed) {
      persist()
    }
    return { ok: true, changed }
  }

  function dumpForLLM () {
    const profiles = listProfiles().map(p => ({ player: p.name, profile: p.profile }))
    const commitments = listCommitments().map(c => ({ player: c.player, action: c.action, status: c.status }))
    return { profiles, commitments }
  }

  function debugTrace (label, payload) {
    try { trace(label, payload) } catch {}
  }

  // Eager load once at creation so state is ready for injection.
  try { load() } catch {}

  return {
    load,
    persist,
    listProfiles,
    listCommitments,
    buildAllProfilesContext,
    buildAllCommitmentsContext,
    setProfile,
    upsertCommitment,
    applyPatch,
    dumpForLLM,
    debugTrace
  }
}

module.exports = { createPeopleService }
