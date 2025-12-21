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
    const recentSignals = feedbackCollector?.getRecentSignals?.(INTROSPECTION_INTERVAL_MS) || []
    const ratio = typeof fbStats.feedbackRatio === 'number' ? fbStats.feedbackRatio : 0.5
    const actionSuccessRate = typeof fbStats.actionSuccessRate === 'number' ? fbStats.actionSuccessRate : 0.5
    const totalFeedback = typeof fbStats.totalFeedback === 'number' ? fbStats.totalFeedback : 0
    const totalActions = typeof fbStats.totalActions === 'number' ? fbStats.totalActions : 0

    const result = {
      insights: [],
      behavior_adjustments: [],
      memory_reinforcements: [],
      memory_decays: [],
      emotional_state: 'content',
      self_narrative: '一切正常~'
    }

    const typeCounts = {}
    const negativeToolCounts = new Map()
    const reinforceSet = new Set()
    const decaySet = new Set()

    function hasType (record, type) {
      const sigs = record?.signals
      if (!Array.isArray(sigs)) return false
      return sigs.some(s => s?.type === type)
    }

    // 冷场检测：窗口尾部连续 IGNORE
    let ignoreStreak = 0
    for (let i = recentSignals.length - 1; i >= 0; i--) {
      if (hasType(recentSignals[i], 'IGNORE')) ignoreStreak++
      else break
    }

    for (const rec of recentSignals) {
      const sigs = Array.isArray(rec?.signals) ? rec.signals : []
      for (const s of sigs) {
        const t = s?.type
        if (!t) continue
        typeCounts[t] = (typeCounts[t] || 0) + 1
      }

      const refs = Array.isArray(rec?.memoryRefs) ? rec.memoryRefs : []
      if (rec?.isPositive) for (const r of refs) reinforceSet.add(String(r))
      if (rec?.isNegative) for (const r of refs) decaySet.add(String(r))

      if (rec?.isNegative && rec?.toolUsed) {
        const k = String(rec.toolUsed)
        negativeToolCounts.set(k, (negativeToolCounts.get(k) || 0) + 1)
      }
    }

    function addInsight (text) {
      const t = String(text || '').trim()
      if (!t) return
      result.insights.push(t)
    }

    function addAdjustment (trait, delta, reason) {
      if (!trait || typeof delta !== 'number' || !Number.isFinite(delta)) return
      const t = String(trait)
      const existing = result.behavior_adjustments.find(a => a?.trait === t)
      if (existing) {
        existing.delta = (existing.delta || 0) + delta
        existing.reason = existing.reason ? `${existing.reason}; ${reason || ''}`.trim() : String(reason || '').trim()
        return
      }
      result.behavior_adjustments.push({ trait: t, delta, reason: String(reason || '').trim() })
    }

    // 记忆提示
    result.memory_reinforcements = [...reinforceSet].filter(Boolean).slice(0, 5)
    result.memory_decays = [...decaySet].filter(Boolean).slice(0, 5)

    const posSignals = (typeCounts.THANKS || 0) + (typeCounts.AFFECTION || 0) + (typeCounts.LAUGHTER || 0) + (typeCounts.AGREEMENT || 0) + (typeCounts.ENGAGEMENT || 0)
    const negSignals = (typeCounts.FRUSTRATION || 0) + (typeCounts.CORRECTION || 0) + (typeCounts.CONFUSION || 0) + (typeCounts.IGNORE || 0)

    // 1) 冷场/被忽视
    if (ignoreStreak >= 3) {
      addInsight(`连续被忽视 ${ignoreStreak} 次，可能需要减少打扰感`)
      addAdjustment('assertiveness', -0.06, '连续被忽视，减少主动插话')
      addAdjustment('playfulness', -0.04, '连续被忽视，降低玩笑感')
      result.emotional_state = 'concerned'
      result.self_narrative = '他们好像不太理我…我先安静点'
    } else if (ignoreStreak === 2) {
      addInsight('最近两次互动都被忽视，可能时机不对')
      addAdjustment('assertiveness', -0.04, '被忽视，减少频率')
      result.emotional_state = 'uncertain'
      result.self_narrative = '是不是我出现得不太合适…'
    } else if ((typeCounts.IGNORE || 0) >= 3) {
      addInsight(`近期出现较多忽视信号（IGNORE=${typeCounts.IGNORE}）`)
      addAdjustment('assertiveness', -0.03, '忽视偏多，收敛主动性')
    }

    // 2) 强负面反应
    if ((typeCounts.FRUSTRATION || 0) >= 1) {
      addInsight('出现烦躁/拒绝信号，需要降低侵入性与噪音')
      addAdjustment('assertiveness', -0.06, '减少强推与连续输出')
      addAdjustment('playfulness', -0.05, '对方烦躁时减少卖萌/玩笑')
      result.emotional_state = result.emotional_state === 'concerned' ? 'concerned' : 'uncertain'
      if (result.self_narrative === '一切正常~') result.self_narrative = '我是不是有点吵…先收敛点'
    }

    // 3) 困惑/纠正 → 更清晰
    if ((typeCounts.CONFUSION || 0) >= 1) {
      addInsight('出现困惑信号，说明表达可能不够清楚')
      addAdjustment('helpfulness', +0.05, '用更短更清晰的步骤解释')
      addAdjustment('curiosity', +0.03, '先问清需求再答')
      addAdjustment('playfulness', -0.02, '困惑时少玩梗')
      result.emotional_state = 'uncertain'
      if (result.self_narrative === '一切正常~') result.self_narrative = '我讲得不够清楚…再说得明白点'
    }
    if ((typeCounts.CORRECTION || 0) >= 1) {
      addInsight('出现纠正信号，说明我可能在事实/理解上偏差')
      addAdjustment('curiosity', +0.04, '先确认事实再回答')
      addAdjustment('assertiveness', -0.03, '降低武断程度')
      result.emotional_state = result.emotional_state === 'uncertain' ? 'uncertain' : 'concerned'
      if (result.self_narrative === '一切正常~') result.self_narrative = '我得更谨慎点，别说错了'
    }

    // 4) 动作表现
    if (totalActions >= 4 && actionSuccessRate < 0.5) {
      addInsight(`动作成功率偏低（${actionSuccessRate.toFixed(2)}），需要更保守与确认`)
      addAdjustment('assertiveness', -0.05, '动作失败偏多，减少贸然行动')
      addAdjustment('curiosity', +0.02, '行动前多观察/确认条件')
      result.emotional_state = 'concerned'
      if (result.self_narrative === '一切正常~') result.self_narrative = '我最近动作做得不太好…先稳一点'
    } else if (totalActions >= 4 && actionSuccessRate > 0.85) {
      addInsight(`动作成功率不错（${actionSuccessRate.toFixed(2)}），可以更自信一些`)
      addAdjustment('assertiveness', +0.03, '动作稳定时适当更主动')
      if (result.self_narrative === '一切正常~') result.self_narrative = '动作挺顺的，我可以更干脆点'
    }

    // 5) 整体 feedbackRatio (样本足够时)
    if (totalFeedback >= 3) {
      if (ratio < 0.45) {
        addInsight(`近期负面占比偏高（ratio=${ratio.toFixed(2)}）`)
        addAdjustment('assertiveness', -0.04, '负面偏多，减少打扰感')
        result.emotional_state = result.emotional_state === 'concerned' ? 'concerned' : 'uncertain'
        if (result.self_narrative === '一切正常~') result.self_narrative = '最近好像有点让人烦了…'
      } else if (ratio > 0.65) {
        addInsight(`近期反馈不错（ratio=${ratio.toFixed(2)}）`)
        if (posSignals >= 2) addAdjustment('playfulness', +0.03, '正面互动较多，保持可爱但别过头')
        if (result.self_narrative === '一切正常~') result.self_narrative = '大家好像挺喜欢我的~'
      }
    }

    // 6) 工具关联 (简单提示)
    if (negativeToolCounts.size) {
      const top = [...negativeToolCounts.entries()].sort((a, b) => b[1] - a[1])[0]
      if (top && top[0] && top[1] >= 2) {
        addInsight(`负面反馈多发生在工具 ${top[0]} 之后，可能需要更谨慎使用`)
        addAdjustment('curiosity', +0.02, '用工具前先确认目标与条件')
      }
    }

    // 最终清理
    if (!result.insights.length) {
      if (recentSignals.length === 0) addInsight('近期缺少可用反馈数据，先保持当前策略')
      else addInsight(`近期信号偏中性（正面=${posSignals} 负面=${negSignals}）`)
    }
    result.behavior_adjustments = result.behavior_adjustments
      .filter(a => a?.trait && typeof a.delta === 'number' && Number.isFinite(a.delta))
      .slice(0, 5)
      .map(a => ({ ...a, delta: Math.max(-0.1, Math.min(0.1, a.delta)) }))

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
        lastIntrospection: state.aiIntrospection?.lastRun,
        recentFeedback: state.aiFeedback?.recentSignals
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
