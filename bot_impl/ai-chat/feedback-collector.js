/**
 * REFS (Rapid Evolution Feedback System) - Feedback Collector
 * 反馈收集层：捕获玩家反应、动作结果、对话质量
 */

const FEEDBACK_WINDOW_MS = 30000
const IGNORE_WINDOW_MS = 60000
const MAX_RECENT_SIGNALS = 100
const MAX_WINDOWS = 50

const REACTION_SIGNALS = {
  // 正面信号
  THANKS: { weight: 2.0, patterns: [/谢|感谢|thx|thanks|ty|好棒|厉害|不错|棒|赞|牛|强|nice|great|good|awesome/i] },
  AFFECTION: { weight: 1.5, patterns: [/喜欢|可爱|萌|cute|love|❤|好喜欢|太可爱/i] },
  LAUGHTER: { weight: 1.0, patterns: [/哈哈|233|lol|haha|笑死|绝了|乐/i] },
  AGREEMENT: { weight: 0.8, patterns: [/对|是的|没错|确实|exactly|yes|yep|嗯嗯/i] },
  // 任务给予信号（中性偏正面，表示玩家在互动）
  // Use word boundaries for English tokens to avoid false positives like "good"/"target"/"welcome".
  TASK_GIVEN: {
    weight: 0.5,
    patterns: [
      /帮我|给我|去|来|过来|跟我|找|拿|挖|采|砍|建|做|收集/i,
      /\b(?:gather|get|go|come|find|mine|chop|build)\b/i
    ]
  },
  // 负面信号
  FRUSTRATION: { weight: -2.0, patterns: [/烦|别|停|闭嘴|shut up|stop|annoying|够了|滚|别说了/i] },
  CORRECTION: { weight: -1.0, patterns: [/不对|错了|wrong|不是|no that|瞎说|胡说/i] },
  CONFUSION: { weight: -0.5, patterns: [/什么意思|没听懂|不懂|啥意思|\?\?\?|不明白/i] }
}

