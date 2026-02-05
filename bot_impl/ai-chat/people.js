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
  function parseFloatClamped (value, fallback, min, max) {
    if (value == null) return fallback
    const n = Number.parseFloat(String(value))
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  }

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

  function buildBigrams (text) {
    const s = String(text || '')
    if (!s) return null
    const chars = Array.from(s)
    if (chars.length < 2) return null
    const set = new Set()
    for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1])
    return set
  }

  function longestCommonSubstringLen (a, b, limit = 140) {
    const as = String(a || '')
    const bs = String(b || '')
    if (!as || !bs) return 0
    const aChars = Array.from(as.slice(0, limit))
    const bChars = Array.from(bs.slice(0, limit))
    if (aChars.length < 2 || bChars.length < 2) return 0
    const dp = new Array(bChars.length + 1).fill(0)
    let best = 0
    for (let i = 1; i <= aChars.length; i++) {
      let prev = 0
      for (let j = 1; j <= bChars.length; j++) {
        const tmp = dp[j]
        if (aChars[i - 1] === bChars[j - 1]) {
          dp[j] = prev + 1
          if (dp[j] > best) best = dp[j]
        } else {
          dp[j] = 0
        }
        prev = tmp
      }
    }
    return best
  }

  function overlapStats (a, b) {
    if (!a || !b) return { hits: 0, denom: 0, coeff: 0 }
    const aSize = a.size || 0
    const bSize = b.size || 0
    const denom = Math.min(aSize, bSize)
    if (!denom) return { hits: 0, denom: 0, coeff: 0 }
    const [small, big] = aSize <= bSize ? [a, b] : [b, a]
    let hit = 0
    for (const x of small) {
      if (big.has(x)) hit++
    }
    return { hits: hit, denom, coeff: hit / denom }
  }

  function isSimilarAction (aKey, bKey, aBigrams, bBigrams, { minContainLen = 4, threshold = 0.72, minOverlapHits = 4, minCommonSubstrLen = 14 } = {}) {
    if (!aKey || !bKey) return false
    if (aKey === bKey) return true
    if (aKey.length >= minContainLen && bKey.includes(aKey)) return true
    if (bKey.length >= minContainLen && aKey.includes(bKey)) return true
    if (minCommonSubstrLen > 1) {
      const minLen = Math.min(aKey.length, bKey.length)
      if (minLen >= minCommonSubstrLen) {
        if (longestCommonSubstringLen(aKey, bKey) >= minCommonSubstrLen) return true
      }
    }
    if (!aBigrams || !bBigrams) return false
    const st = overlapStats(aBigrams, bBigrams)
    if (st.hits < minOverlapHits) return false
    return st.coeff >= threshold
  }

  function chooseRepresentative (a, b, keep) {
    if (!a) return b
    if (!b) return a
    const aAction = typeof a.action === 'string' ? a.action : ''
    const bAction = typeof b.action === 'string' ? b.action : ''
    const aLen = aAction.length
    const bLen = bAction.length
    const aTs = Number(a.updatedAt) || Number(a.createdAt) || 0
    const bTs = Number(b.updatedAt) || Number(b.createdAt) || 0

    if (keep === 'latest') {
      if (aTs !== bTs) return aTs >= bTs ? a : b
      if (aLen !== bLen) return aLen <= bLen ? a : b
      return a
    }
    if (keep === 'longest') {
      if (aLen !== bLen) return aLen >= bLen ? a : b
      if (aTs !== bTs) return aTs >= bTs ? a : b
      return a
    }
    // shortest (default)
    if (aLen !== bLen) return aLen <= bLen ? a : b
    if (aTs !== bTs) return aTs >= bTs ? a : b
    return a
  }

  function dedupeCommitments ({
    mode = 'pending',
    player,
    match,
    keep = 'shortest',
    threshold = 0.72,
    minOverlapHits = 4,
    minCommonSubstrLen = 14,
    persist: shouldPersist = true,
    previewLimit = 12
  } = {}) {
    load()
    const slice = ensureState()
    if (!slice) return { ok: false, reason: 'no_state' }

    const supportedMode = new Set(['pending', 'closed', 'all'])
    const chosenMode = String(mode || '').trim().toLowerCase() || 'pending'
    if (!supportedMode.has(chosenMode)) return { ok: false, reason: 'bad_mode' }

    const keepMode = String(keep || '').trim().toLowerCase() || 'shortest'
    const keepSupported = new Set(['shortest', 'longest', 'latest'])
    const chosenKeep = keepSupported.has(keepMode) ? keepMode : 'shortest'

    const th = parseFloatClamped(threshold, 0.72, 0.4, 0.98)
    const minHits = Math.max(1, Math.min(20, Number.parseInt(String(minOverlapHits), 10) || 4))
    const minLcs = Math.max(0, Math.min(60, Number.parseInt(String(minCommonSubstrLen), 10) || 10))
    const playerNeedle = foldKey(player || '')
    const matchNeedle = String(match || '').trim().toLowerCase()

    const raw = safeArray(slice.commitments)
    const before = raw.length

    const candidates = []
    for (let i = 0; i < raw.length; i++) {
      const rec = raw[i]
      if (!rec || typeof rec !== 'object') continue
      const name = normalizeName(rec.player || rec.name || rec.playerName || rec.playerKey || '')
      const resolvedKey = resolveKey(slice.profiles, name) || normalizeKey(rec.playerKey || name)
      const playerKey = resolvedKey || normalizeKey(name)
      const action = typeof rec.action === 'string' ? rec.action.replace(/\s+/g, ' ').trim() : ''
      if (!playerKey || !action) continue
      const status = normalizeCommitmentStatus(rec.status)
      if (chosenMode === 'pending' && status !== 'pending') continue
      if (chosenMode === 'closed' && status === 'pending') continue
      if (playerNeedle && foldKey(playerKey) !== playerNeedle && foldKey(name) !== playerNeedle) continue
      if (matchNeedle && !action.toLowerCase().includes(matchNeedle)) continue

      const actionKey = normalizeActionKey(action)
      const bigrams = actionKey && actionKey.length >= 4 ? buildBigrams(actionKey) : null
      candidates.push({
        idx: i,
        rec,
        player: name || normalizeName(playerKey),
        playerKey,
        action,
        actionKey,
        bigrams,
        status,
        createdAt: Number(rec.createdAt) || null,
        updatedAt: Number(rec.updatedAt) || null
      })
    }

    if (candidates.length < 2) {
      return {
        ok: true,
        changed: false,
        before,
        after: before,
        removed: 0,
        kept: candidates.length,
        previewRemoved: [],
        previewKept: candidates.slice(0, previewLimit).map(x => `${x.playerKey}：${x.action}`)
      }
    }

    const byPlayer = new Map()
    for (const it of candidates) {
      const key = foldKey(it.playerKey) || foldKey(it.player) || ''
      if (!key) continue
      if (!byPlayer.has(key)) byPlayer.set(key, [])
      byPlayer.get(key).push(it)
    }

    const keptIdx = new Set()
    const removedIdx = new Set()

    for (const items of byPlayer.values()) {
      items.sort((a, b) => {
        const at = Number(a.updatedAt) || Number(a.createdAt) || 0
        const bt = Number(b.updatedAt) || Number(b.createdAt) || 0
        return bt - at
      })

      const clusters = []
      for (const item of items) {
        let matched = null
        for (const c of clusters) {
          const rep = c.rep
          if (isSimilarAction(item.actionKey, rep.actionKey, item.bigrams, rep.bigrams, { threshold: th, minOverlapHits: minHits, minCommonSubstrLen: minLcs })) {
            matched = c
            break
          }
        }
        if (!matched) {
          clusters.push({ rep: item, members: [item] })
          continue
        }

        matched.members.push(item)
        matched.rep = chooseRepresentative(matched.rep, item, chosenKeep)
      }

      for (const c of clusters) {
        keptIdx.add(c.rep.idx)
        for (const m of c.members) {
          if (m.idx !== c.rep.idx) removedIdx.add(m.idx)
        }
      }
    }

    if (!removedIdx.size) {
      return {
        ok: true,
        changed: false,
        before,
        after: before,
        removed: 0,
        kept: keptIdx.size,
        previewRemoved: [],
        previewKept: candidates.slice(0, previewLimit).map(x => `${x.playerKey}：${x.action}`)
      }
    }

    const next = raw.filter((_, idx) => !removedIdx.has(idx))
    const after = next.length
    const changed = after !== before

    const persisted = (() => {
      if (!changed) return false
      if (!shouldPersist) return false
      slice.commitments = next
      return persist()
    })()

    const previewRemoved = []
    const previewKept = []
    for (const it of candidates) {
      if (removedIdx.has(it.idx) && previewRemoved.length < previewLimit) {
        previewRemoved.push(`${it.playerKey}：${it.action}`)
      } else if (!removedIdx.has(it.idx) && previewKept.length < previewLimit) {
        previewKept.push(`${it.playerKey}：${it.action}`)
      }
      if (previewRemoved.length >= previewLimit && previewKept.length >= previewLimit) break
    }

    return {
      ok: true,
      changed,
      before,
      after,
      removed: removedIdx.size,
      kept: candidates.length - removedIdx.size,
      persisted,
      mode: chosenMode,
      keep: chosenKeep,
      threshold: th,
      previewRemoved,
      previewKept
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
    dedupeCommitments,
    applyPatch,
    dumpForLLM,
    debugTrace
  }
}

module.exports = { createPeopleService }
