function getListedPlayerEntries (bot) {
  const players = bot && bot.players ? bot.players : {}
  return Object.entries(players).filter(([, rec]) => rec?.listed !== false)
}

function normalizeUsername (name) {
  return String(name || '').replace(/\u00a7./g, '').trim().toLowerCase()
}

function hasListedSelf (bot, entries) {
  const selfKey = normalizeUsername(bot && bot.username)
  if (!selfKey) return false
  const list = Array.isArray(entries) ? entries : getListedPlayerEntries(bot)
  for (const [name, rec] of list) {
    const username = String(rec?.username || name || '')
    if (normalizeUsername(username) === selfKey) return true
  }
  return false
}

module.exports = {
  getListedPlayerEntries,
  hasListedSelf
}
