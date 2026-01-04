const { buildToolFunctionList, isActionToolAllowed } = require('./tool-schemas')
const timeUtils = require('../time-utils')
const feedbackPool = require('./feedback-pool')

const TOOL_FUNCTIONS = buildToolFunctionList()
const LONG_TASK_TOOLS = new Set([
  'goto', 'goto_block', 'follow_player', 'hunt_player', 'defend_area', 'defend_player',
  'break_blocks', 'place_blocks', 'light_area', 'collect', 'pickup', 'gather', 'harvest',
  'feed_animals', 'cull_hostiles', 'mount_near', 'mount_player', 'autofish', 'mine_ore',
  'range_attack', 'attack_armor_stand', 'skill_start', 'sort_chests', 'deposit', 'deposit_all', 'withdraw',
  'withdraw_all'
])
const TELEPORT_COMMANDS = new Set(['tpa', 'tpaccept', 'tpahere', 'back', 'home', 'spawn', 'warp', 'rtp'])

function createChatExecutor ({
  state,
  bot,
  log,
  actionsMod,
  H,
  defaults,
  now = () => Date.now(),
  traceChat = () => {},
  pulse,
  memory,
  canAfford,
  applyUsage,
  buildGameContext,
  contextBus = null
}) {
  const ctrl = { busy: false, abort: null, pending: [], plan: null, planTimer: null, planDriving: false, lastUser: null }
  const actions = actionsMod.install(bot, { log })

  const estTokensFromText = H.estTokensFromText
  const metaTimeZone = (() => {
    try { return timeUtils.getTimeZone() } catch { return 'Asia/Shanghai' }
  })()
  const metaTimeFormatter = (() => {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: metaTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
    } catch {
      return null
    }
  })()

  function pendingExpireMs () {
    const timeoutMs = Number.isFinite(state.ai?.timeoutMs) && state.ai.timeoutMs > 0
      ? state.ai.timeoutMs
      : defaults.DEFAULT_TIMEOUT_MS
    return Math.max(8000, timeoutMs + 2000)
  }

  function queuePending (username, content, raw, source) {
    const text = String(content || '').trim()
    if (!text || !username) return
    if (!Array.isArray(ctrl.pending)) ctrl.pending = []
    const nowTs = now()
    const rawText = typeof raw === 'string' ? raw : text
    const existing = ctrl.pending.find(entry => entry && entry.username === username)
    if (existing) {
      existing.parts.push(text)
      existing.rawParts.push(rawText)
      existing.lastAt = nowTs
      if (source === 'trigger') existing.source = 'trigger'
      // Keep approximate recency order when merging.
      try {
        const idx = ctrl.pending.indexOf(existing)
        if (idx >= 0 && idx !== ctrl.pending.length - 1) {
          ctrl.pending.splice(idx, 1)
          ctrl.pending.push(existing)
        }
      } catch {}
      return
    }
    ctrl.pending.push({
      username,
      parts: [text],
      rawParts: [rawText],
      source: source === 'trigger' ? 'trigger' : 'followup',
      firstAt: nowTs,
      lastAt: nowTs
    })
  }

  function takePendingBatch () {
    if (!Array.isArray(ctrl.pending) || !ctrl.pending.length) return null
    const maxAge = pendingExpireMs()
    const kept = []
    for (const entry of ctrl.pending) {
      if (!entry || !entry.username || !Array.isArray(entry.parts) || !entry.parts.length) continue
      const lastAt = entry.lastAt || entry.firstAt || 0
      if (lastAt && (now() - lastAt) > maxAge) continue
      kept.push(entry)
    }
    ctrl.pending = []
    return kept.length ? kept : null
  }

  function buildPendingBatchText (batch) {
    const lines = []
    const names = [...new Set(batch.map(e => String(e?.username || '').trim()).filter(Boolean))]
    lines.push('【上一轮回复期间收到的新消息（批量，多玩家）】')
    if (names.length) lines.push(`参与玩家：${names.join('、')}`)
    for (const entry of batch) {
      const joined = Array.isArray(entry.parts) ? entry.parts.join('\n') : ''
      if (!joined) continue
      lines.push(`${entry.username}: ${joined}`)
    }
    lines.push([
      '这是对多个玩家的批量对话输入。',
      '如果需要分别回应，请用 say 工具分次发送；每条消息开头用“玩家名：”来点名（不要用 @）。',
      '对不需要回应的玩家，不要发送该玩家的消息。',
      '如果某个玩家在消息里明确要求“记住/记一下/记下来…”，请调用 write_memory 工具保存，不要只口头答应。'
    ].join(''))
    return lines.join('\n')
  }

  async function processPendingBatch (batch) {
    if (!Array.isArray(batch) || !batch.length) return
    if (ctrl.busy) return
    const owner = (() => {
      for (let i = batch.length - 1; i >= 0; i--) {
        const entry = batch[i]
        if (!entry) continue
        if (entry.source !== 'trigger') continue
        const name = String(entry.username || '').trim()
        if (name) return name
      }
      const last = batch[batch.length - 1]
      return String(last?.username || '').trim()
    })()
    if (!owner) return
    const content = buildPendingBatchText(batch)
    if (!content.trim()) return
    const raw = batch.map(e => {
      const joined = Array.isArray(e.rawParts) ? e.rawParts.join('\n') : (Array.isArray(e.parts) ? e.parts.join('\n') : '')
      return joined ? `${e.username}: ${joined}` : ''
    }).filter(Boolean).join('\n')
    const source = batch.some(e => e && e.source === 'trigger') ? 'trigger' : 'followup'
    const lastText = (() => {
      const lastEntry = batch[batch.length - 1]
      const parts = Array.isArray(lastEntry?.parts) ? lastEntry.parts : []
      return parts.length ? String(parts[parts.length - 1] || '') : ''
    })()
    const intent = classifyIntent(lastText || content)
    ctrl.busy = true
    ctrl.lastUser = owner
    try {
      if (state.ai.trace && log?.info) log.info('ask(pending) <-', content)
      const allowSkip = source === 'followup'
      const { reply, memoryRefs } = await callAI(owner, content, intent, { allowSkip })
      if (reply) {
        noteUsage(owner)
        if (allowSkip && /^skip$/i.test(reply.trim())) {
          traceChat('[chat] pending batch skipped', { owner })
          return
        }
        pulse.sendChatReply(owner, reply, { reason: 'llm_pending', from: 'LLM', memoryRefs, suppressFeedback: true })
      }
    } catch (e) {
      log?.warn && log.warn('ai pending error:', e?.message || e)
    } finally {
      ctrl.busy = false
      flushPending()
    }
  }

  function flushPending () {
    if (ctrl.busy) return false
    const batch = takePendingBatch()
    if (!batch) return false
    setTimeout(() => { processPendingBatch(batch).catch(() => {}) }, 0)
    return true
  }

  function trimWindow (arr, windowMs) {
    const t = now()
    return arr.filter(ts => t - ts <= windowMs)
  }

  function statFor (username) {
    if (!state.aiStats.perUser.has(username)) state.aiStats.perUser.set(username, [])
    return state.aiStats.perUser.get(username)
  }

  function canProceed (username) {
    const L = state.ai.limits
    if (!L) return { ok: true }
    const t = now()
    const userArr = statFor(username)
    const globArr = state.aiStats.global
    if (L.cooldownMs && userArr.length > 0) {
      const last = userArr[userArr.length - 1]
      if (t - last < L.cooldownMs) return { ok: false, reason: 'cooldown' }
    }
    if (L.userPerMin != null) {
      const u1 = trimWindow(userArr, 60_000)
      if (u1.length >= L.userPerMin) return { ok: false, reason: 'userPerMin' }
    }
    if (L.userPerDay != null) {
      const uD = trimWindow(userArr, 86_400_000)
      if (uD.length >= L.userPerDay) return { ok: false, reason: 'userPerDay' }
    }
    if (L.globalPerMin != null) {
      const g1 = trimWindow(globArr, 60_000)
      if (g1.length >= L.globalPerMin) return { ok: false, reason: 'globalPerMin' }
    }
    if (L.globalPerDay != null) {
      const gD = trimWindow(globArr, 86_400_000)
      if (gD.length >= L.globalPerDay) return { ok: false, reason: 'globalPerDay' }
    }
    return { ok: true }
  }

  function noteUsage (username) {
    const t = now()
    state.aiStats.global.push(t)
    const arr = statFor(username)
    arr.push(t)
    state.aiStats.global = trimWindow(state.aiStats.global, 86_400_000)
    const recent = trimWindow(arr, 86_400_000)
    state.aiStats.perUser.set(username, recent)
  }

  function triggerWord () {
    try {
      const raw = String(bot.username || '').match(/[a-z0-9]/gi)?.join('') || ''
      const pfx = raw.slice(0, 3).toLowerCase()
      return pfx || 'bot'
    } catch { return 'bot' }
  }

  function systemPrompt () {
    const raw = loadFile('ai-system.txt')
    if (!raw) throw new Error('ai-system.txt missing; cannot build system prompt')
    const botName = bot?.username || 'bot'
    return raw.replace(/{{BOT_NAME}}/g, botName)
  }

  function buildMetaContext () {
    try {
      if (!metaTimeFormatter) throw new Error('no formatter')
      const parts = {}
      const nowDate = new Date(now())
      for (const part of metaTimeFormatter.formatToParts(nowDate)) {
        if (part.type === 'literal') continue
        parts[part.type] = part.value
      }
      const segments = []
      if (parts.year) segments.push(`${parts.year}年`)
      if (parts.month) segments.push(`${parts.month}月`)
      if (parts.day) segments.push(`${parts.day}日`)
      if (parts.hour) segments.push(`${parts.hour}时`)
      if (parts.minute) segments.push(`${parts.minute}分`)
      const timeText = segments.join('')
      if (!timeText) throw new Error('empty time')
      const weekday = timeUtils.getWeekdayLabel(nowDate)
      const holidays = timeUtils.detectHolidays(nowDate)
      const holidayText = holidays.length ? ` 今日节日：${holidays.join('、')}` : ''
      const weekdayText = weekday ? ` ${weekday}` : ''
      return `现在是北京时间 ${timeText}${weekdayText}${holidayText}，你在 ShikiMC 服务器中。服主为 Shiki。`
    } catch {
      return '你在 ShikiMC 服务器中。服主为 Shiki。'
    }
  }

  function buildContextPrompt (username) {
    const ctx = state.ai.context || {
      include: true,
      recentCount: defaults.DEFAULT_RECENT_COUNT,
      recentWindowSec: defaults.DEFAULT_RECENT_WINDOW_SEC
    }
    if (contextBus) {
      const maxEntries = Number.isFinite(ctx.recentCount) ? Math.max(1, ctx.recentCount) : defaults.DEFAULT_RECENT_COUNT
      const windowSec = Number.isFinite(ctx.recentWindowSec)
        ? Math.max(0, ctx.recentWindowSec)
        : defaults.DEFAULT_RECENT_WINDOW_SEC
      const xmlCtx = contextBus.buildXml({
        maxEntries,
        windowSec,
        includeGaps: true
      })
      const conv = memory.dialogue.buildPrompt(username)
      const parts = [`当前对话玩家: ${username}`, xmlCtx, conv].filter(Boolean)
      return parts.join('\n\n')
    }
    const base = H.buildContextPrompt(username, state.aiRecent, { ...ctx, trigger: triggerWord() })
    const conv = memory.dialogue.buildPrompt(username)
    return [base, conv].filter(Boolean).join('\n\n')
  }

  function getMinimalSelfInstance () {
    try {
      return require('../minimal-self').getInstance()
    } catch { return null }
  }

  function gateActionWithIdentity (toolName) {
    try {
      const ms = getMinimalSelfInstance()
      if (!ms || typeof ms.scoreAction !== 'function') return null
      const res = ms.scoreAction(toolName)
      if (!res || !Number.isFinite(res.score)) return null
      if (contextBus) {
        try { contextBus.pushEvent('minimalSelf.score', `${toolName}:${res.score.toFixed(2)}`) } catch {}
      }
      return res
    } catch { return null }
  }

  function classifyIntent (text) {
    const trimmed = String(text || '').trim()
    const lower = trimmed.toLowerCase()
    const intent = { topic: 'generic', nearby: false, kind: 'chat' }
    if (!trimmed) return intent
    if (/^\/tpa\s+/i.test(trimmed)) return { topic: 'command', nearby: false, kind: 'command' }
    if (/座标|坐标|坐標|在哪|哪|where|位置/.test(trimmed)) intent.topic = 'position'
    if (/谁|player|玩家|同行|online/.test(lower)) intent.topic = 'players'
    if (/掉落|战利|loot|drop/.test(lower)) intent.topic = 'drops'
    if (/附近|near|around|周围/.test(lower)) intent.nearby = true
    if (/攻击|追|清|守|打|kill|defend|hunt/.test(lower)) intent.kind = 'action'
    if (/观察|看看|look|observe/.test(lower)) intent.topic = 'observe'
    return intent
  }

  function clearPlan (reason = 'unknown') {
    if (ctrl.planTimer) {
      try { clearTimeout(ctrl.planTimer) } catch {}
      ctrl.planTimer = null
    }
    const existing = ctrl.plan
    if (!existing) return
    ctrl.plan = null
    ctrl.planDriving = false
    try { contextBus?.pushEvent('plan.stop', reason) } catch {}
    flushPending()
  }

  function schedulePlanTick (delay = 150) {
    if (!ctrl.plan || ctrl.planDriving) return
    if (ctrl.planTimer) return
    ctrl.planTimer = setTimeout(() => {
      ctrl.planTimer = null
      drivePlanStep().catch((err) => { log?.warn && log.warn('plan drive error', err?.message || err) })
    }, Math.max(0, delay))
  }

  function startPlanMode ({ username, goal, steps }) {
    const normalized = Array.isArray(steps) ? steps.map(s => String(s || '').trim()).filter(Boolean) : []
    if (!normalized.length) return false
    clearPlan('replace')
    const limited = normalized.slice(0, 8)
    ctrl.plan = {
      owner: username,
      goal: goal ? String(goal) : '',
      steps: limited,
      index: 0,
      startedAt: now()
    }
    const preview = limited.map((s, i) => `${i + 1}. ${s}`).join(' ')
    pulse.sendChatReply(username, `采用计划模式（${limited.length}步）：${preview}`, { reason: 'plan_start' })
    try { contextBus?.pushEvent('plan.start', `${username}:${limited.length}`) } catch {}
    schedulePlanTick(0)
    return true
  }

  async function drivePlanStep () {
    const plan = ctrl.plan
    if (!plan || plan.index == null) return
    if (plan.index >= plan.steps.length) {
      pulse.sendChatReply(plan.owner, '计划完成~', { reason: 'plan_done' })
      clearPlan('done')
      flushPending()
      return
    }
    if (ctrl.busy) { schedulePlanTick(200); return }
    ctrl.planDriving = true
    ctrl.busy = true
    const stepText = String(plan.steps[plan.index])
    const stepNo = plan.index + 1
    const content = [
      `计划模式：第${stepNo}/${plan.steps.length}步`,
      plan.goal ? `目标：${plan.goal}` : '',
      `步骤：${stepText}`,
      '请直接调用工具完成；若暂时无需行动请使用 skip{} 工具。'
    ].filter(Boolean).join('\n')
    let reply = ''
    let memoryRefs = []
    try {
      const res = await callAI(plan.owner, content, { topic: 'plan', kind: 'chat' }, { allowSkip: true })
      reply = res.reply
      memoryRefs = res.memoryRefs
    } catch (e) {
      log?.warn && log.warn('plan step error', e?.message || e)
      pulse.sendChatReply(plan.owner, '计划执行失败，已停下', { reason: 'plan_error' })
      clearPlan('error')
      flushPending()
      ctrl.planDriving = false
      ctrl.busy = false
      return
    }
    ctrl.planDriving = false
    ctrl.busy = false
    if (!ctrl.plan || ctrl.plan !== plan) return
    plan.index += 1
    if (reply && !/^skip$/i.test(String(reply).trim())) {
      pulse.sendChatReply(plan.owner, reply, { reason: 'plan_step', from: 'LLM', memoryRefs })
    }
    flushPending()
    schedulePlanTick(150)
  }

  function shouldAutoFollowup (username, text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) { traceChat('[chat] followup skip empty', { username }); return false }
    if (state.ai?.listenEnabled === false) { traceChat('[chat] followup listen-disabled', { username }); return false }
    const lastReason = state?.aiPulse?.lastReason
    const lastAt = state?.aiPulse?.lastMessageAt
    if (lastReason === 'drive' && (!lastAt || (now() - lastAt) < 180000)) {
      traceChat('[chat] followup drive-active', { username })
      return true
    }
    if (!state.ai.enabled) { traceChat('[chat] followup ai-disabled', { username }); return false }
    if (!username || username === bot.username) { traceChat('[chat] followup self/unknown', { username }); return false }
    if (!pulse.isUserActive(username)) { traceChat('[chat] followup inactive', { username }); return false }
    const trig = triggerWord()
    if (!trig) return true
    const startRe = new RegExp('^' + trig, 'i')
    return !startRe.test(trimmed)
  }

  async function callAI (username, content, intent, options = {}) {
    const { key, baseUrl, path, model, maxReplyLen } = state.ai
    if (!key) throw new Error('AI key not configured')
    const url = H.buildAiUrl({ baseUrl, path, defaultBase: defaults.DEFAULT_BASE, defaultPath: defaults.DEFAULT_PATH })
    const contextPrompt = buildContextPrompt(username)
    const gameCtx = buildGameContext()
    const memoryCtxResult = await memory.longTerm.buildContext({ query: content, withRefs: true })
    const memoryCtx = typeof memoryCtxResult === 'string' ? memoryCtxResult : (memoryCtxResult?.text || '')
    const memoryRefs = Array.isArray(memoryCtxResult?.refs) ? memoryCtxResult.refs : []
    // M2: Identity context from minimal-self
    const identityCtx = (() => {
      try {
        const ms = getMinimalSelfInstance()
        return ms?.buildIdentityContext?.() || ''
      } catch { return '' }
    })()
    const metaCtx = buildMetaContext()
    const allowSkip = options?.allowSkip === true
    const userContent = allowSkip ? `${content}\n\n（如果暂时不需要回复，请只输出单词 SKIP。）` : content
    const messages = [
      { role: 'system', content: systemPrompt() },
      metaCtx ? { role: 'system', content: metaCtx } : null,
      gameCtx ? { role: 'system', content: gameCtx } : null,
      identityCtx ? { role: 'system', content: identityCtx } : null,
      memoryCtx ? { role: 'system', content: memoryCtx } : null,
      { role: 'system', content: contextPrompt },
      { role: 'user', content: userContent }
    ].filter(Boolean)
    if (state.ai.trace && log?.info) {
      try {
        log.info('gameCtx ->', gameCtx)
        log.info('chatCtx ->', buildContextPrompt(username))
        log.info('memoryCtx ->', memoryCtx)
      } catch {}
    }
    const estIn = estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (state.ai.trace && log?.info) log.info('precheck inTok~=', estIn, 'projCost~=', (afford.proj || 0).toFixed(4), 'rem=', afford.rem)
    if (!afford.ok) {
      const msg = state.ai.notifyOnBudget ? 'AI余额不足，稍后再试~' : ''
      throw new Error(msg || 'budget_exceeded')
    }
    const body = {
      model: model || defaults.DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: Math.max(120, Math.min(512, state.ai.maxTokensPerCall || 256)),
      stream: false,
      tools: TOOL_FUNCTIONS
    }
    const ac = new AbortController()
    ctrl.abort = ac
    const timeoutMs = Number.isFinite(state.ai?.timeoutMs) && state.ai.timeoutMs > 0
      ? state.ai.timeoutMs
      : defaults.DEFAULT_TIMEOUT_MS
    const timeout = setTimeout(() => ac.abort('timeout'), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status))
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      const choice = data?.choices?.[0]?.message || {}
      const reply = H.extractAssistantText(choice)
      const usage = data?.usage || {}
      const inTok = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : estIn
      const outTok = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : estTokensFromText(reply)
      applyUsage(inTok, outTok)
      if (state.ai.trace && log?.info) {
        const delta = (inTok / 1000) * (state.ai.priceInPerKT || 0) + (outTok / 1000) * (state.ai.priceOutPerKT || 0)
        log.info('usage inTok=', inTok, 'outTok=', outTok, 'cost+=', delta.toFixed(4))
      }
      const toolCalls = extractToolCalls(choice)
      if (toolCalls.length) {
        let speech = reply ? H.trimReply(reply, maxReplyLen || 120) : ''
        let finalText = ''
        for (const call of toolCalls) {
          const payload = normalizeToolPayload(call)
          if (!payload || !payload.tool) continue
          const handled = await handleToolReply({ payload, speech, username, content, intent, maxReplyLen, memoryRefs })
          if (handled) finalText = handled
          speech = ''
        }
        return { reply: finalText, memoryRefs }
      }
      return { reply: H.trimReply(reply, maxReplyLen || 120), memoryRefs }
    } finally {
      clearTimeout(timeout)
      ctrl.abort = null
    }
  }

  function extractToolCalls (message) {
    if (!message || typeof message !== 'object') return []
    if (Array.isArray(message.tool_calls)) return message.tool_calls.filter(Boolean)
    if (message.function_call) return [{ id: message.id || 'fn-0', function: message.function_call }]
    return []
  }

  function normalizeToolPayload (toolCall) {
    if (!toolCall || typeof toolCall !== 'object') return null
    const fn = toolCall.function || toolCall
    if (!fn || !fn.name) return null
    let args = {}
    if (fn.arguments) {
      try { args = JSON.parse(fn.arguments) } catch (err) {
        log?.warn && log.warn('tool args parse error', err?.message || err, fn.arguments)
        args = {}
      }
    }
    return { tool: fn.name, args }
  }

  function isTeleportChatCommand (text) {
    try {
      const trimmed = String(text || '').trim()
      if (!trimmed.startsWith('/')) return false
      const cmd = trimmed.slice(1).split(/\s+/, 1)[0].toLowerCase()
      return TELEPORT_COMMANDS.has(cmd)
    } catch { return false }
  }

  function canToolBypassBusy (toolName, payload) {
    if (!toolName) return false
    const low = String(toolName).toLowerCase()
    if (low === 'reset' || low === 'stop' || low === 'stop_all') return true
    if (low === 'say') return isTeleportChatCommand(payload?.args?.text)
    return false
  }

  function shouldAutoAckTool (toolName, hadSpeech) {
    if (hadSpeech) return false
    return LONG_TASK_TOOLS.has(String(toolName || '').toLowerCase())
  }

  async function handleToolReply ({ payload, speech, username, content, intent, maxReplyLen, memoryRefs }) {
    const toolName = String(payload.tool)
    const toolLower = toolName.toLowerCase()
    if (toolLower === 'skip') return ''
    if (toolLower === 'stop_listen') {
      const rawMessage = payload.args?.message ?? payload.args?.text ?? payload.args?.publicMessage
      const fromArgs = typeof rawMessage === 'string' ? H.trimReply(rawMessage, maxReplyLen || 120) : ''
      const fallback = !fromArgs && speech ? H.trimReply(speech, maxReplyLen || 120) : ''
      if (!state.ai || typeof state.ai !== 'object') state.ai = {}
      state.ai.listenEnabled = false
      ctrl.pending = []
      clearPlan('stop_listen')
      try { pulse.cancelSay(username, 'stop_listen') } catch {}
      try { pulse.resetActiveSessions?.() } catch {}
      const outward = fromArgs || fallback
      if (outward) pulse.sendDirectReply(username, outward, { reason: 'stop_listen', from: 'LLM', toolUsed: 'stop_listen', memoryRefs })
      return ''
    }
    if (toolLower === 'feedback') {
      if (speech) pulse.sendChatReply(username, speech, { memoryRefs })
      const need = payload.args?.need
      const publicMessageRaw = payload.args?.publicMessage
      const terminatePlanRaw = payload.args?.terminatePlan
      const saved = feedbackPool.appendFeedback({
        need,
        publicMessage: publicMessageRaw,
        username,
        userMessage: content,
        contextBus,
        state
      })
      if (!saved.ok) return H.trimReply('我刚才没把这句话记住…你再说一遍？', maxReplyLen || 120)
      try { contextBus?.pushEvent('feedback.saved', String(saved.capturedAt || '')) } catch {}
      const inPlanContext = Boolean(ctrl.plan && ctrl.plan.owner === username && (intent?.topic === 'plan' || ctrl.planDriving))
      const terminatePlan = terminatePlanRaw === true ? true : (terminatePlanRaw === false ? false : inPlanContext)

      const publicMessage = typeof publicMessageRaw === 'string' ? H.trimReply(publicMessageRaw, maxReplyLen || 120) : ''
      const defaultPlanMessage = H.trimReply('这一步我现在还不会…我先把它记下来，等我有空学学；计划先停一下。', maxReplyLen || 120)
      const outward = publicMessage || (terminatePlan ? defaultPlanMessage : '')
      if (outward) pulse.sendChatReply(username, outward, { reason: 'feedback_public', memoryRefs })
      if (terminatePlan) clearPlan('feedback')

      return (speech || outward) ? '' : H.trimReply('我记下来了，回头我研究研究。', maxReplyLen || 120)
    }
    if (toolLower === 'plan_mode') {
      const ok = startPlanMode({ username, goal: payload.args?.goal || content, steps: payload.args?.steps || [] })
      if (!ok) return H.trimReply('需要提供可执行的计划步骤哦~', maxReplyLen || 120)
      return ''
    }
    if (toolName === 'write_memory') {
      if (speech) pulse.sendChatReply(username, speech, { memoryRefs })
      const normalized = memory.longTerm.normalizeText(payload.args?.text || '')
      if (!normalized) return H.trimReply('没听懂要记什么呢~', maxReplyLen || 120)
      const importanceRaw = Number(payload.args?.importance)
      const importance = Number.isFinite(importanceRaw) ? importanceRaw : 1
      const author = payload.args?.author ? String(payload.args.author) : username
      const source = payload.args?.source ? String(payload.args.source) : 'ai'
      const added = memory.longTerm.addEntry({ text: normalized, author, source, importance })
      if (state.ai.trace && log?.info) log.info('tool write_memory ->', { text: normalized, author, source, importance, ok: added.ok })
      if (!added.ok) return H.trimReply('记忆没有保存下来~', maxReplyLen || 120)
      return speech ? '' : H.trimReply('记住啦~', maxReplyLen || 120)
    }
    if (toolName === 'add_commitment') {
      const actionRaw = payload.args?.action
      const action = typeof actionRaw === 'string' ? actionRaw.trim() : ''
      if (!action) return H.trimReply('没听懂要承诺什么呢~', maxReplyLen || 120)
      const ms = getMinimalSelfInstance()
      const identity = ms?.getIdentity?.()
      if (!identity || typeof identity.addCommitment !== 'function') {
        return H.trimReply('现在记不住承诺呢~', maxReplyLen || 120)
      }
      const player = payload.args?.player ? String(payload.args.player) : username
      const deadlineRaw = payload.args?.deadlineMs
      const deadlineMs = Number.isFinite(deadlineRaw) ? deadlineRaw : null
      const commitment = identity.addCommitment(player, action, deadlineMs)
      if (contextBus) {
        try { contextBus.pushEvent('commitment.add', `${player}:${action}`) } catch {}
      }
      if (state.ai.trace && log?.info) log.info('commitment ->', commitment)
      const reply = speech || H.trimReply(`好，我记下了承诺: ${action}`, maxReplyLen || 120)
      if (reply) pulse.sendChatReply(username, reply, { reason: 'commitment', toolUsed: 'commitment:add', memoryRefs })
      return ''
    }
    if (toolLower === 'say') {
      const ok = pulse.say(username, payload.args || {}, {
        reason: 'tool_say',
        from: 'LLM',
        toolUsed: 'say',
        memoryRefs,
        fallbackText: speech
      })
      if (!ok && speech) {
        pulse.sendChatReply(username, speech, { reason: 'tool_say_fallback', from: 'LLM', memoryRefs })
      }
      return ''
    }
    try {
      if (toolName === 'mount_player') {
        const a = payload.args || {}
        const raw = String(content || '')
        const meTokens = /(\bme\b|我)/i
        if (!a.name || meTokens.test(raw)) {
          a.name = username
          payload.args = a
        }
      }
    } catch {}
    if (intent && intent.kind === 'info' && !['observe_detail','say'].includes(toolName)) {
      return H.trimReply('我这就看看…', maxReplyLen || 120)
    }
    if (toolName === 'follow_player') {
      const raw = String(content || '')
      if (/(空手|右键|右击|坐我|骑我|骑乘|乘坐|mount)/i.test(raw)) {
        const name = String(payload.args?.name || username || '').trim()
        if (name) payload = { tool: 'mount_player', args: { name } }
      }
    }
    if (['reset', 'stop', 'stop_all'].includes(toolLower)) {
      clearPlan('stop_tool')
      try { pulse.cancelSay(username, 'stop_tool') } catch {}
    }
    if (contextBus) {
      try { contextBus.pushEvent('tool.intent', toolLower) } catch {}
      if (TELEPORT_COMMANDS.has(toolLower)) {
        try { contextBus.pushEvent('tool.teleport', toolLower) } catch {}
      }
      if (['afk', 'idle', 'hang'].includes(toolLower)) {
        try { contextBus.pushEvent('tool.afk', toolLower) } catch {}
      }
    }
    if (!isActionToolAllowed(toolName)) return H.trimReply('这个我还不会哟~', maxReplyLen || 120)
    const busy = Boolean(state?.externalBusy)
    const canOverrideBusy = canToolBypassBusy(toolName, payload)
    if (busy && !canOverrideBusy) {
      return H.trimReply('我还在执行其他任务，先等我完成或者说“重置”哦~', maxReplyLen || 120)
    }
    const actionScore = gateActionWithIdentity(toolName)
    if (actionScore && Number.isFinite(actionScore.score) && actionScore.score < 0.45) {
      const scoreStr = actionScore.score.toFixed(2)
      return H.trimReply(`这个动作我信心不高（评分${scoreStr}），要不要换个？`, maxReplyLen || 120)
    }
    const hadSpeech = Boolean(speech)
    if (hadSpeech) {
      pulse.sendChatReply(username, speech, { memoryRefs })
    } else if (shouldAutoAckTool(toolName, hadSpeech)) {
      pulse.sendChatReply(username, '收到，开始执行~', { reason: 'tool_ack', memoryRefs })
    }
    const runTool = async () => {
      try { bot.emit('external:begin', { source: 'chat', tool: payload.tool }) } catch {}
      let res
      try {
        res = await actions.run(payload.tool, payload.args || {})
      } catch (err) {
        log?.warn && log.warn('tool error', err?.message || err)
        res = { ok: false, msg: '执行失败，请稍后再试~' }
      } finally {
        try { bot.emit('external:end', { source: 'chat', tool: payload.tool }) } catch {}
      }
      if (state.ai.trace && log?.info) log.info('tool ->', payload.tool, payload.args, res)
      const baseMsg = res && typeof res === 'object' ? (res.msg || '') : ''
      const fallback = res && res.ok ? '完成啦~' : '这次没成功！'
      const finalText = H.trimReply(baseMsg || fallback, maxReplyLen || 120)
      if (finalText) pulse.sendChatReply(username, finalText, { reason: `tool_${toolName}`, memoryRefs })
    }
    runTool().catch((err) => { log?.warn && log.warn('tool async failure', err?.message || err) })
    return ''
  }

  function classifyStopCommand (text) {
    try {
      const t = String(text || '').toLowerCase()
      const tCN = String(text || '')
      if (/(don't|do not)\s*reset/.test(t)) return false
      if (/不要.*重置|别.*重置|不要.*复位|别.*复位/.test(tCN)) return false
      if (/(stop|cancel|abort|reset)/i.test(t)) return true
      if (/停止|停下|别动|取消|终止|重置|复位|归位|不要.*(追|打|攻击)|停止追击|停止攻击|停止清怪/.test(tCN)) return true
      return false
    } catch { return false }
  }

  async function processChatContent (username, content, raw, source) {
    if (!state.ai.enabled) return
    let text = String(content || '').trim()
    if (!text) return
    traceChat('[chat] process', { source, username, text })
    pulse.activateSession(username, source)
    pulse.touchConversationSession(username)
    const reasonTag = source === 'followup' ? 'followup' : 'trigger'
    if (/(下坐|下车|下马|dismount|停止\s*(骑|坐|骑乘|乘坐)|不要\s*(骑|坐)|别\s*(骑|坐))/i.test(text)) {
      try {
        const res = await actions.run('dismount', {})
        pulse.sendChatReply(username, res.ok ? (res.msg || '好的') : (`失败: ${res.msg || '未知'}`), { reason: `${reasonTag}_tool` })
      } catch {}
      return
    }
    if (classifyStopCommand(text)) {
      clearPlan('stop_message')
      try {
        await actions.run('reset', {})
      } catch {}
      pulse.sendChatReply(username, '好的', { reason: `${reasonTag}_stop` })
      return
    }
    // Memory commands are high-priority and should not be delayed/dropped by pending batching.
    const memoryText = memory.longTerm.extractCommand(text)
    if (memoryText) {
      if (!state.ai?.key) {
        pulse.sendChatReply(username, '现在记不住呀，AI 没开~', { reason: 'memory_key' })
        return
      }
      const job = {
        id: `mem_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        player: username,
        text: memoryText,
        original: raw,
        recent: memory.rewrite.recentSnippet(6),
        createdAt: now(),
        source: 'player',
        attempts: 0,
        context: collectMemoryContext(memoryText)
      }
      memory.rewrite.enqueueJob(job)
      pulse.sendChatReply(username, '收到啦，我整理一下~', { reason: 'memory_queue' })
      return
    }
    // Pending rule: while an AI request is in-flight, accumulate all new chat and handle them in one batch
    // only after the previous request completes.
    if (ctrl.busy) {
      try { state.aiPulse.lastFlushAt = now() } catch {}
      queuePending(username, text, raw, source)
      return
    }
    const allowed = canProceed(username)
    if (!allowed.ok) {
      if (state.ai?.limits?.notify !== false) {
        pulse.sendChatReply(username, '太快啦，稍后再试~', { reason: 'limits' })
      }
      return
    }
    try { state.aiPulse.lastFlushAt = now() } catch {}
    const intent = classifyIntent(text)
    if (state.ai.trace && log?.info) { try { log.info('intent ->', intent) } catch {} }
    const acted = await Promise.resolve(false)
    if (acted) return
    ctrl.busy = true
    ctrl.lastUser = username
    try {
      if (state.ai.trace && log?.info) log.info('ask <-', text)
      const allowSkip = source === 'followup'
      const { reply, memoryRefs } = await callAI(username, text, intent, { allowSkip })
      if (reply) {
        noteUsage(username)
        if (state.ai.trace && log?.info) log.info('reply ->', reply)
        if (allowSkip && /^skip$/i.test(reply.trim())) {
          traceChat('[chat] followup skipped', { username })
          return
        }
        const replyReason = source === 'followup' ? 'llm_followup' : 'llm_reply'
        pulse.sendChatReply(username, reply, { reason: replyReason, from: 'LLM', memoryRefs })
      }
    } catch (e) {
      log?.warn && log.warn('ai error:', e?.message || e)
      if (/key not configured/i.test(String(e))) {
        pulse.sendChatReply(username, 'AI未配置', { reason: 'error_key' })
      } else if (/budget/i.test(String(e)) && state.ai.notifyOnBudget) {
        pulse.sendChatReply(username, 'AI余额不足', { reason: 'error_budget' })
      }
    } finally {
      ctrl.busy = false
      flushPending()
    }
  }

  function collectMemoryContext (memoryText) {
    try {
      const pos = (() => {
        const entityPos = bot.entity?.position
        if (!entityPos) return null
        return { x: Math.round(entityPos.x), y: Math.round(entityPos.y), z: Math.round(entityPos.z) }
      })()
      const dim = (() => {
        try {
          const rawDim = bot.game?.dimension
          if (typeof rawDim === 'string' && rawDim.length) return rawDim
        } catch {}
        return null
      })()
      if (!pos) return null
      return { position: pos, dimension: dim, radius: 50, featureHint: memoryText }
    } catch { return null }
  }

  async function handleChat (username, message) {
    const raw = String(message || '')
    const trimmed = raw.trim()
    if (!username || username === bot.username) {
      traceChat('[chat] ignore self', { username, text: trimmed })
      return
    }
    const trig = triggerWord()
    const startRe = new RegExp('^' + trig, 'i')
    if (!startRe.test(trimmed)) {
      if (shouldAutoFollowup(username, trimmed)) {
        traceChat('[chat] followup trigger', { username, text: trimmed })
        await processChatContent(username, trimmed, raw, 'followup')
      } else {
        traceChat('[chat] ignore non-trigger', { username, text: trimmed })
      }
      return
    }
    if (state.ai?.listenEnabled === false) {
      state.ai.listenEnabled = true
      traceChat('[chat] followup listen-enabled', { username })
    }
    let content = trimmed.replace(new RegExp('^(' + trig + '[:：,，。.!！\\s]*)+', 'i'), '')
    content = content.replace(/^[:：,，。.!！\s]+/, '')
    traceChat('[chat] trigger matched', { username, text: content })
    pulse.activateSession(username, 'trigger', { restart: true })
    await processChatContent(username, content, raw, 'trigger')
  }

  function abortActive () {
    if (ctrl.abort && typeof ctrl.abort.abort === 'function') {
      try { ctrl.abort.abort('cleanup') } catch {}
    }
    clearPlan('abort')
  }

  return {
    handleChat,
    buildContextPrompt,
    buildMetaContext,
    triggerWord,
    callAI,
    processChatContent,
    shouldAutoFollowup,
    abortActive
  }
}

function loadFile (name, fallback) {
  const fs = require('fs')
  const path = require('path')
  const fullPath = path.join(__dirname, '..', 'prompts', name)
  try {
    return fs.readFileSync(fullPath, 'utf8')
  } catch {}
  return fallback
}

module.exports = { createChatExecutor }
