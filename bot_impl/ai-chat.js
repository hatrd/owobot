const H = require('./ai-chat-helpers')
const actionsMod = require('./actions')
const observer = require('./agent/observer')
const memoryStore = require('./memory-store')
const peopleStore = require('./people-store')
const { prepareAiState } = require('./ai-chat/state-init')
const { createAiCliHandler } = require('./ai-chat/cli')
const { createPulseService } = require('./ai-chat/pulse')
const { createMemoryService } = require('./ai-chat/memory')
const { createPeopleService } = require('./ai-chat/people')
const { createChatExecutor } = require('./ai-chat/executor')
const { createFeedbackCollector } = require('./ai-chat/feedback-collector')
const { createIntrospectionEngine } = require('./ai-chat/introspection')
const { createPureSurprise } = require('./ai-chat/pure-surprise')
const { createContextBus } = require('./ai-chat/context-bus')
const {
  DEFAULT_MODEL,
  DEFAULT_BASE,
  DEFAULT_CHAT_PATH,
  DEFAULT_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_COUNT,
  DEFAULT_RECENT_WINDOW_SEC,
  DEFAULT_MEMORY_STORE_MAX,
  buildDefaultContext
} = require('./ai-chat/config')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...args) => log.debug(...args)

  function now () { return Date.now() }
  function normalizeUsername (name) {
    return String(name || '').replace(/\u00a7./g, '').trim().toLowerCase()
  }

  function traceChat (...args) {
    if (state.ai?.trace && log?.info) {
      try { log.info(...args) } catch {}
    }
  }

  function dayStart (t = now()) {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  function monthStart (t = now()) {
    const d = new Date(t)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  function rollSpendWindows () {
    const t = now()
    const d0 = dayStart(t)
    const m0 = monthStart(t)
    if (state.aiSpend.day.start !== d0) state.aiSpend.day = { start: d0, inTok: 0, outTok: 0, cost: 0 }
    if (state.aiSpend.month.start !== m0) state.aiSpend.month = { start: m0, inTok: 0, outTok: 0, cost: 0 }
  }

  function projectedCostForCall (promptTok, outTokMax) {
    const { priceInPerKT, priceOutPerKT } = state.ai
    return H.projectedCostForCall(priceInPerKT, priceOutPerKT, promptTok, outTokMax)
  }

  function budgetRemaining () {
    rollSpendWindows()
    const { budgetDay, budgetMonth, budgetTotal } = state.ai
    const d = state.aiSpend.day.cost
    const m = state.aiSpend.month.cost
    const tot = state.aiSpend.total.cost
    return {
      day: budgetDay == null ? Infinity : Math.max(0, budgetDay - d),
      month: budgetMonth == null ? Infinity : Math.max(0, budgetMonth - m),
      total: budgetTotal == null ? Infinity : Math.max(0, budgetTotal - tot)
    }
  }

  function canAfford (promptTok) {
    const rem = budgetRemaining()
    const maxOutTok = state.ai.maxTokensPerCall || 512
    const proj = projectedCostForCall(promptTok, maxOutTok)
    const ok = (rem.day >= proj) && (rem.month >= proj) && (rem.total >= proj)
    return { ok, proj, rem }
  }

  function applyUsage (inTok, outTok) {
    rollSpendWindows()
    const { priceInPerKT, priceOutPerKT } = state.ai
    const cost = (inTok / 1000) * (priceInPerKT || 0) + (outTok / 1000) * (priceOutPerKT || 0)
    state.aiSpend.day.inTok += inTok
    state.aiSpend.day.outTok += outTok
    state.aiSpend.day.cost += cost
    state.aiSpend.month.inTok += inTok
    state.aiSpend.month.outTok += outTok
    state.aiSpend.month.cost += cost
    state.aiSpend.total.inTok += inTok
    state.aiSpend.total.outTok += outTok
    state.aiSpend.total.cost += cost
  }

  function buildGameContext () {
    try {
      const g = state.ai.context?.game
      if (!g || g.include === false) return ''
      const snap = observer.snapshot(bot, {
        invTop: g.invTop || 20,
        nearPlayerRange: g.nearPlayerRange || 16,
        nearPlayerMax: g.nearPlayerMax || 5,
        dropsRange: g.dropsRange || 8,
        dropsMax: g.dropsMax || 6,
        hostileRange: 24
      })
      return observer.toPrompt(snap)
    } catch { return '' }
  }

  const defaults = {
    DEFAULT_MODEL,
    DEFAULT_BASE,
    DEFAULT_CHAT_PATH,
    DEFAULT_PATH,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_RECENT_COUNT,
    DEFAULT_RECENT_WINDOW_SEC,
    DEFAULT_MEMORY_STORE_MAX,
    buildDefaultContext
  }
  const people = createPeopleService({ state, peopleStore, now, trace: traceChat })
  const memory = createMemoryService({ state, log, memoryStore, defaults, bot, people, traceChat, now })
  const persistedMemory = memoryStore.load()
  const persistedEvolution = memoryStore.loadEvolution()
  prepareAiState(state, {
    defaults,
    persistedMemory,
    persistedEvolution,
    trimConversationStore: memory.dialogue.trimStore,
    updateWorldMemoryZones: memory.longTerm.updateWorldZones,
    dayStart,
    monthStart
  })

  function validateAiConfig () {
    const errs = []
    const key = String(state.ai?.key || '').trim()
    const base = String(state.ai?.baseUrl || '').trim()
    const model = String(state.ai?.model || '').trim()
    if (!key) errs.push('DEEPSEEK_API_KEY / state.ai.key missing')
    try { new URL(base || defaults.DEFAULT_BASE) } catch { errs.push(`Invalid AI baseUrl: "${base}"`) }
    if (!model) errs.push('AI model missing (state.ai.model)')
    if (errs.length) {
      const msg = `[AI] Config error: ${errs.join('; ')}`
      if (log?.error) log.error(msg)
      else console.error(msg)
    }
  }
  validateAiConfig()

  async function probeResponsesThenFallback () {
    try {
      if (!state.ai || typeof state.ai !== 'object') return
      if (state.ai._probedResponses) return
      state.ai._probedResponses = true

      const key = String(state.ai.key || '').trim()
      if (!key) return

      const rawPath = String(state.ai.path || defaults.DEFAULT_PATH || '').trim()
      const useResponses = typeof H.isResponsesApiPath === 'function' && H.isResponsesApiPath(rawPath)
      if (!useResponses) return

      const url = H.buildAiUrl({ baseUrl: state.ai.baseUrl, path: rawPath, defaultBase: defaults.DEFAULT_BASE, defaultPath: defaults.DEFAULT_PATH })

      const body = {
        model: state.ai.model || defaults.DEFAULT_MODEL,
        input: [{ role: 'user', content: 'ping' }],
        max_output_tokens: 1
      }

      const ac = new AbortController()
      const timeout = setTimeout(() => ac.abort('probe_timeout'), 3500)
      let res
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ac.signal
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!res) return
      if (res.ok) return

      const status = res.status
      const hint = await res.text().catch(() => '')
      const msg = (() => {
        try {
          const j = JSON.parse(hint)
          const e = j?.error?.message ?? j?.message ?? j?.error
          return String(e || '').trim() || hint
        } catch {
          return hint
        }
      })()

      const shouldFallback = (() => {
        if ([404, 405, 410].includes(status)) return true
        if (status !== 400) return false
        const m = String(msg || '').toLowerCase()
        if (!m) return false
        // Heuristic: endpoint exists but expects chat-completions schema (messages/max_tokens) or rejects responses schema.
        if (m.includes('messages') && m.includes('required')) return true
        if (m.includes('max_tokens') && m.includes('required')) return true
        if (m.includes('unrecognized') && (m.includes('input') || m.includes('max_output_tokens') || m.includes('reasoning'))) return true
        if (m.includes('unknown') && (m.includes('endpoint') || m.includes('route') || m.includes('path'))) return true
        if (m.includes('not found')) return true
        return false
      })()

      if (!shouldFallback) return
      state.ai.pathOverride = defaults.DEFAULT_CHAT_PATH
      if (log?.warn) log.warn('[AI] /responses unsupported; fallback to chat-completions. status=', status, 'hint=', String(msg || '').slice(0, 160))
      else console.warn('[AI] /responses unsupported; fallback to chat-completions. status=', status, 'hint=', String(msg || '').slice(0, 160))
    } catch (err) {
      // Probe is best-effort: never break startup.
      if (state.ai?.trace && log?.info) {
        try { log.info('[AI] responses probe skipped:', err?.message || err) } catch {}
      }
    }
  }
  probeResponsesThenFallback().catch(() => {})

  const refsEnabled = state.ai?.refsEnabled !== false

  // REFS: 创建反馈收集器
  const feedbackCollector = refsEnabled
    ? createFeedbackCollector({ state, bot, log, now, memoryStore, memory })
    : null

  // 定时刷新反馈窗口，防止无新消息时反馈卡住
  const feedbackTimer = refsEnabled
    ? setInterval(() => {
      try { feedbackCollector.tick() } catch {}
    }, 10000)
    : null

  // REFS: 创建上下文总线
  const contextBus = createContextBus({ state, now })

  function recordPickupEvent (entity) {
    try {
      if (!contextBus || !entity) return
      const drop = (typeof entity.getDroppedItem === 'function') ? entity.getDroppedItem() : null
      const rawName = (() => {
        if (drop?.name) return drop.name
        if (entity?.item?.name) return entity.item.name
        if (entity?.displayName) return entity.displayName
        if (entity?.name) return entity.name
        return 'item'
      })()
      const name = String(rawName || 'item').replace(/\u00a7./g, '')
      const rawCount = drop?.count ?? entity?.item?.count
      const count = (Number.isFinite(rawCount) && rawCount > 0) ? Math.floor(rawCount) : 1
      const data = count > 1 ? `${name} x${count}` : name
      contextBus.pushEvent('pickup', data)
    } catch {}
  }

  const onPlayerCollect = (collector, collected) => {
    try {
      if (!collector || collector !== bot.entity) return
      recordPickupEvent(collected)
    } catch {}
  }
  on('playerCollect', onPlayerCollect)
  registerCleanup && registerCleanup(() => { try { bot.off('playerCollect', onPlayerCollect) } catch {} })

  let executor
  const pulse = createPulseService({
    state,
    bot,
    log,
    now,
    H,
    defaults,
    canAfford,
    applyUsage,
    buildContextPrompt: (name) => executor.buildContextPrompt(name),
    buildGameContext,
    traceChat,
    memory,
    feedbackCollector,
    contextBus
  })
  executor = createChatExecutor({
    state,
    bot,
    log,
    actionsMod,
    H,
    defaults,
    now,
    traceChat,
    pulse,
    memory,
    people,
    canAfford,
    applyUsage,
    buildGameContext,
    contextBus
  })
  try { bot._aiChatExecutor = executor } catch {}

  memory.setMessenger(pulse.sendDirectReply)

  const AUTO_LOOK_GREET_COOLDOWN_MS = 10 * 60 * 1000
  function ensureAutoLookState () {
    if (!state.autoLookGreet || typeof state.autoLookGreet !== 'object') state.autoLookGreet = {}
    const slice = state.autoLookGreet
    if (!(slice.cooldowns instanceof Map)) slice.cooldowns = new Map()
    if (!(slice.inFlight instanceof Set)) slice.inFlight = new Set()
    if (!(slice.lastEmit instanceof Map)) slice.lastEmit = new Map()
    return slice
  }

  async function onAutoLookGreet (payload) {
    try {
      if (!state.ai?.enabled || !state.ai?.key) return
      const usernameRaw = String(payload?.username || payload?.name || payload?.player || '').trim()
      const key = normalizeUsername(usernameRaw)
      if (!key) return
      const selfKey = normalizeUsername(bot.username || '')
      if (selfKey && key === selfKey) return
      const slice = ensureAutoLookState()
      const nowTs = now()
      const last = slice.cooldowns.get(key)
      if (Number.isFinite(last) && (nowTs - last) < AUTO_LOOK_GREET_COOLDOWN_MS) return
      if (slice.inFlight.has(key)) return
      slice.inFlight.add(key)
      let cooldowned = false
      try {
        const prompt = `玩家 ${usernameRaw} 正在你身边并被你注意到，请用一句温暖、自然的中文主动打招呼，鼓励对方继续聊天，控制在20字以内。`
        const intent = { topic: 'greet', kind: 'chat', nearby: true }
        const { reply } = await executor.callAI(usernameRaw, prompt, intent, { inlineUserContent: true })
        const text = String(reply || '').trim()
        if (!text) {
          cooldowned = true
          return
        }
        pulse.sendChatReply(usernameRaw, text, { reason: 'look_greet', from: 'LLM' })
        cooldowned = true
      } catch (err) {
        log?.warn && log.warn('auto-look greet error:', err?.message || err)
      } finally {
        slice.inFlight.delete(key)
        if (cooldowned) slice.cooldowns.set(key, nowTs)
      }
    } catch {}
  }
  bot.on('auto-look:greet', onAutoLookGreet)
  registerCleanup && registerCleanup(() => { try { bot.off('auto-look:greet', onAutoLookGreet) } catch {} })

  const onChat = (username, message) => { executor.handleChat(username, message).catch(() => {}) }
  const onChatCapture = (username, message) => pulse.captureChat(username, message)
  const onMessage = (message) => {
    const parsed = pulse.captureSystemMessage(message)
    if (parsed && parsed.name && parsed.content) {
      executor.handleChat(parsed.name, parsed.content).catch(() => {})
    }
  }
  on('chat', onChatCapture)
  on('chat', onChat)
  on('message', onMessage)



  // REFS: Introspection AI call wrapper (DeepSeek; respects budget)
  async function aiCall ({ systemPrompt, userPrompt, maxTokens, temperature }) {
    const { key, baseUrl, path, pathOverride, model } = state.ai || {}
    if (!key) throw new Error('AI key not configured')
    const apiPath = pathOverride || path || defaults.DEFAULT_PATH
    const url = H.buildAiUrl({ baseUrl, path: apiPath, defaultBase: defaults.DEFAULT_BASE, defaultPath: defaults.DEFAULT_PATH })

    const messages = [
      systemPrompt ? { role: 'system', content: String(systemPrompt) } : null,
      { role: 'user', content: String(userPrompt || '') }
    ].filter(Boolean)

    const estIn = H.estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (!afford.ok) {
      throw new Error(state.ai.notifyOnBudget ? 'AI余额不足，稍后再试~' : 'budget_exceeded')
    }

    const reqMax = Number(maxTokens)
    const maxOut = Number.isFinite(reqMax) && reqMax > 0 ? Math.floor(reqMax) : 256
    const cappedOut = Math.max(60, Math.min(maxOut, state.ai.maxTokensPerCall || 1024))
    const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2

    const useResponses = typeof H.isResponsesApiPath === 'function' && H.isResponsesApiPath(apiPath)
    const body = useResponses
      ? {
          model: model || defaults.DEFAULT_MODEL,
          input: messages,
          max_output_tokens: cappedOut,
          ...(state.ai?.reasoningEffort ? { reasoning: { effort: String(state.ai.reasoningEffort) } } : null)
        }
      : {
          model: model || defaults.DEFAULT_MODEL,
          messages,
          temperature: temp,
          max_tokens: cappedOut,
          stream: false
        }

    const ac = new AbortController()
    const timeoutMs = Number.isFinite(state.ai?.timeoutMs) && state.ai.timeoutMs > 0
      ? state.ai.timeoutMs
      : defaults.DEFAULT_TIMEOUT_MS
    const timeout = setTimeout(() => ac.abort('timeout'), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status))
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      const reply = typeof H.extractAssistantTextFromApiResponse === 'function'
        ? H.extractAssistantTextFromApiResponse(data, { allowReasoning: false })
        : H.extractAssistantText(data?.choices?.[0]?.message, { allowReasoning: false })
      const usage = typeof H.extractUsageFromApiResponse === 'function' ? H.extractUsageFromApiResponse(data) : { inTok: null, outTok: null }
      const inTok = Number.isFinite(usage.inTok) ? usage.inTok : estIn
      const outTok = Number.isFinite(usage.outTok) ? usage.outTok : H.estTokensFromText(reply)
      applyUsage(inTok, outTok)
      return String(reply).trim()
    } finally {
      clearTimeout(timeout)
    }
  }

  // REFS: 创建自省引擎
  const introspection = refsEnabled
    ? createIntrospectionEngine({
      state,
      bot,
      log,
      now,
      feedbackCollector,
      memory,
      memoryStore,
      aiCall
    })
    : {
        start: () => {},
        stop: () => {},
        runIntrospection: async () => null,
        getEffectivePersonality: () => (state.aiPersonality?.traits || {}),
        getStatus: () => ({
          running: false,
          lastRun: state.aiIntrospection?.lastRun || null,
          historyCount: Array.isArray(state.aiIntrospection?.history) ? state.aiIntrospection.history.length : 0,
          consecutiveNegative: state.aiIntrospection?.consecutiveNegative || 0,
          personality: state.aiPersonality?.traits || {},
          emotionalState: state.aiEmotionalState
        }),
        checkEmergencyIntrospection: () => {},
        persistState: () => {}
      }
  introspection.start()

  // REFS: 纯粹惊讶引擎（意识最简原理）
  const mind = refsEnabled
    ? createPureSurprise({
      state,
      bot,
      observer,
      log,
      now
    })
    : {
        start: () => {},
        stop: () => {},
        getStatus: () => ({ running: false, surprise: 0, curious: null, knownStates: 0, history: [] }),
        whatFollows: () => [],
        predict: () => null
      }
  mind.start()

  // REFS: 监听玩家消息以收集反馈
  const onFeedbackCapture = (username, message) => {
    try {
      if (!feedbackCollector) return
      if (username === bot.username) return
      const result = feedbackCollector.processPlayerMessage(username, message)
      if (result && result.signals?.length) {
        // 如果有信号，检查是否需要紧急自省
        introspection.checkEmergencyIntrospection()
      }
    } catch {}
  }
  on('chat', onFeedbackCapture)

  // REFS: 监听技能结束事件
  const onSkillEnd = (data) => {
    try {
      if (feedbackCollector) {
        feedbackCollector.recordActionOutcome({
          taskName: data.name,
          success: data.status === 'succeeded',
          duration: data.duration,
          failureReason: data.failureReason,
          triggeredBy: data.triggeredBy
        })
      }
      const eventType = data.status === 'succeeded' ? 'skill.end' : 'skill.fail'
      const info = data.status === 'succeeded'
        ? `${data.name}:success`
        : `${data.name}:${data.failureReason || 'failed'}`
      contextBus.pushEvent(eventType, info)
    } catch {}
  }
  bot.on('skill:end', onSkillEnd)

  // REFS: 监听死亡和重生事件
  const onDeath = () => {
    try { contextBus.pushEvent('death', 'bot died') } catch {}
  }
  const onRespawn = () => {
    try { contextBus.pushEvent('respawn', 'bot respawned') } catch {}
  }
  bot.on('death', onDeath)
  bot.on('respawn', onRespawn)

  // REFS: 玩家上下线事件 — 服务器消息已通过 pushServer 捕获，无需冗余事件
  // const onPlayerJoined = (player) => { ... }
  // const onPlayerLeft = (player) => { ... }

  // REFS: 伤害事件检测与类型推断
  let lastHpForDamage = null
  let lastDamageSource = { id: null, at: 0 }
  let lastOnGround = null
  let fallStartY = null
  let lastLandAt = 0
  let lastFallDist = 0
  let lastExplosionAt = 0

  function fmtHpDelta (n) {
    if (!Number.isFinite(n)) return ''
    const v = Math.round(n * 10) / 10
    return v === Math.floor(v) ? String(v) : v.toFixed(1)
  }

  function headInWater () {
    try {
      const pos = bot.entity?.position
      if (!pos) return false
      const head = bot.blockAt(pos.offset(0, 1.6, 0))
      const name = String(head?.name || '').toLowerCase()
      return name.includes('water') || head?.getProperties?.()?.waterlogged === true
    } catch { return false }
  }

  function getEntityName (ent) {
    if (!ent) return null
    if (ent.type === 'player') return ent.username || ent.displayName || null
    const raw = ent.name || ent.displayName || ent.mobType || ''
    return String(raw).replace(/\u00a7./g, '').toLowerCase() || null
  }

  const onMove = () => {
    try {
      const me = bot.entity
      if (!me?.position) return
      const onGround = !!me.onGround
      if (lastOnGround == null) { lastOnGround = onGround; return }
      if (onGround === lastOnGround) return
      if (lastOnGround && !onGround) {
        fallStartY = me.position.y
      } else {
        if (Number.isFinite(fallStartY)) {
          lastFallDist = Math.max(0, fallStartY - me.position.y)
          lastLandAt = now()
        }
        fallStartY = null
      }
      lastOnGround = onGround
    } catch {}
  }

  const onEntityHurt = (entity, source) => {
    try {
      if (entity !== bot.entity) return
      lastDamageSource = { id: source?.id ?? null, at: now() }
    } catch {}
  }

  const onExplosion = () => {
    try { lastExplosionAt = now() } catch {}
  }
  bot.on('move', onMove)
  bot.on('entityHurt', onEntityHurt)
  bot.on('explosion', onExplosion)

  // REFS: 监听生命值变化 (伤害 + 治疗)
  let lastHealthWarning = 0
  const onHealth = () => {
    try {
      const nowTs = now()
      const hp = Number(bot.health)
      if (lastHpForDamage == null) {
        lastHpForDamage = hp
      } else if (Number.isFinite(hp)) {
        const delta = hp - lastHpForDamage
        if (delta < -0.01) {
          const srcId = lastDamageSource.id == null ? NaN : Number(lastDamageSource.id)
          const srcEnt = Number.isFinite(srcId) ? bot.entities?.[srcId] : null
          const recentCombat = !!(
            srcEnt && srcEnt !== bot.entity &&
            (srcEnt.type === 'player' || srcEnt.type === 'mob') &&
            (nowTs - lastDamageSource.at) <= 1500
          )
          const recentExplosion = (nowTs - lastExplosionAt) <= 1500
          const onFire = !!(bot.entity?.onFire || bot.entity?.isOnFire)
          const inWater = headInWater()
          const recentFall = lastFallDist >= 3 && (nowTs - lastLandAt) <= 1200
          const isStarving = Number(bot.food) === 0
          let kind, detail
          if (recentCombat) {
            kind = 'combat'
            detail = getEntityName(srcEnt)
          } else if (recentExplosion) {
            kind = 'explosion'
          } else if (onFire) {
            kind = 'fire'
          } else if (inWater) {
            kind = 'drown'
          } else if (recentFall) {
            kind = 'fall'
          } else if (isStarving) {
            kind = 'hunger'
          } else {
            kind = 'other'
          }
          const d = fmtHpDelta(delta)
          const data = detail ? `${detail}:${d}` : `hp:${d}`
          if (d) contextBus.pushEvent(`hurt.${kind}`, data)
        } else if (delta > 0.5) {
          const d = fmtHpDelta(delta)
          if (d) contextBus.pushEvent('heal', `hp:+${d}`)
        }
        lastHpForDamage = hp
      }
      if (bot.health <= 6 && nowTs - lastHealthWarning > 30000) {
        lastHealthWarning = nowTs
        contextBus.pushEvent('health.low', `hp:${Math.floor(bot.health)}`)
      }
    } catch {}
  }
  bot.on('health', onHealth)

  // REFS: 定时衰减和持久化
  const decayTimer = setInterval(() => {
    try {
      memory.longTerm.decayUnused()
      memory.dialogue.maybeRunAggregation().catch(() => {})
      if (feedbackCollector) feedbackCollector.persistState()
    } catch {}
  }, 60 * 60 * 1000) // 每小时

  const aiCliHandler = createAiCliHandler({
    bot,
    state,
    log,
    actionsMod,
    buildGameContext,
    buildContextPrompt: executor.buildContextPrompt,
    buildMetaContext: executor.buildMetaContext,
    persistMemoryState: memory.longTerm.persistState,
    selectDialoguesForContext: memory.dialogue.selectForContext,
    formatDialogueEntriesForDisplay: memory.dialogue.formatEntriesForDisplay,
    DEFAULT_RECENT_COUNT,
    DEFAULT_RECENT_WINDOW_SEC,
    rollSpendWindows,
    dayStart,
    monthStart,
    feedbackCollector,
    introspection,
    memory,
    people,
    mind
  })

  on('cli', aiCliHandler)

  registerCleanup && registerCleanup(() => {
    try { bot.off('chat', onChat) } catch {}
    try { bot.off('chat', onChatCapture) } catch {}
    try { bot.off('chat', onFeedbackCapture) } catch {}
    try { bot.off('message', onMessage) } catch {}
    try { bot.off('cli', aiCliHandler) } catch {}
    try { bot.off('skill:end', onSkillEnd) } catch {}
    try { bot.off('death', onDeath) } catch {}
    try { bot.off('respawn', onRespawn) } catch {}
    try { bot.off('health', onHealth) } catch {}
    try { bot.off('move', onMove) } catch {}
    try { bot.off('entityHurt', onEntityHurt) } catch {}
    try { bot.off('explosion', onExplosion) } catch {}
    try { clearInterval(feedbackTimer) } catch {}
    try { clearInterval(decayTimer) } catch {}
    pulse.stop()
    introspection.stop()
    mind.stop()
    executor.abortActive()
    try {
      if (bot && bot._aiChatExecutor === executor) delete bot._aiChatExecutor
    } catch {}
  })
}

module.exports = { install }
