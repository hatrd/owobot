const { buildToolFunctionList, isActionToolAllowed } = require('./tool-schemas')
const timeUtils = require('../time-utils')
const feedbackPool = require('./feedback-pool')
const { buildMemoryQuery } = require('./memory-query')

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
  people = null,
  canAfford,
  applyUsage,
  buildGameContext,
  contextBus = null
}) {
  const ctrl = { busy: false, abort: null, pending: [], plan: null, planTimer: null, planDriving: false, lastUser: null, pendingInterruptSeq: 0 }
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

  function requestPendingInterrupt (reason = 'pending_interrupt') {
    ctrl.pendingInterruptSeq = Number(ctrl.pendingInterruptSeq || 0) + 1
    if (ctrl.abort && typeof ctrl.abort.abort === 'function') {
      try { ctrl.abort.abort(reason) } catch {}
    }
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
      if (ctrl.busy) requestPendingInterrupt('pending_interrupt')
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
    if (ctrl.busy) requestPendingInterrupt('pending_interrupt')
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

  function buildPendingInterruptNote (batch) {
    try {
      const body = buildPendingBatchText(batch)
      if (!body) return ''
      return [
        '【实时插入：收到新的玩家消息】',
        body,
        '请优先基于最新消息调整后续动作；如原计划不再适用，请立即停止旧计划并给出新回复。'
      ].join('\n')
    } catch {
      return ''
    }
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
      const { reply, memoryRefs } = await callAI(owner, content, intent)
      if (reply) {
        noteUsage(owner)
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

  function collectRecentChatForMemoryQuery (username, limit = 8) {
    const name = String(username || '').trim()
    if (!name) return []
    const cap = Math.max(0, Math.min(50, Math.floor(Number(limit) || 0)))
    if (cap <= 0) return []

    const out = []
    if (contextBus && typeof contextBus.getStore === 'function') {
      const store = contextBus.getStore() || []
      for (let i = store.length - 1; i >= 0 && out.length < cap; i--) {
        const e = store[i]
        if (!e || e.type !== 'player') continue
        const who = e.payload?.name
        if (String(who || '').trim() !== name) continue
        const text = e.payload?.content
        if (typeof text !== 'string' || !text.trim()) continue
        out.push({ user: who, text, t: e.t })
      }
      out.reverse()
      return out
    }

    const recent = Array.isArray(state.aiRecent) ? state.aiRecent : []
    for (let i = recent.length - 1; i >= 0 && out.length < cap; i--) {
      const r = recent[i]
      if (!r) continue
      if (String(r.user || '').trim() !== name) continue
      const text = r.text
      if (typeof text !== 'string' || !text.trim()) continue
      out.push({ user: r.user, text, t: r.t })
    }
    out.reverse()
    return out
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
      const res = await callAI(plan.owner, content, { topic: 'plan', kind: 'chat' }, { inlineUserContent: true })
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
    if (reply) {
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
    if (lastReason === 'drive' && (!lastAt || (now() - lastAt) < (120 * 1000))) {
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
    const { key, baseUrl, path, pathOverride, model, maxReplyLen } = state.ai
    const replyLimit = Number.isFinite(maxReplyLen) && maxReplyLen > 0 ? Math.floor(maxReplyLen) : undefined
    if (!key) throw new Error('AI key not configured')
    const apiPath = pathOverride || path || defaults.DEFAULT_PATH
    const url = H.buildAiUrl({ baseUrl, path: apiPath, defaultBase: defaults.DEFAULT_BASE, defaultPath: defaults.DEFAULT_PATH })
    const contextPrompt = buildContextPrompt(username)
    const gameCtx = buildGameContext()
    const memoryQuery = buildMemoryQuery({
      username,
      message: content,
      recentChat: collectRecentChatForMemoryQuery(username, 8),
      worldHint: null
    })
    const memoryCtxResult = await memory.longTerm.buildContext({ query: memoryQuery, actor: username, withRefs: true })
    const memoryCtx = typeof memoryCtxResult === 'string' ? memoryCtxResult : (memoryCtxResult?.text || '')
    const memoryRefs = Array.isArray(memoryCtxResult?.refs) ? memoryCtxResult.refs : []
    const peopleProfilesCtx = (() => {
      try { return people?.buildAllProfilesContext?.() || '' } catch { return '' }
    })()
    const peopleCommitmentsCtx = (() => {
      try { return people?.buildAllCommitmentsContext?.() || '' } catch { return '' }
    })()
    const metaCtx = buildMetaContext()
    const inlineUserContent = options?.inlineUserContent === true
    const withTools = options?.withTools !== false
    const maxToolCalls = (() => {
      const raw = Number(options?.maxToolCalls ?? state.ai?.maxToolCallsPerTurn ?? state.ai?.maxToolCalls ?? 6)
      if (!Number.isFinite(raw)) return 6
      return Math.max(1, Math.min(16, Math.floor(raw)))
    })()
    const dryRun = options?.dryRun === true
    const dryEvents = Array.isArray(options?.dryEvents) ? options.dryEvents : []
    const finish = (replyText) => {
      const out = { reply: replyText, memoryRefs }
      if (dryRun) out.dryEvents = dryEvents.slice()
      return out
    }
    const inlinePrompt = inlineUserContent ? String(content || '').trim() : ''
    const baseMessages = [
      { role: 'system', content: systemPrompt() },
      metaCtx ? { role: 'system', content: metaCtx } : null,
      gameCtx ? { role: 'system', content: gameCtx } : null,
      peopleProfilesCtx ? { role: 'system', content: peopleProfilesCtx } : null,
      peopleCommitmentsCtx ? { role: 'system', content: peopleCommitmentsCtx } : null,
      memoryCtx ? { role: 'system', content: memoryCtx } : null,
      { role: 'system', content: contextPrompt },
      inlinePrompt ? { role: 'system', content: inlinePrompt } : null
    ].filter(Boolean)
    if (state.ai.trace && log?.info) {
      try {
        log.info('gameCtx ->', gameCtx)
        log.info('chatCtx ->', buildContextPrompt(username))
        log.info('peopleProfilesCtx ->', peopleProfilesCtx)
        log.info('peopleCommitmentsCtx ->', peopleCommitmentsCtx)
        log.info('memoryCtx ->', memoryCtx)
      } catch {}
    }
    const maxOut = Math.max(120, Math.min(1024, state.ai.maxTokensPerCall || 1024))
    const useResponses = typeof H.isResponsesApiPath === 'function' && H.isResponsesApiPath(apiPath)

    async function requestModel (requestMessages, allowTools) {
      const estIn = estTokensFromText(requestMessages.map(m => m.content).join(' '))
      const afford = canAfford(estIn)
      if (state.ai.trace && log?.info) log.info('precheck inTok~=', estIn, 'projCost~=', (afford.proj || 0).toFixed(4), 'rem=', afford.rem)
      if (!afford.ok) {
        const msg = state.ai.notifyOnBudget ? 'AI余额不足，稍后再试~' : ''
        throw new Error(msg || 'budget_exceeded')
      }

      const body = useResponses
        ? {
            model: model || defaults.DEFAULT_MODEL,
            input: requestMessages,
            max_output_tokens: maxOut,
            ...(allowTools ? { tools: TOOL_FUNCTIONS } : null),
            ...(state.ai?.reasoningEffort ? { reasoning: { effort: String(state.ai.reasoningEffort) } } : null)
          }
        : {
            model: model || defaults.DEFAULT_MODEL,
            messages: requestMessages,
            temperature: 0.2,
            max_tokens: maxOut,
            stream: false,
            ...(allowTools ? { tools: TOOL_FUNCTIONS } : null)
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
        const reply = typeof H.extractAssistantTextFromApiResponse === 'function'
          ? H.extractAssistantTextFromApiResponse(data, { allowReasoning: false })
          : H.extractAssistantText(data?.choices?.[0]?.message || {}, { allowReasoning: false })
        const usage = typeof H.extractUsageFromApiResponse === 'function' ? H.extractUsageFromApiResponse(data) : { inTok: null, outTok: null }
        const inTok = Number.isFinite(usage.inTok) ? usage.inTok : estIn
        const outTok = Number.isFinite(usage.outTok) ? usage.outTok : estTokensFromText(reply)
        applyUsage(inTok, outTok)
        if (state.ai.trace && log?.info) {
          const delta = (inTok / 1000) * (state.ai.priceInPerKT || 0) + (outTok / 1000) * (state.ai.priceOutPerKT || 0)
          log.info('usage inTok=', inTok, 'outTok=', outTok, 'cost+=', delta.toFixed(4))
        }
        const toolCalls = allowTools && typeof H.extractToolCallsFromApiResponse === 'function'
          ? H.extractToolCallsFromApiResponse(data)
          : []
        return { reply: H.trimReply(reply, replyLimit), toolCalls, interrupted: false }
      } catch (err) {
        const abortReason = String(ac.signal?.reason || '')
        if (ac.signal?.aborted && abortReason === 'pending_interrupt') {
          if (state.ai.trace && log?.info) log.info('ai request interrupted by new pending input')
          return { reply: '', toolCalls: [], interrupted: true }
        }
        throw err
      } finally {
        clearTimeout(timeout)
        ctrl.abort = null
      }
    }

    const loopNotes = []
    const loopOutputs = []
    let totalToolCalls = 0
    let lastReply = ''
    let fallbackReply = ''

    while (true) {
      const pendingBatch = takePendingBatch()
      if (pendingBatch && pendingBatch.length) {
        const pendingNote = buildPendingInterruptNote(pendingBatch)
        if (pendingNote) loopNotes.push(pendingNote)
      }

      const requestMessages = [...baseMessages, ...loopNotes.map(note => ({ role: 'system', content: note }))]
      const allowTools = withTools && totalToolCalls < maxToolCalls
      const step = await requestModel(requestMessages, allowTools)
      if (step && step.interrupted === true) continue

      lastReply = step.reply || ''
      if (!allowTools || !Array.isArray(step.toolCalls) || !step.toolCalls.length) {
        const finalReply = String(lastReply || '').trim()
        if (finalReply) return finish(finalReply)
        return finish(H.trimReply(fallbackReply || '', replyLimit))
      }

      const remaining = Math.max(0, maxToolCalls - totalToolCalls)
      if (remaining <= 0) break
      const selectedCalls = step.toolCalls.slice(0, remaining)
      const roundEntries = []
      let speech = lastReply

      for (const call of selectedCalls) {
        if (Array.isArray(ctrl.pending) && ctrl.pending.length) break

        const payload = normalizeToolPayload(call)
        if (!payload || !payload.tool) continue
        const handled = await handleToolReply({ payload, speech, username, content, intent, maxReplyLen, memoryRefs, dryRun, dryEvents })
        speech = ''
        totalToolCalls += 1

        if (handled && handled.halt) {
          return finish('')
        }
        const handledText = shortText(handled?.result || 'ok', 220)
        const handledFallback = String(handled?.fallbackReply || '').trim()
        if (handledFallback) fallbackReply = handledFallback
        roundEntries.push({
          tool: payload.tool,
          args: payload.args || {},
          result: handledText || 'ok'
        })

        if (Array.isArray(ctrl.pending) && ctrl.pending.length) break
      }

      if (!roundEntries.length) {
        if (Array.isArray(ctrl.pending) && ctrl.pending.length) continue
        return finish(lastReply)
      }

      loopOutputs.push(...roundEntries)
      loopNotes.push(buildToolLoopContextNote({ round: loopNotes.length + 1, maxToolCalls, entries: roundEntries }))

      if (totalToolCalls >= maxToolCalls) break
    }

    const capped = buildToolLoopCapReply(loopOutputs, fallbackReply)
    return finish(H.trimReply(capped || lastReply || '我先做到这里，后面你再提醒我继续~', replyLimit))
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

  function shortText (value, limit = 64) {
    const n = Number.isFinite(Number(limit)) ? Math.max(8, Math.floor(Number(limit))) : 64
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    if (!s) return ''
    if (s.length <= n) return s
    return `${s.slice(0, n - 1)}…`
  }

  function compactJsonValue (value, depth = 0) {
    if (value == null) return null
    if (depth > 2) return null
    if (typeof value === 'string') return shortText(value, 80)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) {
      const out = []
      for (const item of value.slice(0, 6)) {
        const compact = compactJsonValue(item, depth + 1)
        if (compact == null) continue
        out.push(compact)
      }
      return out
    }
    if (typeof value === 'object') {
      const out = {}
      const preferred = [
        'observeLabel', 'name', 'customName', 'displayName', 'entityName', 'type', 'kind', 'named',
        'x', 'y', 'z', 'd', 'dim',
        'ok', 'error', 'openErrors', 'count', 'total', 'kinds', 'text', 'items'
      ]
      const keys = Object.keys(value)
      const ordered = []
      for (const k of preferred) {
        if (keys.includes(k)) ordered.push(k)
      }
      for (const k of keys) {
        if (!ordered.includes(k)) ordered.push(k)
      }
      for (const key of ordered.slice(0, 10)) {
        const compact = compactJsonValue(value[key], depth + 1)
        if (compact == null) continue
        out[key] = compact
      }
      return out
    }
    return shortText(String(value), 80)
  }

  function formatObserveEntityBrief (row = {}) {
    try {
      const name = shortText(row.observeLabel || row.name || row.customName || row.displayName || row.entityName || row.type || row.kind || 'unknown', 20)
      const kindParts = []
      const entityName = shortText(row.entityName || row.type || '', 14)
      const kind = shortText(row.kind || '', 10)
      if (entityName && entityName !== name) kindParts.push(entityName)
      if (kind && kind !== name && kind !== entityName) kindParts.push(`#${kind}`)
      const d = Number(row.d)
      const dist = Number.isFinite(d) ? `${d.toFixed(1)}m` : ''
      const head = kindParts.length ? `${name}[${kindParts.join('/')}]` : name
      return [head, dist].filter(Boolean).join(' ')
    } catch {
      return ''
    }
  }

  function buildObserveContextLine ({ toolName, args, res }) {
    try {
      const what = shortText(args?.what || (toolName === 'observe_players' ? 'players' : 'unknown'), 16)
      const msg = shortText(res?.msg || '', 80)
      const rows = Array.isArray(res?.data) ? res.data : []
      const top = rows.slice(0, 4).map(formatObserveEntityBrief).filter(Boolean).join(';')
      const parts = [
        `tool=${toolName}`,
        `what=${what}`,
        `ok=${res?.ok === true ? 1 : 0}`,
        msg ? `msg=${msg}` : '',
        top ? `top=${top}` : ''
      ].filter(Boolean)
      return parts.join(' ')
    } catch {
      return ''
    }
  }

  function buildToolLoopContextNote ({ round, maxToolCalls, entries }) {
    try {
      const normalized = Array.isArray(entries) ? entries.slice(0, 6) : []
      const rows = normalized.map(entry => ({
        tool: shortText(entry?.tool || '', 32),
        args: compactJsonValue(entry?.args || {}, 0),
        result: shortText(entry?.result || '', 220)
      }))
      let rowsJson = JSON.stringify(rows)
      if (rowsJson.length > 1800) rowsJson = `${rowsJson.slice(0, 1800)}…`
      return [
        `【工具循环回放 ${round}/${Math.max(1, Number(maxToolCalls) || 1)}】`,
        `本轮执行: ${rows.length} 次工具调用`,
        `结果: ${rowsJson}`,
        '如果任务已完成请直接给玩家最终回复；仅在确实需要进一步动作时继续调用工具。'
      ].join('\n')
    } catch {
      return '【工具循环回放】本轮已执行工具，请基于结果继续。'
    }
  }

  function buildToolLoopCapReply (loopOutputs, fallbackReply = '') {
    const fallback = String(fallbackReply || '').trim()
    if (fallback) return fallback
    try {
      const rows = Array.isArray(loopOutputs) ? loopOutputs.slice(-3) : []
      const summary = rows
        .map((entry) => `${shortText(entry?.tool || '', 20)}:${shortText(entry?.result || '', 40)}`)
        .filter(Boolean)
        .join('；')
      if (summary) return `我这轮已经连续执行了很多步骤，当前进展是：${summary}。如果要继续，我下一轮接着做~`
    } catch {}
    return '我这轮工具调用次数已经到上限啦，你再提醒我一句我就继续~'
  }

  function buildActionResultSummary ({ toolName, res }) {
    try {
      const status = res?.ok === true ? 'ok' : (res?.ok === false ? 'fail' : 'done')
      const msg = shortText(res?.msg || res?.error || '', 140)
      const count = Array.isArray(res?.data) ? `data=${res.data.length}` : ''
      return [shortText(toolName || '', 24), status, msg, count].filter(Boolean).join(' | ')
    } catch {
      return `${String(toolName || 'tool')} | done`
    }
  }

  async function handleToolReply ({ payload, speech, username, content, intent, maxReplyLen, memoryRefs, dryRun = false, dryEvents = null }) {
    const replyLimit = Number.isFinite(maxReplyLen) && maxReplyLen > 0 ? Math.floor(maxReplyLen) : undefined
    const result = (resultText, fallbackReply = '') => ({ result: String(resultText || 'ok'), fallbackReply: H.trimReply(String(fallbackReply || ''), replyLimit) })
    const halt = (resultText = 'halt') => ({ halt: true, result: String(resultText) })
    const appendDry = (type, data = {}) => {
      if (!dryRun || !Array.isArray(dryEvents)) return
      dryEvents.push({ t: now(), type: String(type || ''), ...data })
    }

    let toolName = String(payload.tool)
    let toolLower = toolName.toLowerCase()
    if (toolLower === 'skip') return result('skip')

    if (dryRun) {
      appendDry('tool.call', { tool: toolName, args: payload.args || {} })
      if (toolLower === 'say') {
        appendDry('tool.say', { args: payload.args || {}, fallbackText: speech || '' })
        return result('say_dry_preview', speech || '')
      }
      if (!isActionToolAllowed(toolName)) return result('tool_unknown', '这个我还不会哟~')
      let dryRes
      try {
        dryRes = actions.dry ? await actions.dry(toolName, payload.args || {}) : { ok: false, msg: 'dry-run unsupported' }
      } catch (err) {
        dryRes = { ok: false, msg: 'dry-run failed', error: String(err?.message || err) }
      }
      if (state.ai.trace && log?.info) log.info('tool(dry) ->', toolName, payload.args, dryRes)
      const isObserveTool = toolLower === 'observe_detail' || toolLower === 'observe_players'
      if (isObserveTool) {
        try {
          const line = buildObserveContextLine({ toolName, args: payload.args || {}, res: dryRes })
          if (line) contextBus?.pushTool?.(line)
        } catch {}
      }
      const summary = buildActionResultSummary({ toolName, res: dryRes })
      appendDry('tool.result', { tool: toolName, result: compactJsonValue(dryRes, 0), summary })
      return result(summary)
    }
    if (toolLower === 'stop_listen') {
      const rawMessage = payload.args?.message ?? payload.args?.text ?? payload.args?.publicMessage
      const fromArgs = typeof rawMessage === 'string' ? H.trimReply(rawMessage, replyLimit) : ''
      const fallback = !fromArgs && speech ? H.trimReply(speech, replyLimit) : ''
      if (!state.ai || typeof state.ai !== 'object') state.ai = {}
      state.ai.listenEnabled = false
      ctrl.pending = []
      clearPlan('stop_listen')
      try { pulse.cancelSay(username, 'stop_listen') } catch {}
      try { pulse.resetActiveSessions?.() } catch {}
      const outward = fromArgs || fallback
      if (outward) pulse.sendDirectReply(username, outward, { reason: 'stop_listen', from: 'LLM', toolUsed: 'stop_listen', memoryRefs })
      return halt('stop_listen')
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
      if (!saved.ok) return result('feedback_save_failed', '我刚才没把这句话记住…你再说一遍？')
      try { contextBus?.pushEvent('feedback.saved', String(saved.capturedAt || '')) } catch {}
      const inPlanContext = Boolean(ctrl.plan && ctrl.plan.owner === username && (intent?.topic === 'plan' || ctrl.planDriving))
      const terminatePlan = terminatePlanRaw === true ? true : (terminatePlanRaw === false ? false : inPlanContext)

      const publicMessage = typeof publicMessageRaw === 'string' ? H.trimReply(publicMessageRaw, replyLimit) : ''
      const defaultPlanMessage = H.trimReply('这一步我现在还不会…我先把它记下来，等我有空学学；计划先停一下。', replyLimit)
      const outward = publicMessage || (terminatePlan ? defaultPlanMessage : '')
      if (outward) pulse.sendChatReply(username, outward, { reason: 'feedback_public', memoryRefs })
      if (terminatePlan) clearPlan('feedback')

      const fallbackReply = (speech || outward) ? '' : '我记下来了，回头我研究研究。'
      return result('feedback_saved', fallbackReply)
    }
    if (toolLower === 'plan_mode') {
      const ok = startPlanMode({ username, goal: payload.args?.goal || content, steps: payload.args?.steps || [] })
      if (!ok) return result('plan_mode_invalid', '需要提供可执行的计划步骤哦~')
      return result('plan_mode_started')
    }
    if (toolName === 'write_memory') {
      if (speech) pulse.sendChatReply(username, speech, { memoryRefs })
      const normalized = memory.longTerm.normalizeText(payload.args?.text || '')
      if (!normalized) return result('write_memory_invalid', '没听懂要记什么呢~')
      const importanceRaw = Number(payload.args?.importance)
      const importance = Number.isFinite(importanceRaw) ? importanceRaw : 1
      const author = payload.args?.author ? String(payload.args.author) : username
      const source = payload.args?.source ? String(payload.args.source) : 'ai'
      const added = memory.longTerm.addEntry({ text: normalized, author, source, importance })
      if (state.ai.trace && log?.info) log.info('tool write_memory ->', { text: normalized, author, source, importance, ok: added.ok })
      if (!added.ok) return result('write_memory_failed', '记忆没有保存下来~')
      return result('write_memory_saved', speech ? '' : '记住啦~')
    }
    if (toolName === 'add_commitment') {
      const actionRaw = payload.args?.action
      const action = typeof actionRaw === 'string' ? actionRaw.trim() : ''
      if (!action) return result('add_commitment_invalid', '没听懂要承诺什么呢~')
      const player = payload.args?.player ? String(payload.args.player) : username
      const deadlineRaw = payload.args?.deadlineMs
      const deadlineMs = Number.isFinite(deadlineRaw) ? deadlineRaw : null
      const storedInPeople = (() => {
        try {
          return Boolean(people?.upsertCommitment?.({ player, action, status: 'pending', deadlineMs, source: 'tool:add_commitment' })?.ok)
        } catch { return false }
      })()
      const ms = getMinimalSelfInstance()
      const identity = ms?.getIdentity?.()
      const commitment = (() => {
        try {
          if (!identity || typeof identity.addCommitment !== 'function') return null
          return identity.addCommitment(player, action, deadlineMs)
        } catch { return null }
      })()
      if (!storedInPeople && !commitment) {
        return result('add_commitment_failed', '现在记不住承诺呢~')
      }
      if (contextBus) {
        try { contextBus.pushEvent('commitment.add', `${player}:${action}`) } catch {}
      }
      if (state.ai.trace && log?.info) log.info('commitment ->', commitment)
      const reply = speech || H.trimReply(`好，我记下了承诺: ${action}`, replyLimit)
      if (reply) pulse.sendChatReply(username, reply, { reason: 'commitment', toolUsed: 'commitment:add', memoryRefs })
      return result('add_commitment_saved')
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
      return result(ok ? 'say_sent' : 'say_fallback')
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
    if (intent && intent.kind === 'info' && !['observe_detail', 'observe_players', 'say'].includes(toolName)) {
      return result('tool_blocked_info_only', '我这就看看…')
    }
    if (toolName === 'follow_player') {
      const raw = String(content || '')
      if (/(空手|右键|右击|坐我|骑我|骑乘|乘坐|mount)/i.test(raw)) {
        const name = String(payload.args?.name || username || '').trim()
        if (name) {
          payload = { tool: 'mount_player', args: { name } }
          toolName = payload.tool
          toolLower = toolName.toLowerCase()
        }
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
    if (!isActionToolAllowed(toolName)) return result('tool_unknown', '这个我还不会哟~')
    const busy = Boolean(state?.externalBusy)
    const canOverrideBusy = canToolBypassBusy(toolName, payload)
    if (busy && !canOverrideBusy) {
      return result('tool_busy', '我还在执行其他任务，先等我完成或者说“重置”哦~')
    }
    const actionScore = gateActionWithIdentity(toolName)
    if (actionScore && Number.isFinite(actionScore.score) && actionScore.score < 0.45) {
      const scoreStr = actionScore.score.toFixed(2)
      return result('tool_low_confidence', `这个动作我信心不高（评分${scoreStr}），要不要换个？`)
    }
    const hadSpeech = Boolean(speech)
    if (hadSpeech) {
      pulse.sendChatReply(username, speech, { memoryRefs })
    } else if (shouldAutoAckTool(toolName, hadSpeech)) {
      pulse.sendChatReply(username, '收到，开始执行~', { reason: 'tool_ack', memoryRefs })
    }
    try { bot.emit('external:begin', { source: 'chat', tool: payload.tool }) } catch {}
    let res
    try {
      res = await actions.run(payload.tool, payload.args || {})
    } catch (err) {
      log?.warn && log.warn('tool error', err?.message || err)
      res = { ok: false, msg: '执行失败，请稍后再试~', error: String(err?.message || err) }
    } finally {
      try { bot.emit('external:end', { source: 'chat', tool: payload.tool }) } catch {}
    }
    if (state.ai.trace && log?.info) log.info('tool ->', payload.tool, payload.args, res)
    const isObserveTool = toolLower === 'observe_detail' || toolLower === 'observe_players'
    if (isObserveTool) {
      try {
        const line = buildObserveContextLine({ toolName, args: payload.args || {}, res })
        if (line) contextBus?.pushTool?.(line)
      } catch {}
    }
    const baseMsg = res && typeof res === 'object' ? (res.msg || '') : ''
    const fallback = res && res.ok ? '完成啦~' : '这次没成功！'
    const finalText = H.trimReply(baseMsg || fallback, replyLimit)
    if (finalText) pulse.sendChatReply(username, finalText, { reason: `tool_${toolName}`, memoryRefs })
    return result(buildActionResultSummary({ toolName, res }))
  }

  async function dryDialogue (username, content, options = {}) {
    const actor = String(username || 'dry_user').trim() || 'dry_user'
    const text = String(content || '').trim()
    if (!text) return { ok: false, error: 'missing content' }
    const dryEvents = []
    const intent = (options && typeof options.intent === 'object' && options.intent)
      ? options.intent
      : classifyIntent(text)
    const withTools = options?.withTools !== false
    const maxToolCalls = Number(options?.maxToolCalls)
    const callOptions = { withTools, dryRun: true, dryEvents, inlineUserContent: true }
    if (Number.isFinite(maxToolCalls)) callOptions.maxToolCalls = maxToolCalls
    const res = await callAI(actor, text, intent, callOptions)
    return {
      ok: true,
      username: actor,
      content: text,
      intent,
      reply: String(res?.reply || ''),
      memoryRefs: Array.isArray(res?.memoryRefs) ? res.memoryRefs : [],
      dryEvents: Array.isArray(res?.dryEvents) ? res.dryEvents : dryEvents
    }
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
    const forget = memory.longTerm.extractForgetCommand ? memory.longTerm.extractForgetCommand(text) : null
    if (forget) {
      const res = (() => {
        if (forget.query && memory.longTerm.disableMemories) {
          return memory.longTerm.disableMemories({ query: forget.query, actor: username, reason: forget.kind || 'forget', scope: 'owned' })
        }
        if (forget.mode === 'self_nickname' && memory.longTerm.disableSelfNicknameMemories) {
          return memory.longTerm.disableSelfNicknameMemories({ actor: username, reason: forget.kind || 'revoke' })
        }
        return { ok: false, disabled: [] }
      })()
      const disabledCount = Array.isArray(res.disabled) ? res.disabled.length : 0
      if (disabledCount && contextBus) {
        try { contextBus.pushEvent('memory.disabled', `${username}:${disabledCount}`) } catch {}
      }
      if (forget.kind === 'revoke') {
        const q = String(forget.query || '').trim().slice(0, 24)
        if (q) {
          const pref = `${username}不希望被称为“${q}”。`
          try { memory.longTerm.addEntry?.({ text: pref, author: username, source: 'player', importance: 2 }) } catch {}
        }
      }
      if (!disabledCount) {
        pulse.sendChatReply(username, '我没找到要忘的那条记忆…你说更具体点？', { reason: 'memory_forget_none' })
        return
      }
      pulse.sendChatReply(username, '好，我不再这样说了。', { reason: 'memory_forget' })
      return
    }
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
    // Pending rule: while an AI request is in-flight, accumulate incoming chat;
    // pending input can interrupt the current model request and is injected into the ongoing tool loop.
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
      const { reply, memoryRefs } = await callAI(username, text, intent)
      if (reply) {
        noteUsage(username)
        if (state.ai.trace && log?.info) log.info('reply ->', reply)
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
    dryDialogue,
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
