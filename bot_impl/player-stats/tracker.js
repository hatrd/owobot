const dm = require('./data-manager')

// Death message patterns (English and Chinese)
const DEATH_PATTERNS = [
  // English patterns
  /^(\w+) was slain by/,
  /^(\w+) was shot by/,
  /^(\w+) was pummeled by/,
  /^(\w+) was fireballed by/,
  /^(\w+) was killed by/,
  /^(\w+) was blown up/,
  /^(\w+) was squashed/,
  /^(\w+) was impaled/,
  /^(\w+) fell from/,
  /^(\w+) hit the ground too hard/,
  /^(\w+) fell off/,
  /^(\w+) fell out of/,
  /^(\w+) was doomed to fall/,
  /^(\w+) drowned/,
  /^(\w+) suffocated/,
  /^(\w+) was squished/,
  /^(\w+) burned to death/,
  /^(\w+) was burnt to a crisp/,
  /^(\w+) went up in flames/,
  /^(\w+) tried to swim in lava/,
  /^(\w+) discovered the floor was lava/,
  /^(\w+) walked into fire/,
  /^(\w+) starved to death/,
  /^(\w+) was pricked to death/,
  /^(\w+) walked into a cactus/,
  /^(\w+) withered away/,
  /^(\w+) was struck by lightning/,
  /^(\w+) froze to death/,
  /^(\w+) experienced kinetic energy/,
  /^(\w+) didn't want to live/,
  /^(\w+) died/,
  // Chinese patterns
  /^(\w+) 被.*杀死/,
  /^(\w+) 被.*射杀/,
  /^(\w+) 被.*炸死/,
  /^(\w+) 摔死了/,
  /^(\w+) 掉落致死/,
  /^(\w+) 淹死了/,
  /^(\w+) 窒息而死/,
  /^(\w+) 烧死了/,
  /^(\w+) 在火中丧生/,
  /^(\w+) 试图在岩浆中游泳/,
  /^(\w+) 饿死了/,
  /^(\w+) 被仙人掌扎死/,
  /^(\w+) 凋零致死/,
  /^(\w+) 被闪电击中/,
  /^(\w+) 冻死了/,
  /^(\w+) 死了/
]

// Prefixes that indicate a command, not a chat message
const COMMAND_PREFIXES = ['.', '/', '!', ':']

