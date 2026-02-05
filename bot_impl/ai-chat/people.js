const { randomUUID } = require('crypto')

function normalizeName (name) {
  return String(name || '').replace(/\u00a7./g, '').trim().slice(0, 40)
}

function safeArray (value) {
  return Array.isArray(value) ? value : []
}

function safeObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function normalizeKey (name) {
  return normalizeName(name)
}

function foldKey (name) {
  const clean = normalizeKey(name)
  return clean ? clean.toLowerCase() : ''
}

function resolveKey (profiles, player) {
  const haystack = safeObject(profiles)
  const needle = foldKey(player)
  if (!needle) return ''
  for (const k of Object.keys(haystack)) {
    if (!k) continue
    if (foldKey(k) === needle) return k
    const rec = haystack[k]
    const recName = normalizeName(rec?.name || rec?.player || '')
    if (recName && foldKey(recName) === needle) return k
  }
  return ''
}

function pickPreferredProfile (a, b) {
  const aRec = a && typeof a === 'object' ? a : {}
  const bRec = b && typeof b === 'object' ? b : {}
  const aText = typeof aRec.profile === 'string' ? aRec.profile.trim() : ''
  const bText = typeof bRec.profile === 'string' ? bRec.profile.trim() : ''
  if (aText && !bText) return aRec
  if (bText && !aText) return bRec
  const aUpdatedAt = Number(aRec.updatedAt) || 0
  const bUpdatedAt = Number(bRec.updatedAt) || 0
  if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt > bUpdatedAt ? aRec : bRec
  return aRec
}

function migrateProfiles (rawProfiles) {
  const profiles = safeObject(rawProfiles)
  const out = {}
  const index = new Map() // fold -> key
  let changed = false

  for (const [rawKey, rawVal] of Object.entries(profiles)) {
    const rec = rawVal && typeof rawVal === 'object' ? rawVal : {}
    const name = normalizeName(rec.name || rec.player || rawKey)
    const desiredKey = normalizeKey(name || rawKey)
    if (!desiredKey) continue
    const folded = foldKey(desiredKey)
    if (!folded) continue

    const normalized = { ...rec, name: name || desiredKey }
    if (rawKey !== desiredKey) changed = true

    const existingKey = index.get(folded)
    if (!existingKey) {
      out[desiredKey] = normalized
      index.set(folded, desiredKey)
      continue
    }

    if (existingKey === desiredKey) {
      out[desiredKey] = pickPreferredProfile(out[desiredKey], normalized)
      continue
    }

    changed = true
    const existing = out[existingKey]
    const preferred = pickPreferredProfile(existing, normalized)
    if (preferred === existing) continue

    delete out[existingKey]
    out[desiredKey] = preferred
    index.set(folded, desiredKey)
  }

  return { profiles: out, changed }
}

function migrateCommitments (rawCommitments, profiles) {
  const list = safeArray(rawCommitments)
  const out = []
  const seen = new Map() // fold::action -> item
  let changed = false

  for (const item of list) {
    const rec = item && typeof item === 'object' ? item : null
    if (!rec) continue

    const player = normalizeName(rec.player || rec.name || rec.playerName || rec.playerKey || '')
    const playerKey = player ? (resolveKey(profiles, player) || player) : ''
    const action = typeof rec.action === 'string' ? rec.action.trim() : ''
    const status = normalizeCommitmentStatus(rec.status)

    const normalized = {
      ...rec,
      ...(player ? { player } : null),
      ...(playerKey ? { playerKey } : null),
      ...(action ? { action } : null),
      ...(status ? { status } : null)
    }

    if (player && typeof rec.player === 'string' && rec.player !== player) changed = true
    if (playerKey && typeof rec.playerKey === 'string' && rec.playerKey !== playerKey) changed = true
    if (action && typeof rec.action === 'string' && rec.action !== action) changed = true
    if (status && normalizeCommitmentStatus(rec.status) !== status) changed = true

    const foldPlayer = playerKey ? foldKey(playerKey) : foldKey(player)
    const foldAction = action ? action.toLowerCase() : (typeof rec.action === 'string' ? rec.action.trim().toLowerCase() : '')
    const dedupeKey = foldPlayer && foldAction ? `${foldPlayer}::${foldAction}` : ''
    if (!dedupeKey) { out.push(normalized); continue }

    const existing = seen.get(dedupeKey)
    if (!existing) {
      seen.set(dedupeKey, normalized)
      out.push(normalized)
      continue
    }

    changed = true
    const preferred = (() => {
      const a = existing
      const b = normalized
      const aUpdatedAt = Number(a.updatedAt) || 0
      const bUpdatedAt = Number(b.updatedAt) || 0
      if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt > bUpdatedAt ? a : b
      const aStatus = String(a.status || '').trim().toLowerCase()
      const bStatus = String(b.status || '').trim().toLowerCase()
      if (aStatus !== 'pending' && bStatus === 'pending') return a
      if (bStatus !== 'pending' && aStatus === 'pending') return b
      return a
    })()

    if (preferred === existing) continue
    seen.set(dedupeKey, preferred)
    const idx = out.indexOf(existing)
    if (idx >= 0) out[idx] = preferred
  }

  return { commitments: out, changed }
}

