const dm = require('./player-stats/data-manager')
const { createTracker } = require('./player-stats/tracker')
const dailyStar = require('./player-stats/daily-star')

const FLUSH_INTERVAL_MS = 60 * 1000 // Flush every minute

function install (bot, { on, state, registerCleanup, log }) {
  // Initialize state
  if (!state.playerStats) state.playerStats = {}
  if (!(state.playerStats.activeSessions instanceof Map)) {
    state.playerStats.activeSessions = new Map()
  }
  state.playerStats.lastFlushAt = state.playerStats.lastFlushAt || 0
  state.playerStats.flushTimer = null
  state.playerStats.dailyStarTimer = null

  // Ensure data directory exists
  dm.ensureDataDir()

  // Create tracker
  const tracker = createTracker(bot, state, log)

  // Register event listeners
  on('playerJoined', (player) => tracker.onPlayerJoin(player))
  on('playerLeft', (player) => tracker.onPlayerLeave(player))
  on('chat', (username, message) => tracker.onChat(username, message))
  on('message', (message) => tracker.onMessage(message))

  // Initialize existing players on spawn
  on('spawn', () => {
    tracker.initExistingPlayers()
  })

  // Start flush timer
  function startFlushTimer () {
    if (state.playerStats.flushTimer) clearInterval(state.playerStats.flushTimer)
    state.playerStats.flushTimer = setInterval(() => {
      tracker.flushAll()
    }, FLUSH_INTERVAL_MS)
  }
  startFlushTimer()

  // Schedule daily star announcement
  dailyStar.scheduleDailyAnnouncement(bot, state, log, tracker)

  // CLI handler
  function handleCli ({ cmd, args }) {
    const c = String(cmd || '').toLowerCase()
    if (c === 'stats') handleStatsCli(args)
    else if (c === 'rank') handleRankCli(args)
    else if (c === 'star') handleStarCli(args)
    else if (c === 'pstats') handlePstatsCli(args)
  }
  on('cli', handleCli)

  // .stats <player> [today]
  function handleStatsCli (args) {
    const P = (...a) => console.log('[STATS]', ...a)
    const a0 = String(args[0] || '').toLowerCase()
    const a1 = String(args[1] || '').toLowerCase()

    if (!a0 || a0 === 'help') {
      P('用法: .stats <玩家名> [today]')
      P('  .stats Steve       - 查看 Steve 的总统计')
      P('  .stats today Steve - 查看 Steve 的今日统计')
      return
    }

    let playerName, isToday
    if (a0 === 'today') {
      playerName = a1
      isToday = true
    } else {
      playerName = a0
      isToday = a1 === 'today'
    }

    if (!playerName) {
      P('请指定玩家名')
      return
    }

    const data = dm.findPlayerByName(playerName)
    if (!data) {
      P(`未找到玩家: ${playerName}`)
      return
    }

    if (isToday) {
      const todayKey = dm.getTodayKey()
      const daily = data.daily && data.daily[todayKey]
      if (!daily) {
        P(`${data.lastKnownName} 今日无数据`)
        return
      }
      const mins = Math.floor((daily.onlineMs || 0) / 60000)
      const score = dailyStar.calculateScore(daily)
      P(`${data.lastKnownName} 今日统计 (${todayKey}):`)
      P(`  在线: ${mins} 分钟`)
      P(`  聊天: ${daily.messages || 0} 条`)
      P(`  死亡: ${daily.deaths || 0} 次`)
      P(`  活跃度: ${score} 分`)
    } else {
      const totalMins = Math.floor((data.stats.totalOnlineMs || 0) / 60000)
      const hours = Math.floor(totalMins / 60)
      const mins = totalMins % 60
      P(`${data.lastKnownName} 总统计:`)
      P(`  在线: ${hours}h ${mins}m`)
      P(`  聊天: ${data.stats.totalMessages || 0} 条`)
      P(`  死亡: ${data.stats.totalDeaths || 0} 次`)
      if (data.achievements && data.achievements.length) {
        P(`  成就: ${data.achievements.slice(-3).join(', ')}`)
      }
    }
  }

  // .rank [online|chat|deaths] [today]
  function handleRankCli (args) {
    const P = (...a) => console.log('[RANK]', ...a)
    const a0 = String(args[0] || '').toLowerCase()
    const a1 = String(args[1] || '').toLowerCase()

    let type = 'score'
    let isToday = false

    if (a0 === 'today') {
      isToday = true
      if (a1 && ['online', 'chat', 'deaths', 'score'].includes(a1)) type = a1
    } else if (a0 === 'help') {
      P('用法: .rank [online|chat|deaths|score] [today]')
      P('  .rank              - 总活跃度排行')
      P('  .rank online       - 总在线时长排行')
      P('  .rank today        - 今日活跃度排行')
      P('  .rank today chat   - 今日聊天排行')
      return
    } else if (['online', 'chat', 'deaths', 'score'].includes(a0)) {
      type = a0
      isToday = a1 === 'today'
    } else if (a0) {
      isToday = a0 === 'today'
    }

    const players = dm.getAllPlayersData()
    if (!players.length) {
      P('无玩家数据')
      return
    }

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

    entries.sort((a, b) => b.value - a.value)
    const top = entries.slice(0, 10)

    const typeLabel = {
      online: '在线(分钟)',
      chat: '聊天(条)',
      deaths: '死亡(次)',
      score: '活跃度'
    }[type]
    const periodLabel = isToday ? `今日${todayKey}` : '总计'

    P(`${periodLabel} ${typeLabel}排行:`)
    if (!top.length) {
      P('  暂无数据')
      return
    }
    top.forEach((e, i) => {
      P(`  ${i + 1}. ${e.name}: ${e.value}`)
    })
  }

  // .star [history [N]]
  function handleStarCli (args) {
    const P = (...a) => console.log('[STAR]', ...a)
    const a0 = String(args[0] || '').toLowerCase()
    const a1 = args[1]

    if (a0 === 'help') {
      P('用法: .star [history [N]]')
      P('  .star           - 查看昨日之星')
      P('  .star history   - 查看历史今日之星 (默认5条)')
      P('  .star history 10 - 查看最近10条')
      return
    }

    if (a0 === 'history') {
      const limit = parseInt(a1 || '5', 10) || 5
      const stars = dailyStar.getRecentStars(limit)
      if (!stars.length) {
        P('暂无今日之星记录')
        return
      }
      P(`最近 ${stars.length} 条今日之星:`)
      for (const s of stars) {
        P(`  ${s.date}: ${s.name} (${s.score}分) - 在线${s.breakdown?.onlineMinutes || 0}m, 聊天${s.breakdown?.messages || 0}条`)
      }
      return
    }

    // Default: show yesterday's star
    const yesterdayKey = dm.getYesterdayKey()
    const star = dailyStar.getStarByDate(yesterdayKey)
    if (star) {
      P(`昨日之星 (${yesterdayKey}):`)
      P(`  ${star.name} - ${star.score}分`)
      P(`  在线: ${star.breakdown?.onlineMinutes || 0} 分钟`)
      P(`  聊天: ${star.breakdown?.messages || 0} 条`)
      P(`  死亡: ${star.breakdown?.deaths || 0} 次`)
    } else {
      // Try to calculate (not yet announced)
      const candidate = dailyStar.selectDailyStar(yesterdayKey)
      if (candidate) {
        P(`昨日之星候选 (${yesterdayKey}, 未公布):`)
        P(`  ${candidate.name} - ${candidate.score}分`)
      } else {
        P(`昨日 (${yesterdayKey}) 无今日之星`)
      }
    }
  }

  // .pstats [flush|status]
  function handlePstatsCli (args) {
    const P = (...a) => console.log('[PSTATS]', ...a)
    const sub = String(args[0] || '').toLowerCase()

    if (sub === 'flush') {
      tracker.flushAll()
      P('已刷盘')
      return
    }

    if (sub === 'status') {
      const sessions = state.playerStats.activeSessions
      P(`活跃会话: ${sessions.size}`)
      P(`上次刷盘: ${state.playerStats.lastFlushAt ? new Date(state.playerStats.lastFlushAt).toLocaleString() : '从未'}`)
      const allPlayers = dm.listAllPlayerUUIDs()
      P(`玩家文件: ${allPlayers.length}`)
      return
    }

    P('用法: .pstats [flush|status]')
    P('  flush  - 立即刷盘')
    P('  status - 显示状态')
  }

  // Cleanup
  registerCleanup(() => {
    if (state.playerStats.flushTimer) {
      clearInterval(state.playerStats.flushTimer)
      state.playerStats.flushTimer = null
    }
    dailyStar.cancelDailyAnnouncement(state)
    // Final flush before cleanup
    tracker.flushAll()
  })

  // Flush on disconnect
  on('end', () => {
    tracker.flushAll()
  })

  if (log?.info) log.info('[STATS] Player stats module installed')
}

module.exports = { install }
