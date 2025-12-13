const dm = require('./data-manager')

// Score weights: 1 minute online = 1 point, 1 message = 1 point
const WEIGHTS = {
  onlineMinute: 1,
  message: 1,
  death: 0  // Deaths don't affect score
}

function calculateScore (dailyStats) {
  if (!dailyStats) return 0
  const minutes = Math.floor((dailyStats.onlineMs || 0) / 60000)
  const messages = dailyStats.messages || 0
  return minutes * WEIGHTS.onlineMinute + messages * WEIGHTS.message
}

function selectDailyStar (dateKey) {
  const players = dm.getAllPlayersData()
  let best = null
  let bestScore = -1

  for (const player of players) {
    if (!player.daily || !player.daily[dateKey]) continue
    const dailyStats = player.daily[dateKey]
    const score = calculateScore(dailyStats)
    if (score > bestScore) {
      bestScore = score
      best = {
        uuid: player.uuid,
        name: player.lastKnownName,
        score,
        breakdown: {
          onlineMinutes: Math.floor((dailyStats.onlineMs || 0) / 60000),
          messages: dailyStats.messages || 0,
          deaths: dailyStats.deaths || 0
        }
      }
    }
  }

  return best
}

function recordDailyStar (dateKey, star) {
  if (!star) return false
  try {
    const data = dm.loadDailyStars()
    if (!data.stars) data.stars = []

    // Check if already recorded for this date
    const existing = data.stars.find(s => s.date === dateKey)
    if (existing) return false

    data.stars.push({
      date: dateKey,
      uuid: star.uuid,
      name: star.name,
      score: star.score,
      breakdown: star.breakdown,
      announcedAt: Date.now()
    })

    // Keep only last 365 entries
    if (data.stars.length > 365) {
      data.stars = data.stars.slice(-365)
    }

    dm.saveDailyStars(data)

    // Add achievement to player
    const playerData = dm.loadPlayerData(star.uuid)
    if (playerData) {
      if (!playerData.achievements) playerData.achievements = []
      const achievement = `今日之星(${dateKey})`
      if (!playerData.achievements.includes(achievement)) {
        playerData.achievements.push(achievement)
        dm.savePlayerData(star.uuid, playerData)
      }
    }

    return true
  } catch {
    return false
  }
}

function getRecentStars (limit = 5) {
  try {
    const data = dm.loadDailyStars()
    if (!data.stars || !data.stars.length) return []
    return data.stars.slice(-limit).reverse()
  } catch {
    return []
  }
}

function getStarByDate (dateKey) {
  try {
    const data = dm.loadDailyStars()
    if (!data.stars) return null
    return data.stars.find(s => s.date === dateKey) || null
  } catch {
    return null
  }
}

function getMsUntilMidnight () {
  const now = new Date()
  // Calculate Shanghai midnight
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const shanghai = new Date(utc + 8 * 3600000)

  // Next midnight in Shanghai
  const tomorrow = new Date(shanghai)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

  // Convert back to local time
  const tomorrowUtc = tomorrow.getTime() - 8 * 3600000
  const tomorrowLocal = tomorrowUtc - now.getTimezoneOffset() * 60000

  return Math.max(0, tomorrowLocal - now.getTime())
}

function scheduleDailyAnnouncement (bot, state, log, tracker) {
  function doAnnouncement () {
    try {
      // Flush all active sessions first
      if (tracker && typeof tracker.flushAll === 'function') {
        tracker.flushAll()
      }

      const yesterdayKey = dm.getYesterdayKey()
      const star = selectDailyStar(yesterdayKey)

      if (star && star.score > 0) {
        const recorded = recordDailyStar(yesterdayKey, star)
        if (recorded) {
          const msg = `[昨日之星] 恭喜 ${star.name}！在线 ${star.breakdown.onlineMinutes} 分钟，发言 ${star.breakdown.messages} 条，死亡 ${star.breakdown.deaths} 次，活跃度 ${star.score} 分！`
          try { bot.chat(msg) } catch {}
          if (log?.info) log.info(`[STATS] Daily star announced: ${star.name} (${star.score} points)`)
        }
      } else {
        if (log?.info) log.info(`[STATS] No daily star for ${yesterdayKey} (no activity)`)
      }
    } catch (err) {
      if (log?.warn) log.warn('[STATS] Daily announcement error:', err?.message || err)
    }

    // Schedule next announcement
    const ms = getMsUntilMidnight()
    state.playerStats.dailyStarTimer = setTimeout(doAnnouncement, ms + 1000) // Add 1s buffer
    if (log?.info) log.info(`[STATS] Next daily star in ${Math.floor(ms / 60000)} minutes`)
  }

  // Initial schedule
  const ms = getMsUntilMidnight()
  state.playerStats.dailyStarTimer = setTimeout(doAnnouncement, ms + 1000)
  if (log?.info) log.info(`[STATS] Daily star scheduled in ${Math.floor(ms / 60000)} minutes`)
}

function cancelDailyAnnouncement (state) {
  if (state.playerStats?.dailyStarTimer) {
    clearTimeout(state.playerStats.dailyStarTimer)
    state.playerStats.dailyStarTimer = null
  }
}

module.exports = {
  calculateScore,
  selectDailyStar,
  recordDailyStar,
  getRecentStars,
  getStarByDate,
  getMsUntilMidnight,
  scheduleDailyAnnouncement,
  cancelDailyAnnouncement,
  WEIGHTS
}
