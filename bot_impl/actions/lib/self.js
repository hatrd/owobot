function entityUuid (entity) {
  try { return entity?.uuid || entity?._uuid || null } catch { return null }
}

function isSameEntity (a, b) {
  try {
    if (!a || !b) return false
    if (a === b) return true
    if (a.id != null && b.id != null && a.id === b.id) return true
    const au = entityUuid(a)
    const bu = entityUuid(b)
    if (au && bu && String(au) === String(bu)) return true
    return false
  } catch {
    return false
  }
}

function isSelfEntity (bot, entity) {
  try {
    if (!bot?.entity || !entity) return false
    return isSameEntity(entity, bot.entity)
  } catch {
    return false
  }
}

function normalizeExactName (name) {
  return String(name || '').trim()
}

function resolvePlayerEntityExact (bot, name) {
  try {
    const wanted = normalizeExactName(name)
    if (!wanted) return null
    const rec = bot?.players?.[wanted]
    if (rec?.entity) return rec.entity
    const wantedLower = wanted.toLowerCase()
    if (wantedLower) {
      for (const [uname, entry] of Object.entries(bot?.players || {})) {
        try {
          if (!uname) continue
          if (String(uname).toLowerCase() !== wantedLower) continue
          if (entry?.entity) return entry.entity
        } catch {}
      }
    }
    for (const e of Object.values(bot?.entities || {})) {
      try {
        if (!e || e.type !== 'player') continue
        const un = e.username || e.name || null
        if (un === wanted) return e
        if (wantedLower && un && String(un).toLowerCase() === wantedLower) return e
      } catch {}
    }
    return null
  } catch {
    return null
  }
}

module.exports = { isSameEntity, isSelfEntity, resolvePlayerEntityExact }