function createFeedbackCollector ({ state, bot, log, now = () => Date.now(), memoryStore, memory }) {
  function debug (...args) {
    if (log?.debug) log.debug('[REFS:feedback]', ...args)
  }

  function info (...args) {
    if (log?.info) log.info('[REFS:feedback]', ...args)
  }

  function ensureState () {
    if (!state.aiFeedback) {
      state.aiFeedback = {
        windows: new Map(),
        stats: { positive: 0, negative: 0, actionSuccess: 0, actionFail: 0 },
        recentSignals: [],
        lastWindowId: null
      }
    }
    if (!(state.aiFeedback.windows instanceof Map)) state.aiFeedback.windows = new Map()
    if (!Array.isArray(state.aiFeedback.recentSignals)) state.aiFeedback.recentSignals = []
  }

  // 打开反馈窗口
  function openFeedbackWindow ({ botMessage, targetUser, memoryRefs = [], toolUsed = null, context = 'chat' }) {
    ensureState()
    const windowId = `fw_${now()}_${Math.random().toString(36).slice(2, 6)}`
    const windowData = {
      id: windowId,
      botMessage: String(botMessage || '').slice(0, 200),
      targetUser,
      timestamp: now(),
      memoryRefs: Array.isArray(memoryRefs) ? memoryRefs : [],
      toolUsed,
      context,
      signals: [],
      resolved: false
    }
    state.aiFeedback.windows.set(windowId, windowData)
    state.aiFeedback.lastWindowId = windowId
    pruneWindows()
    debug('opened window', windowId, 'for', targetUser)
    return windowId
  }

  function applyMemoryFeedback (memoryRefs, score) {
    if (!memory?.longTerm?.applyFeedback) return
    const refs = Array.isArray(memoryRefs) ? memoryRefs.filter(Boolean) : []
    if (!refs.length) return
    try { memory.longTerm.applyFeedback(refs, score) } catch {}
  }

  // 修剪过期窗口
  function pruneWindows () {
    ensureState()
    const nowTs = now()
    const resolveCutoff = nowTs - FEEDBACK_WINDOW_MS
    const deleteCutoff = nowTs - IGNORE_WINDOW_MS
    const windows = state.aiFeedback.windows
    for (const [id, win] of windows.entries()) {
      if (!win.resolved && win.timestamp < resolveCutoff) {
        resolveWindow(id)
      }
      if (win.resolved || win.timestamp < deleteCutoff) {
        windows.delete(id)
      }
    }
    while (windows.size > MAX_WINDOWS) {
      const oldest = [...windows.keys()][0]
      if (!windows.get(oldest)?.resolved) resolveWindow(oldest)
      windows.delete(oldest)
    }
  }

  // 分析消息中的反应信号
  function detectSignals (text) {
    const signals = []
    const lower = String(text || '').toLowerCase()
    for (const [type, config] of Object.entries(REACTION_SIGNALS)) {
      for (const pattern of config.patterns) {
        if (pattern.test(lower)) {
          signals.push({ type, weight: config.weight, matchedPattern: pattern.source })
          break
        }
      }
    }
    return signals
  }

  // 处理玩家消息，检测反馈信号
  function processPlayerMessage (username, text) {
    ensureState()
    const windows = state.aiFeedback.windows
    const signals = detectSignals(text)

    // 查找该用户最近的未解析窗口
    let targetWindow = null
    const currentTime = now()
    for (const [id, win] of windows.entries()) {
      if (win.targetUser === username && !win.resolved && currentTime - win.timestamp < FEEDBACK_WINDOW_MS) {
        targetWindow = win
        break
      }
    }

    if (!targetWindow) {
      if (signals.length) debug('no active window for', username, 'signals:', signals.map(s => s.type).join(','))
      return null
    }

    // 如果没有显式信号，把持续聊天视为参与，避免被误记为忽视
    if (!signals.length) {
      const engagementText = String(text || '').slice(0, 100)
      const engagement = { type: 'ENGAGEMENT', weight: 0.6, timestamp: currentTime, text: engagementText }
      targetWindow.signals.push(engagement)
      return { windowId: targetWindow.id, signals: [engagement] }
    }

    // 记录信号到窗口
    for (const sig of signals) {
      targetWindow.signals.push({ ...sig, timestamp: currentTime, text: text.slice(0, 100) })
    }

    debug('signals detected for window', targetWindow.id, ':', signals.map(s => s.type).join(','))
    return { windowId: targetWindow.id, signals }
  }

  // 处理玩家参与信号（继续对话）
  function processEngagement (username) {
    ensureState()
    const windows = state.aiFeedback.windows
    const currentTime = now()
    for (const [id, win] of windows.entries()) {
      if (win.targetUser === username && !win.resolved && currentTime - win.timestamp < FEEDBACK_WINDOW_MS) {
        win.signals.push({ type: 'ENGAGEMENT', weight: 1.0, timestamp: currentTime })
        debug('engagement signal for', username)
        return true
      }
    }
    return false
  }

  // 解析窗口，计算最终反馈分数
  function resolveWindow (windowId) {
    ensureState()
    const win = state.aiFeedback.windows.get(windowId)
    if (!win || win.resolved) return null

    win.resolved = true
    const signals = win.signals
    let totalScore = 0
    for (const sig of signals) {
      totalScore += sig.weight
    }

    // 如果没有任何信号，视为轻微负面（被忽视）
    if (signals.length === 0) {
      totalScore = -0.3
      signals.push({ type: 'IGNORE', weight: -0.3, timestamp: now() })
    }

    const averageScore = signals.length > 0 ? totalScore / signals.length : 0
    const isPositive = averageScore > 0.3
    const isNegative = averageScore < -0.3

    // 更新统计
    if (isPositive) state.aiFeedback.stats.positive++
    if (isNegative) state.aiFeedback.stats.negative++

    // 记录到最近信号列表
    const signalRecord = {
      windowId,
      timestamp: win.timestamp,
      targetUser: win.targetUser,
      botMessage: win.botMessage,
      memoryRefs: win.memoryRefs,
      toolUsed: win.toolUsed,
      context: win.context,
      signals: signals.map(s => ({ type: s.type, weight: s.weight })),
      totalScore,
      averageScore,
      isPositive,
      isNegative
    }
    state.aiFeedback.recentSignals.push(signalRecord)
    while (state.aiFeedback.recentSignals.length > MAX_RECENT_SIGNALS) {
      state.aiFeedback.recentSignals.shift()
    }

    // 更新连续负面计数（用于触发紧急自省）
    if (state.aiIntrospection) {
      if (isNegative) {
        state.aiIntrospection.consecutiveNegative = (state.aiIntrospection.consecutiveNegative || 0) + 1
      } else if (isPositive) {
        state.aiIntrospection.consecutiveNegative = 0
      }
    }

    // 将反馈应用到相关记忆
    applyMemoryFeedback(win.memoryRefs, averageScore)

    info('window resolved:', windowId, 'score:', averageScore.toFixed(2), isPositive ? '(+)' : isNegative ? '(-)' : '(~)')
    persistState()
    return signalRecord
  }

  // 记录动作结果
  function recordActionOutcome ({ taskName, success, duration, failureReason, triggeredBy }) {
    ensureState()
    if (success) {
      state.aiFeedback.stats.actionSuccess++
    } else {
      state.aiFeedback.stats.actionFail++
    }
    debug('action outcome:', taskName, success ? 'success' : 'failed', failureReason || '')
  }

  // 获取统计数据
  function getStats () {
    ensureState()
    const stats = state.aiFeedback.stats
    const totalFeedback = stats.positive + stats.negative
    const totalActions = stats.actionSuccess + stats.actionFail
    return {
      positive: stats.positive,
      negative: stats.negative,
      feedbackRatio: totalFeedback > 0 ? stats.positive / totalFeedback : 0.5,
      actionSuccess: stats.actionSuccess,
      actionFail: stats.actionFail,
      actionSuccessRate: totalActions > 0 ? stats.actionSuccess / totalActions : 0.5,
      totalFeedback,
      totalActions
    }
  }

  // 获取最近信号（用于自省）
  function getRecentSignals (windowMs = 30 * 60 * 1000) {
    ensureState()
    const cutoff = now() - windowMs
    return state.aiFeedback.recentSignals.filter(s => s.timestamp >= cutoff)
  }

  // 持久化状态
  function persistState () {
    if (!memoryStore?.saveEvolution) return
    try {
      memoryStore.saveEvolution({
        personality: state.aiPersonality,
        emotionalState: state.aiEmotionalState,
        feedbackStats: state.aiFeedback?.stats,
        introspectionHistory: state.aiIntrospection?.history,
        lastIntrospection: state.aiIntrospection?.lastRun,
        recentFeedback: state.aiFeedback?.recentSignals
      })
    } catch (e) {
      debug('persist error:', e?.message)
    }
  }

  // 定时清理
  function tick () {
    pruneWindows()
  }

  return {
    openFeedbackWindow,
    processPlayerMessage,
    processEngagement,
    resolveWindow,
    recordActionOutcome,
    getStats,
    getRecentSignals,
    persistState,
    tick
  }
}

module.exports = { createFeedbackCollector }