function normalizeCommitmentStatus (raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (!v) return 'pending'
  if (['pending', 'todo', 'open', '未完成', '待办', '待做', '进行中'].includes(v)) return 'pending'
  if (['done', 'fulfilled', 'complete', 'completed', 'ok', '完成', '已完成', '搞定', '做到了', '完成了'].includes(v)) return 'done'
  if (['failed', 'fail', 'canceled', 'cancelled', 'abandoned', '失败', '没做到', '未做到', '取消', '放弃'].includes(v)) return 'failed'
  if (['ongoing', 'active', '长期', '长期有效', '持续', '永久', '永远'].includes(v)) return 'ongoing'
  if (v.includes('完成')) return 'done'
  if (v.includes('失败') || v.includes('取消') || v.includes('放弃')) return 'failed'
  if (v.includes('永远') || v.includes('永久') || v.includes('长期')) return 'ongoing'
  return 'pending'
}

function createPeopleService ({ state, peopleStore, now = () => Date.now(), trace = () => {} } = {}) {
  function escapeXml (value) {
    const s = String(value == null ? '' : value)
    if (!s) return ''
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

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

    const profMig = migrateProfiles(slice.profiles)
    const comMig = migrateCommitments(slice.commitments, profMig.profiles)
    if (profMig.changed) slice.profiles = profMig.profiles
    if (comMig.changed) slice.commitments = comMig.commitments
    if ((profMig.changed || comMig.changed) && peopleStore && typeof peopleStore.save === 'function') {
      try {
        peopleStore.save({ profiles: slice.profiles, commitments: slice.commitments })
      } catch {}
    }
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
    const lines = [
      '<people>',
      '<!-- profiles -->'
    ]
    for (const it of items) {
      const name = escapeXml(it.name || '')
      const profile = escapeXml(it.profile || '')
      if (!name || !profile) continue
      lines.push(`<profile n="${name}">${profile}</profile>`)
    }
    lines.push('</people>')
    return lines.length > 3 ? lines.join('\n') : ''
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

    const existingKey = resolveKey(slice.profiles, key)
    if (existingKey && existingKey !== key) {
      try {
        slice.profiles[key] = slice.profiles[existingKey]
        delete slice.profiles[existingKey]
      } catch {}
    }

    slice.profiles[key] = {
      name,
      profile: text,
      updatedAt: now(),
      source: typeof source === 'string' ? source.slice(0, 40) : null
    }
    if (shouldPersist) persist()
    return { ok: true, key }
  }

  function normalizeActionKey (text) {
    const s = String(text || '')
    if (!s) return ''
    try {
      return s.normalize('NFKC')
        .replace(/\s+/g, ' ')
        .replace(/[，。！？、,.!?\u00b7'"“”‘’`~@#$%^&*()_+\-=[\]{}\\|;:/<>]/g, '')
        .trim()
        .toLowerCase()
    } catch {
      return s.replace(/\s+/g, ' ').trim().toLowerCase()
    }
  }

  function upsertCommitment ({ id, player, action, status, deadlineMs, source, persist: shouldPersist = true } = {}) {
    load()
    const slice = ensureState()
    if (!slice) return { ok: false, reason: 'no_state' }
    const name = normalizeName(player)
    const playerKey = resolveKey(slice.profiles, name) || normalizeKey(name)
    const act = typeof action === 'string' ? action.replace(/\s+/g, ' ').trim() : ''
    if (!playerKey || !act) return { ok: false, reason: 'empty' }

    const st = normalizeCommitmentStatus(status)
    const nowTs = now()
    const list = safeArray(slice.commitments)
    const wantedId = (typeof id === 'string' && id.trim()) ? id.trim() : ''
    const needle = `${foldKey(playerKey)}::${act.toLowerCase()}`
    const actKey = normalizeActionKey(act)
    let existing = null
    if (wantedId) {
      for (const c of list) {
        if (!c || typeof c !== 'object') continue
        if (typeof c.id === 'string' && c.id === wantedId) { existing = c; break }
      }
    }
    if (!existing) {
      for (const c of list) {
        if (!c || typeof c !== 'object') continue
        const k = foldKey(c.playerKey || c.player || c.name || '')
        const a = typeof c.action === 'string' ? c.action.trim().toLowerCase() : ''
        if (!k || !a) continue
        if (`${k}::${a}` === needle) { existing = c; break }
      }
    }
    if (!existing && actKey) {
      for (const c of list) {
        if (!c || typeof c !== 'object') continue
        const k = foldKey(c.playerKey || c.player || c.name || '')
        if (k !== foldKey(playerKey)) continue
        const aRaw = typeof c.action === 'string' ? c.action.trim() : ''
        const aKey = normalizeActionKey(aRaw)
        if (!aKey) continue
        const aStatus = normalizeCommitmentStatus(c.status)
        if (aStatus !== 'pending' && st === 'pending') continue
        if (aKey === actKey || aKey.includes(actKey) || actKey.includes(aKey)) { existing = c; break }
      }
    }
    if (!existing) {
      const id = (() => {
        if (wantedId) return wantedId
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

    if (wantedId && typeof existing.id !== 'string') existing.id = wantedId
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
      const id = c.id
      const player = c.player || c.name
      const action = c.action || c.text
      const status = c.status
      const deadlineMs = c.deadlineMs ?? c.deadline_ms ?? c.deadline
      const res = upsertCommitment({ id, player, action, status, deadlineMs, source, persist: false })
      if (res.ok) changed = true
    }

    if (changed) {
      persist()
    }
    return { ok: true, changed }
  }

  function dumpForLLM () {
    const profiles = listProfiles().map(p => ({ player: p.name, profile: p.profile }))
    const commitments = listCommitments().map(c => ({
      ...(c.id ? { id: c.id } : null),
      player: c.player,
      action: c.action,
      status: c.status,
      ...(Number.isFinite(c.deadlineMs) ? { deadlineMs: c.deadlineMs } : null)
    }))
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
