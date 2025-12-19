/**
 * REFS - Pure Surprise Engine (纯粹惊讶引擎)
 *
 * 最简原理：状态A → 状态B，记录转移频率
 * 惊讶 = 这个转移有多"罕见"
 *
 * 不预设任何语义（无敌对/友好/危险/安全）
 * 只有模式和转移。
 */

const TICK_INTERVAL = 5000

function createPureSurprise ({ state, bot, observer, log, now = () => Date.now() }) {
  let timer = null
  let prevState = null

  function info (...args) {
    console.log('[MIND]', ...args)
    if (log?.info) log.info('[MIND]', ...args)
  }

  function ensure () {
    if (!state.aiMind) {
      state.aiMind = {
        transitions: {},  // { fromHash: { toHash: count } }
        totalFromState: {}, // { fromHash: totalCount }
        history: [],
        surprise: 0,
        curious: null
      }
    }
    return state.aiMind
  }

  // 将世界状态压缩为简单特征
  function perceive () {
    if (!observer?.snapshot) return null
    try {
      const snap = observer.snapshot(bot, { nearPlayerRange: 20, hostileRange: 16 })
      return {
        players: (snap.nearbyPlayers || []).map(p => p.username).sort(),
        entities: (snap.hostiles || []).map(h => h.name).sort(),
        health: Math.floor((snap.health || 20) / 5), // 量化为0-4
        hurt: false // 将在tick中检测
      }
    } catch { return null }
  }

  // 状态哈希：将状态转为字符串键
  function hash (s) {
    if (!s) return 'null'
    const parts = []
    if (s.players?.length) parts.push('P:' + s.players.join(','))
    if (s.entities?.length) parts.push('E:' + s.entities.join(','))
    parts.push('H:' + s.health)
    if (s.hurt) parts.push('HURT')
    return parts.join('|') || 'empty'
  }

  // 记录一次转移
  function recordTransition (from, to) {
    const m = ensure()
    if (!m.transitions[from]) m.transitions[from] = {}
    m.transitions[from][to] = (m.transitions[from][to] || 0) + 1
    m.totalFromState[from] = (m.totalFromState[from] || 0) + 1
  }

  // 计算转移的惊讶度（越罕见越惊讶）
  function transitionSurprise (from, to) {
    const m = ensure()
    const total = m.totalFromState[from] || 0
    if (total === 0) return 1 // 完全未知 = 最大惊讶
    const count = m.transitions[from]?.[to] || 0
    const probability = count / total
    // 惊讶度 = 1 - 概率（罕见事件更惊讶）
    return 1 - probability
  }

  // 预测下一个最可能的状态
  function predict (from) {
    const m = ensure()
    const trans = m.transitions[from]
    if (!trans) return null
    let best = null, bestCount = 0
    for (const [to, count] of Object.entries(trans)) {
      if (count > bestCount) { best = to; bestCount = count }
    }
    return best
  }

  function tick () {
    const curr = perceive()
    if (!curr) return

    const m = ensure()

    // 检测是否受伤
    if (prevState && curr.health < prevState.health) {
      curr.hurt = true
    }

    const currHash = hash(curr)
    const prevHash = prevState ? hash(prevState) : null

    if (prevHash && prevHash !== currHash) {
      // 状态发生了变化
      const surprise = transitionSurprise(prevHash, currHash)
      recordTransition(prevHash, currHash)

      m.surprise = surprise

      if (surprise > 0.5) {
        const predicted = predict(prevHash)
        const thought = predicted
          ? `预期 ${predicted}，但实际是 ${currHash}`
          : `新情况: ${currHash}`

        m.history.push({
          from: prevHash,
          to: currHash,
          surprise,
          thought,
          ts: now()
        })

        info(`💭 ${surprise > 0.8 ? '!' : ''} ${thought} (${(surprise * 100).toFixed(0)}%)`)

        // 保持历史简洁
        while (m.history.length > 50) m.history.shift()

        // 高惊讶 = 好奇
        if (surprise > 0.7) {
          m.curious = currHash
        }
      }
    } else {
      // 状态未变，惊讶衰减
      m.surprise *= 0.95
    }

    prevState = curr
  }

  function start () {
    if (timer) return
    ensure()
    timer = setInterval(() => { try { tick() } catch {} }, TICK_INTERVAL)
    info('启动 - 原理: 记录转移，预测未来')
    try { tick() } catch {}
  }

  function stop () {
    if (timer) { clearInterval(timer); timer = null }
  }

  function getStatus () {
    const m = ensure()
    return {
      running: !!timer,
      surprise: m.surprise,
      curious: m.curious,
      knownStates: Object.keys(m.transitions).length,
      history: m.history.slice(-5)
    }
  }

  // 查询：从某状态出发，通常会发生什么？
  function whatFollows (stateFragment) {
    const m = ensure()
    const results = []
    for (const [from, trans] of Object.entries(m.transitions)) {
      if (from.includes(stateFragment)) {
        const total = m.totalFromState[from] || 1
        for (const [to, count] of Object.entries(trans)) {
          results.push({ from, to, probability: count / total, count })
        }
      }
    }
    return results.sort((a, b) => b.probability - a.probability).slice(0, 10)
  }

  return { start, stop, tick, getStatus, whatFollows, predict: (s) => predict(hash(s)) }
}

module.exports = { createPureSurprise }
