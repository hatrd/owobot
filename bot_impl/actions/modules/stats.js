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
    const { type = 'score', period = 'all', limit = 5 } = args
    const players = dm.getAllPlayersData()
    if (!players.length) return ok('暂无玩家数据')

    const isToday = period === 'today'
    const todayKey = dm.getTodayKey()
    const entries = []

    for (const player of players) {
      let value = 0
      if (isToday) {
        const daily = player.daily && player.daily[todayKey]
        if (!daily) continue
        switch (type) {
          case 'online':
            value = Math.floor((daily.onlineMs || 0) / 60000)
            break
          case 'chat':
            value = daily.messages || 0
            break
          case 'deaths':
            value = daily.deaths || 0
            break
          case 'score':
          default:
            value = dailyStar.calculateScore(daily)
        }
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
            value = totalMins + (player.stats.totalMessages || 0)
          }
        }
      }
      if (value > 0) {
        entries.push({ name: player.lastKnownName, value })
      }
    }

    if (!entries.length) return ok('暂无数据')

    entries.sort((a, b) => b.value - a.value)
    const top = entries.slice(0, Math.min(limit, 10))

    const typeLabel = {
      online: '在线',
      chat: '发言',
      deaths: '死亡',
      score: '活跃度'
    }[type] || '活跃度'
    const periodLabel = isToday ? '今日' : '总'

    const lines = top.map((e, i) => `${i + 1}.${e.name}(${e.value})`).join(' ')
    return ok(`${periodLabel}${typeLabel}榜: ${lines}`)
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