function createTracker (bot, state, log) {
  const sessions = state.playerStats.activeSessions

  function resolveUUID (player) {
    if (!player) return null
    if (typeof player === 'string') {
      const rec = bot.players && bot.players[player]
      return rec?.uuid || null
    }
    return player.uuid || null
  }

  function resolveName (player) {
    if (!player) return null
    if (typeof player === 'string') return player
    return player.username || player.name || null
  }

  function onPlayerJoin (player) {
    try {
      const uuid = resolveUUID(player)
      const name = resolveName(player)
      if (!uuid || !name) return
      if (name === bot.username) return

      // Create or update player data file
      dm.getOrCreatePlayerData(uuid, name)

      // Start session tracking
      sessions.set(uuid, {
        name,
        joinedAt: Date.now(),
        messages: 0,
        deaths: 0
      })

      if (log?.info) log.info(`[STATS] Player joined: ${name} (${uuid})`)
    } catch (err) {
      if (log?.warn) log.warn('[STATS] onPlayerJoin error:', err?.message || err)
    }
  }

  function onPlayerLeave (player) {
    try {
      const uuid = resolveUUID(player)
      const name = resolveName(player)
      if (!uuid) return
      if (name === bot.username) return

      const session = sessions.get(uuid)
      if (!session) return

      // Calculate session duration
      const duration = Date.now() - session.joinedAt

      // Persist to file
      persistSession(uuid, session.name, duration, session.messages, session.deaths)

      // Remove session
      sessions.delete(uuid)

      if (log?.info) {
        const mins = Math.floor(duration / 60000)
        log.info(`[STATS] Player left: ${name} (online ${mins}m, ${session.messages} msgs, ${session.deaths} deaths)`)
      }
    } catch (err) {
      if (log?.warn) log.warn('[STATS] onPlayerLeave error:', err?.message || err)
    }
  }

  function persistSession (uuid, name, durationMs, messages, deaths) {
    try {
      const data = dm.getOrCreatePlayerData(uuid, name)
      const todayKey = dm.getTodayKey()

      // Update total stats
      data.stats.totalOnlineMs += durationMs
      data.stats.totalMessages += messages
      data.stats.totalDeaths += deaths
      data.stats.lastSeen = Date.now()

      // Update daily stats
      if (!data.daily) data.daily = {}
      if (!data.daily[todayKey]) {
        data.daily[todayKey] = { onlineMs: 0, messages: 0, deaths: 0 }
      }
      data.daily[todayKey].onlineMs += durationMs
      data.daily[todayKey].messages += messages
      data.daily[todayKey].deaths += deaths

      dm.savePlayerData(uuid, data)
    } catch (err) {
      if (log?.warn) log.warn('[STATS] persistSession error:', err?.message || err)
    }
  }

  function isValidMessage (msg) {
    if (!msg || typeof msg !== 'string') return false
    const trimmed = msg.trim()
    if (trimmed.length < 2) return false
    for (const prefix of COMMAND_PREFIXES) {
      if (trimmed.startsWith(prefix)) return false
    }
    return true
  }

  function onChat (username, message) {
    try {
      if (!username || username === bot.username) return
      if (!isValidMessage(message)) return

      const rec = bot.players && bot.players[username]
      const uuid = rec?.uuid
      if (!uuid) return

      const session = sessions.get(uuid)
      if (session) {
        session.messages++
      } else {
        // Player not in active session, update file directly
        const data = dm.findPlayerByName(username)
        if (data) {
          const todayKey = dm.getTodayKey()
          if (!data.daily) data.daily = {}
          if (!data.daily[todayKey]) {
            data.daily[todayKey] = { onlineMs: 0, messages: 0, deaths: 0 }
          }
          data.daily[todayKey].messages++
          data.stats.totalMessages++
          dm.savePlayerData(data.uuid, data)
        }
      }
    } catch (err) {
      if (log?.warn) log.warn('[STATS] onChat error:', err?.message || err)
    }
  }

  function extractPlainText (message) {
    if (!message) return ''
    if (typeof message === 'string') return message
    if (typeof message.toString === 'function') {
      const str = message.toString()
      // Remove color codes
      return str.replace(/\u00a7[0-9a-fk-or]/gi, '').trim()
    }
    return ''
  }

  function onMessage (message) {
    try {
      const plain = extractPlainText(message)
      if (!plain) return

      for (const pattern of DEATH_PATTERNS) {
        const match = plain.match(pattern)
        if (match && match[1]) {
          const deadPlayer = match[1]
          if (deadPlayer === bot.username) continue

          const rec = bot.players && bot.players[deadPlayer]
          const uuid = rec?.uuid

          if (uuid) {
            const session = sessions.get(uuid)
            if (session) {
              session.deaths++
              if (log?.info) log.info(`[STATS] Death detected: ${deadPlayer}`)
            } else {
              // Update file directly
              const data = dm.findPlayerByName(deadPlayer)
              if (data) {
                const todayKey = dm.getTodayKey()
                if (!data.daily) data.daily = {}
                if (!data.daily[todayKey]) {
                  data.daily[todayKey] = { onlineMs: 0, messages: 0, deaths: 0 }
                }
                data.daily[todayKey].deaths++
                data.stats.totalDeaths++
                dm.savePlayerData(data.uuid, data)
                if (log?.info) log.info(`[STATS] Death detected (offline session): ${deadPlayer}`)
              }
            }
          }
          break
        }
      }
    } catch (err) {
      if (log?.warn) log.warn('[STATS] onMessage error:', err?.message || err)
    }
  }

  function flushAll () {
    try {
      const now = Date.now()
      for (const [uuid, session] of sessions.entries()) {
        const duration = now - session.joinedAt
        persistSession(uuid, session.name, duration, session.messages, session.deaths)
        // Reset session counters but keep joinedAt as now
        session.joinedAt = now
        session.messages = 0
        session.deaths = 0
      }
      state.playerStats.lastFlushAt = now
      if (log?.info) log.info(`[STATS] Flushed ${sessions.size} active sessions`)
    } catch (err) {
      if (log?.warn) log.warn('[STATS] flushAll error:', err?.message || err)
    }
  }

  function initExistingPlayers () {
    try {
      const players = bot.players || {}
      for (const [name, rec] of Object.entries(players)) {
        if (!rec || name === bot.username) continue
        const uuid = rec.uuid
        if (!uuid) continue
        if (!sessions.has(uuid)) {
          dm.getOrCreatePlayerData(uuid, name)
          sessions.set(uuid, {
            name,
            joinedAt: Date.now(),
            messages: 0,
            deaths: 0
          })
        }
      }
      if (log?.info) log.info(`[STATS] Initialized ${sessions.size} existing players`)
    } catch (err) {
      if (log?.warn) log.warn('[STATS] initExistingPlayers error:', err?.message || err)
    }
  }

  return {
    onPlayerJoin,
    onPlayerLeave,
    onChat,
    onMessage,
    flushAll,
    initExistingPlayers,
    sessions
  }
}

module.exports = { createTracker }
