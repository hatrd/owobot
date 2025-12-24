const dm = require('../../player-stats/data-manager')
const dailyStar = require('../../player-stats/daily-star')

module.exports = function registerStats (ctx) {
  const { bot, register, ok, fail } = ctx

  async function query_player_stats (args = {}) {
    const { name, period = 'all', type = 'all' } = args
    if (!name) return fail('缺少玩家名')

    const data = dm.findPlayerByName(name)
    if (!data) return fail(`未找到玩家: ${name}`)

    const isToday = period === 'today'
    const todayKey = dm.getTodayKey()

    if (isToday) {
      const daily = data.daily && data.daily[todayKey]
      if (!daily) return ok(`${data.lastKnownName} 今日无数据`)

      const mins = Math.floor((daily.onlineMs || 0) / 60000)
      const score = dailyStar.calculateScore(daily)

      if (type === 'online') {
        return ok(`${data.lastKnownName} 今日在线 ${mins} 分钟`)
      } else if (type === 'chat') {
        return ok(`${data.lastKnownName} 今日发言 ${daily.messages || 0} 条`)
      } else if (type === 'deaths') {
        return ok(`${data.lastKnownName} 今日死亡 ${daily.deaths || 0} 次`)
      } else {
        return ok(`${data.lastKnownName} 今日: 在线${mins}分钟, 发言${daily.messages || 0}条, 死亡${daily.deaths || 0}次, 活跃度${score}分`)
      }
    } else {
      const totalMins = Math.floor((data.stats.totalOnlineMs || 0) / 60000)
      const hours = Math.floor(totalMins / 60)
      const mins = totalMins % 60

      if (type === 'online') {
        return ok(`${data.lastKnownName} 总在线 ${hours}h${mins}m`)
      } else if (type === 'chat') {
        return ok(`${data.lastKnownName} 总发言 ${data.stats.totalMessages || 0} 条`)
      } else if (type === 'deaths') {
        return ok(`${data.lastKnownName} 总死亡 ${data.stats.totalDeaths || 0} 次`)
      } else {
        const achievements = data.achievements && data.achievements.length
          ? `, 成就: ${data.achievements.slice(-2).join(', ')}`
          : ''
        return ok(`${data.lastKnownName} 总计: 在线${hours}h${mins}m, 发言${data.stats.totalMessages || 0}条, 死亡${data.stats.totalDeaths || 0}次${achievements}`)
      }
    }
  }

  async function query_leaderboard (args = {}) {
    const {
      type = 'score',
      period = 'all',
      limit = 5,
      name,
      date,
      startDate,
      endDate
    } = args
    const players = dm.getAllPlayersData()
    if (!players.length) return ok('暂无玩家数据')

    const normalizedLimit = Math.min(Math.max(Number(limit) || 5, 1), 10)
    const targetName = name ? String(name).trim() : ''
    const targetLower = targetName.toLowerCase()

    function normalizeDateKey (input) {
      const raw = String(input || '').trim()
      if (!raw) return null
      const parts = raw.split('-')
      if (parts.length !== 3) return null
      const key = `${parts[0].padStart(4, '0')}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
      const ts = Date.parse(`${key}T00:00:00Z`)
      if (Number.isNaN(ts)) return null
      return key
    }

    function buildDateRange (startKey, endKey) {
      const start = Date.parse(`${startKey}T00:00:00Z`)
      const end = Date.parse(`${endKey}T00:00:00Z`)
      if (Number.isNaN(start) || Number.isNaN(end)) return null
      if (start > end) return null
      const keys = []
      const cursor = new Date(`${startKey}T00:00:00Z`)
      const final = new Date(`${endKey}T00:00:00Z`)
      while (cursor.getTime() <= final.getTime()) {
        const y = cursor.getUTCFullYear()
        const m = String(cursor.getUTCMonth() + 1).padStart(2, '0')
        const d = String(cursor.getUTCDate()).padStart(2, '0')
        keys.push(`${y}-${m}-${d}`)
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      }
      return keys
    }

    const periodToday = period === 'today'
    const periodYesterday = period === 'yesterday'
    const explicitDateKey = normalizeDateKey(date) || (periodYesterday ? dm.getYesterdayKey() : null)
    const todayKey = dm.getTodayKey()

    const startKey = normalizeDateKey(startDate)
    const endKey = normalizeDateKey(endDate)
    const rangeKeys = startKey || endKey
      ? buildDateRange(startKey || endKey, endKey || startKey)
      : null

    if ((startDate || endDate) && !rangeKeys) {
      return fail('日期范围格式错误，应为 YYYY-MM-DD，且开始日期不能晚于结束日期')
    }
    if (date && !explicitDateKey) {
      return fail('日期格式错误，应为 YYYY-MM-DD')
    }

    const entries = []

    for (const player of players) {
      let value = 0
      function valueFromDaily (daily) {
        switch (type) {
          case 'online':
            return Math.floor((daily.onlineMs || 0) / 60000)
          case 'chat':
            return daily.messages || 0
          case 'deaths':
            return daily.deaths || 0
          case 'score':
          default:
            return dailyStar.calculateScore(daily)
        }
      }

      if (rangeKeys) {
        for (const k of rangeKeys) {
          const daily = player.daily && player.daily[k]
          if (!daily) continue
          value += valueFromDaily(daily)
        }
      } else if (explicitDateKey || periodToday) {
        const dayKey = explicitDateKey || todayKey
        const daily = player.daily && player.daily[dayKey]
        if (!daily) continue
        value = valueFromDaily(daily)
      } else {
        switch (type) {
          case 'online':
            value = Math.floor((player.stats.totalOnlineMs || 0) / 60000)
            break
          case 'chat':
            value = player.stats.totalMessages || 0
            break
          case 'deaths':
            value = player.stats.totalDeaths || 0
            break
          case 'score':
          default: {
            const totalMins = Math.floor((player.stats.totalOnlineMs || 0) / 60000)
            value = totalMins * dailyStar.WEIGHTS.onlineMinute + (player.stats.totalMessages || 0) * dailyStar.WEIGHTS.message
          }
        }
      }
      if (value > 0) {
        entries.push({ name: player.lastKnownName, value })
      }
    }

    if (!entries.length) return ok('暂无数据')

    entries.sort((a, b) => b.value - a.value)
    const top = entries.slice(0, normalizedLimit)

    const typeLabel = {
      online: '在线',
      chat: '发言',
      deaths: '死亡',
      score: '活跃度'
    }[type] || '活跃度'
    const scopeLabel = (() => {
      if (rangeKeys && rangeKeys.length) return `${rangeKeys[0]}~${rangeKeys[rangeKeys.length - 1]}`
      if (explicitDateKey) return explicitDateKey
      if (periodToday) return '今日'
      if (periodYesterday) return '昨日'
      return '总'
    })()

    const lines = top.map((e, i) => `${i + 1}.${e.name}(${e.value})`).join(' ')
    const rankInfo = (() => {
      if (!targetLower) return ''
      const idx = entries.findIndex(e => String(e.name || '').toLowerCase() === targetLower)
      if (idx === -1) return `${targetName} 暂无数据`
      const player = entries[idx]
      return `${player.name} 排名${idx + 1}/${entries.length} (${player.value})`
    })()

    const suffix = rankInfo ? ` | ${rankInfo}` : ''
    return ok(`${scopeLabel}${typeLabel}榜: ${lines}${suffix}`)
  }

  async function announce_daily_star (args = {}) {
    const { date } = args
    const dateKey = date || dm.getYesterdayKey()

    // Check if already recorded
    let star = dailyStar.getStarByDate(dateKey)

    if (!star) {
      // Calculate and record
      star = dailyStar.selectDailyStar(dateKey)
      if (star && star.score > 0) {
        dailyStar.recordDailyStar(dateKey, star)
      }
    }

    if (star && star.score > 0) {
      const msg = `${dateKey}之星: ${star.name}，在线${star.breakdown?.onlineMinutes || 0}分钟，发言${star.breakdown?.messages || 0}条，活跃度${star.score}分！`
      try { bot.chat(msg) } catch {}
      return ok(msg)
    } else {
      return ok(`${dateKey} 无今日之星（无活动数据）`)
    }
  }

  register('query_player_stats', query_player_stats)
  register('query_leaderboard', query_leaderboard)
  register('announce_daily_star', announce_daily_star)
}
