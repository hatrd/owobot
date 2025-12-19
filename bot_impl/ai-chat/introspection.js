/**
 * REFS (Rapid Evolution Feedback System) - Introspection Engine
 * 自省引擎：定期分析互动数据，生成行为调整建议
 */

const INTROSPECTION_INTERVAL_MS = 30 * 60 * 1000 // 30分钟
const EMERGENCY_NEGATIVE_THRESHOLD = 3 // 连续3次负面反馈触发紧急自省
const MAX_HISTORY = 20

const INTROSPECTION_SYSTEM_PROMPT = `你是一个进行自我反思的Minecraft机器人。
分析最近的互动数据，识别行为模式并给出调整建议。

请输出JSON格式：
{
  "insights": ["发现1", "发现2"],
  "behavior_adjustments": [
    {"trait": "playfulness|helpfulness|curiosity|assertiveness|emotionality", "delta": -0.1到0.1, "reason": "原因"}
  ],
  "memory_reinforcements": ["值得强化的记忆内容关键词"],
  "memory_decays": ["应该弱化的记忆内容关键词"],
  "emotional_state": "curious|content|uncertain|eager|concerned",
  "self_narrative": "用第一人称描述你的感受和发现（20字以内）"
}

只输出JSON，不要有其他内容。`

function createIntrospectionEngine ({
  state,
  bot,
  log,
  now = () => Date.now(),
  feedbackCollector,
  memory,
  memoryStore,
  aiCall = null
}) {
  let timer = null
  let running = false

  function info (...args) {
    if (log?.info) log.info('[REFS:introspect]', ...args)
    console.log('[REFS:introspect]', ...args)
  }

  function debug (...args) {
    if (log?.debug) log.debug('[REFS:introspect]', ...args)
  }

  function ensureState () {
    if (!state.aiIntrospection) {
      state.aiIntrospection = { history: [], lastRun: null, consecutiveNegative: 0 }
    }
    if (!Array.isArray(state.aiIntrospection.history)) state.aiIntrospection.history = []
    if (!state.aiPersonality) {
      state.aiPersonality = {
        traits: { playfulness: 0.7, helpfulness: 0.8, curiosity: 0.6, assertiveness: 0.4, emotionality: 0.5 },
        modifiers: {},
        lastAdjustment: null
      }
    }
    if (!state.aiEmotionalState) {
      state.aiEmotionalState = { current: 'content', intensity: 0.5, lastUpdate: now(), triggers: [] }
    }
  }

  function buildIntrospectionPrompt () {
    ensureState()
    const fbStats = feedbackCollector?.getStats?.() || {}
    const recentSignals = feedbackCollector?.getRecentSignals?.(INTROSPECTION_INTERVAL_MS) || []
    const memStats = memory?.longTerm?.getStats?.() || {}
    const personality = state.aiPersonality

    // 统计正面/负面案例
    const positiveExamples = recentSignals.filter(s => s.isPositive).slice(-3)
    const negativeExamples = recentSignals.filter(s => s.isNegative).slice(-3)

    const data = {
      feedbackStats: {
        positive: fbStats.positive || 0,
        negative: fbStats.negative || 0,
        ratio: fbStats.feedbackRatio?.toFixed(2) || '0.50',
        actionSuccessRate: fbStats.actionSuccessRate?.toFixed(2) || '0.50'
      },
      recentPositive: positiveExamples.map(e => ({
        message: e.botMessage?.slice(0, 50),
        signals: e.signals?.map(s => s.type).join(',')
      })),
      recentNegative: negativeExamples.map(e => ({
        message: e.botMessage?.slice(0, 50),
        signals: e.signals?.map(s => s.type).join(',')
      })),
      memoryStats: {
        total: memStats.totalEntries || 0,
        effectivenessRate: memStats.effectivenessRate?.toFixed(2) || '0'
      },
      currentPersonality: {
        ...personality.traits,
        modifiers: personality.modifiers
      },
      currentEmotion: state.aiEmotionalState.current
    }

    return `【近期互动数据】
正面反馈: ${data.feedbackStats.positive}次 | 负面反馈: ${data.feedbackStats.negative}次
反馈正面率: ${data.feedbackStats.ratio} | 动作成功率: ${data.feedbackStats.actionSuccessRate}

【正面案例】
${data.recentPositive.map((e, i) => `${i + 1}. "${e.message}" -> ${e.signals}`).join('\n') || '无'}

【负面案例】
${data.recentNegative.map((e, i) => `${i + 1}. "${e.message}" -> ${e.signals}`).join('\n') || '无'}

【记忆系统】
总条目: ${data.memoryStats.total} | 记忆有效率: ${data.memoryStats.effectivenessRate}

【当前人格特质】
俏皮: ${data.currentPersonality.playfulness} | 助人: ${data.currentPersonality.helpfulness}
好奇: ${data.currentPersonality.curiosity} | 主动: ${data.currentPersonality.assertiveness}
情感: ${data.currentPersonality.emotionality}

【当前情感状态】
${data.currentEmotion}

请分析以上数据，给出调整建议。`
  }

  async function runIntrospection (reason = 'scheduled') {
    if (running) return null
    ensureState()

    running = true
    const startTime = now()
    info('开始自省...', '触发原因:', reason)

    try {
      const prompt = buildIntrospectionPrompt()
      let result = null

      if (aiCall && typeof aiCall === 'function') {
        try {
          const response = await aiCall({
            systemPrompt: INTROSPECTION_SYSTEM_PROMPT,
            userPrompt: prompt,
            maxTokens: 500,
            temperature: 0.7
          })
          result = parseIntrospectionResult(response)
        } catch (e) {
          info('AI调用失败:', e?.message)
        }
      }

      if (!result) {
        result = generateFallbackResult()
      }

      applyIntrospectionResult(result)

      // 记录到历史
      const record = {
        timestamp: startTime,
        reason,
        duration: now() - startTime,
        result
      }
      state.aiIntrospection.history.push(record)
      while (state.aiIntrospection.history.length > MAX_HISTORY) {
        state.aiIntrospection.history.shift()
      }
      state.aiIntrospection.lastRun = startTime

      // 持久化
      persistState()

      // 输出内心独白到日志
      if (result.self_narrative) {
        info('💭 内心独白:', result.self_narrative)
      }
      if (result.insights?.length) {
        info('💡 洞察:', result.insights.join(' | '))
      }

      return result
    } catch (e) {
      info('自省错误:', e?.message)
      return null
    } finally {
      running = false
    }
  }

  function parseIntrospectionResult (response) {
    try {
      const text = String(response || '').trim()
      // 尝试提取 JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch {}
    return null
  }

  function generateFallbackResult () {
    ensureState()
    const fbStats = feedbackCollector?.getStats?.() || {}
    const ratio = fbStats.feedbackRatio || 0.5

    const result = {
      insights: [],
      behavior_adjustments: [],
      memory_reinforcements: [],
      memory_decays: [],
      emotional_state: 'content',
      self_narrative: '一切正常~'
    }

    if (ratio < 0.4) {
      result.insights.push('负面反馈较多，需要调整')
      result.behavior_adjustments.push({ trait: 'assertiveness', delta: -0.05, reason: '减少主动性' })
      result.emotional_state = 'uncertain'
      result.self_narrative = '最近好像有点让人烦了...'
    } else if (ratio > 0.7) {
      result.insights.push('反馈很好，继续保持')
      result.emotional_state = 'content'
      result.self_narrative = '大家好像挺喜欢我的~'
    }

    return result
  }

  function applyIntrospectionResult (result) {
    if (!result) return
    ensureState()

    // 应用人格调整
    if (Array.isArray(result.behavior_adjustments)) {
      for (const adj of result.behavior_adjustments) {
        if (!adj.trait || typeof adj.delta !== 'number') continue
        const trait = adj.trait
        if (!state.aiPersonality.modifiers) state.aiPersonality.modifiers = {}
        const current = state.aiPersonality.modifiers[trait] || 0
        const newValue = Math.max(-0.3, Math.min(0.3, current + adj.delta))
        state.aiPersonality.modifiers[trait] = newValue
        info(`人格调整: ${trait} ${adj.delta > 0 ? '+' : ''}${adj.delta.toFixed(2)} -> ${newValue.toFixed(2)}`)
      }
      state.aiPersonality.lastAdjustment = now()
    }

    // 应用情感状态
    if (result.emotional_state && ['curious', 'content', 'uncertain', 'eager', 'concerned'].includes(result.emotional_state)) {
      const prevState = state.aiEmotionalState.current
      state.aiEmotionalState.current = result.emotional_state
      state.aiEmotionalState.lastUpdate = now()
      if (prevState !== result.emotional_state) {
        info(`情感转变: ${prevState} -> ${result.emotional_state}`)
      }
    }

    // 重置连续负面计数
    state.aiIntrospection.consecutiveNegative = 0
  }

  function persistState () {
    if (!memoryStore?.saveEvolution) return
    try {
      memoryStore.saveEvolution({
        personality: state.aiPersonality,
        emotionalState: state.aiEmotionalState,
        feedbackStats: state.aiFeedback?.stats,
        introspectionHistory: state.aiIntrospection?.history,
        lastIntrospection: state.aiIntrospection?.lastRun
      })
    } catch {}
  }

  function getEffectivePersonality () {
    ensureState()
    const traits = state.aiPersonality.traits
    const mods = state.aiPersonality.modifiers || {}
    const effective = {}
    for (const [key, base] of Object.entries(traits)) {
      const mod = mods[key] || 0
      effective[key] = Math.max(0, Math.min(1, base + mod))
    }
    return effective
  }

  function checkEmergencyIntrospection () {
    ensureState()
    if (state.aiIntrospection.consecutiveNegative >= EMERGENCY_NEGATIVE_THRESHOLD) {
      info('触发紧急自省: 连续负面反馈')
      runIntrospection('emergency').catch(() => {})
    }
  }

  function start () {
    if (timer) return
    timer = setInterval(() => {
      const lastRun = state.aiIntrospection?.lastRun || 0
      if (now() - lastRun >= INTROSPECTION_INTERVAL_MS) {
        runIntrospection('scheduled').catch(() => {})
      }
    }, 60000) // 每分钟检查
    info('自省引擎已启动，间隔:', INTROSPECTION_INTERVAL_MS / 60000, '分钟')
  }

  function stop () {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function getStatus () {
    ensureState()
    return {
      running,
      lastRun: state.aiIntrospection.lastRun,
      historyCount: state.aiIntrospection.history.length,
      consecutiveNegative: state.aiIntrospection.consecutiveNegative,
      personality: getEffectivePersonality(),
      emotionalState: state.aiEmotionalState
    }
  }

  return {
    start,
    stop,
    runIntrospection,
    getEffectivePersonality,
    getStatus,
    checkEmergencyIntrospection,
    persistState
  }
}

module.exports = { createIntrospectionEngine }
