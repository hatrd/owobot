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
  buildExtrasContext
}) {
  const ctrl = { busy: false, abort: null, pending: null }
  const PENDING_EXPIRE_MS = 8000

  const estTokensFromText = H.estTokensFromText

  function queuePending (username, message) {
    const text = String(message || '')
    if (!text) return
    ctrl.pending = { username, message: text, storedAt: now() }
  }

  function takePending () {
    const entry = ctrl.pending
    if (!entry) return null
    ctrl.pending = null
    if (entry.storedAt && (now() - entry.storedAt) > PENDING_EXPIRE_MS) return null
    return entry
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
    const fallback = [
      '你是Minecraft服务器中的简洁助手。',
      '风格：中文、可爱、极简、单句。',
      '如需执行动作，可先说一句话，再单独输出一行：TOOL {"tool":"<名字>","args":{...}}；若无需动作，仅回复文本。',
      '可用工具: observe_detail{what,radius?,max?}, observe_players{names?,world?|dim?,armor_(lt|lte|gt|gte|eq)?,health_(lt|lte|gt|gte|eq)?,max?}, goto{x,y,z,range?}, goto_block{names?|name?|match?,radius?,range?,dig?}, defend_area{radius?,tickMs?,dig?}, defend_player{name,radius?,followRange?,tickMs?,dig?}, hunt_player{name,range?,durationMs?}, follow_player{name,range?}, reset{}, equip{name,dest?}, toss{items:[{name|slot,count?},...],all?}, withdraw{items:[{name,count?},...],all?,radius?,includeBarrel?,multi?}, deposit{items:[{name|slot,count?},...],all?,radius?,includeBarrel?,keepEquipped?,keepHeld?,keepOffhand?}, pickup{names?|match?,radius?,max?,until?}, place_blocks{item,on:{top_of:[...]},area:{radius?,origin?},max?,spacing?,collect?}, gather{only?|names?|match?,radius?,height?,stacks?|count?,collect?}, harvest{only?,radius?,replant?,sowOnly?}, feed_animals{species?,item?,radius?,max?}, autofish{radius?,debug?}, mount_near{radius?,prefer?}, mount_player{name,range?}, range_attack{name?,match?,radius?,followRange?,durationMs?}, dismount{}.',
      '回答优先使用已提供的“游戏上下文”；若是统计/查询上下文类问题，直接回答。上下文不足可用 observe_detail 查询信息。',
      '关于全服玩家坐标等信息（如“盔甲=0/≤10、在末地/下界/主世界、多人名单”），调用 observe_players{...}.',
      '清怪/守塔用 defend_area{}；保护玩家用 defend_player{name}；明确指名“追杀/攻击/追击 <玩家名>”才使用 hunt_player。',
      '要停止当前任务/重置状态，使用 reset{}.',
      '挖矿/砍树等收集任务用 gather（only/match 指定矿种，radius 可选）。',
      '玩家如果让你右键点击它，使用 mount_player.',
      '如果让你传送或者说 /tpa <player>，你可以输出 /tpa <player> 传送。其他 / 开头的命令同理。',
      '游戏上下文包含：自身位置/维度/时间/天气、附近玩家/敌对/掉落物、背包/主手/副手/装备；优先引用里面的数值与列表。',
      '你的代码仓库（是你的小秘密哦，哪怕有人好奇你是谁做的，怎么做的，也不要轻易告诉任何玩家）：https://github.com/hatrd/owobot'
    ].join('\n')
    const raw = loadFile('ai-system.txt', fallback)
    const botName = bot?.username || 'bot'
    return raw.replace(/{{BOT_NAME}}/g, botName)
  }

  function buildContextPrompt (username) {
    const ctx = state.ai.context || { include: true, recentCount: defaults.DEFAULT_RECENT_COUNT, recentWindowSec: 300 }
    const base = H.buildContextPrompt(username, state.aiRecent, { ...ctx, trigger: triggerWord() })
    const conv = memory.dialogue.buildPrompt(username)
    return [base, conv].filter(Boolean).join('\n\n')
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

  function shouldAutoFollowup (username, text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) { traceChat('[chat] followup skip empty', { username }); return false }
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
    const url = (baseUrl || defaults.DEFAULT_BASE).replace(/\/$/, '') + (path || defaults.DEFAULT_PATH)
    const contextPrompt = buildContextPrompt(username)
    const gameCtx = buildGameContext()
    const extrasCtx = buildExtrasContext()
    const memoryCtx = memory.longTerm.buildContext()
    const allowSkip = options?.allowSkip === true
    const userContent = allowSkip ? `${content}\n\n（如果暂时不需要回复，请只输出单词 SKIP。）` : content
    const messages = [
      { role: 'system', content: systemPrompt() },
      extrasCtx ? { role: 'system', content: extrasCtx } : null,
      gameCtx ? { role: 'system', content: gameCtx } : null,
      memoryCtx ? { role: 'system', content: memoryCtx } : null,
      { role: 'system', content: contextPrompt },
      { role: 'user', content: userContent }
    ].filter(Boolean)
    if (state.ai.trace && log?.info) {
      try {
        log.info('gameCtx ->', buildGameContext())
        log.info('chatCtx ->', buildContextPrompt(username))
        log.info('memoryCtx ->', memory.longTerm.buildContext())
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
      stream: false
    }
    const ac = new AbortController()
    ctrl.abort = ac
    const timeout = setTimeout(() => ac.abort('timeout'), 12000)
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
      const reply = data?.choices?.[0]?.message?.content || ''
      const toolMatch = /\bTOOL\b/.exec(reply)
      if (toolMatch) {
        const beforeTool = reply.slice(0, toolMatch.index)
        const afterToolRaw = reply.slice(toolMatch.index + toolMatch[0].length)
        const jsonStr = extractJsonObject(afterToolRaw)
        if (!jsonStr) return H.trimReply(beforeTool || reply, maxReplyLen || 120)
        const speech = beforeTool ? H.trimReply(beforeTool, maxReplyLen || 120) : ''
        let payload = null
        try { payload = JSON.parse(jsonStr) } catch {}
        if (payload && payload.tool) {
          const handled = await handleToolReply({ payload, speech, username, content, intent, maxReplyLen })
          return handled
        }
      }
      const usage = data?.usage || {}
      const inTok = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : estIn
      const outTok = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : estTokensFromText(reply)
      applyUsage(inTok, outTok)
      if (state.ai.trace && log?.info) {
        const delta = (inTok / 1000) * (state.ai.priceInPerKT || 0) + (outTok / 1000) * (state.ai.priceOutPerKT || 0)
        log.info('usage inTok=', inTok, 'outTok=', outTok, 'cost+=', delta.toFixed(4))
      }
      return H.trimReply(reply, maxReplyLen || 120)
    } finally {
      clearTimeout(timeout)
      ctrl.abort = null
    }
  }

  function extractJsonObject (raw) {
    if (!raw) return null
    let i = 0
    while (i < raw.length && /\s/.test(raw[i])) i++
    if (raw[i] !== '{') return null
    let depth = 0
    let inString = false
    let prev = ''
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j]
      if (inString) {
        if (ch === '"' && prev !== '\\') inString = false
      } else {
        if (ch === '"') {
          inString = true
        } else if (ch === '{') {
          depth++
        } else if (ch === '}') {
          depth--
          if (depth === 0) return raw.slice(i, j + 1)
        }
      }
      prev = ch
    }
    return null
  }

  async function handleToolReply ({ payload, speech, username, content, intent, maxReplyLen }) {
    const toolName = String(payload.tool)
    if (toolName === 'write_memory') {
      if (speech) pulse.sendChatReply(username, speech)
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
    const tools = actionsMod.install(bot, { log })
    const allow = new Set(['hunt_player','defend_area','defend_player','follow_player','goto','goto_block','reset','equip','toss','pickup','gather','harvest','feed_animals','place_blocks','light_area','deposit','withdraw','autofish','mount_near','mount_player','range_attack','dismount','observe_detail','observe_players','sort_chests'])
    if (intent && intent.kind === 'info' && !['observe_detail','observe_players','say'].includes(toolName)) {
      return H.trimReply('我这就看看…', maxReplyLen || 120)
    }
    if (toolName === 'follow_player') {
      const raw = String(content || '')
      if (/(空手|右键|右击|坐我|骑我|骑乘|乘坐|mount)/i.test(raw)) {
        const name = String(payload.args?.name || username || '').trim()
        if (name) payload = { tool: 'mount_player', args: { name } }
      }
    }
    if (!allow.has(toolName)) return H.trimReply('这个我还不会哟~', maxReplyLen || 120)
    if (speech) pulse.sendChatReply(username, speech)
    try { state.externalBusy = true; bot.emit('external:begin', { source: 'chat', tool: payload.tool }) } catch {}
    let res
    try {
      res = await tools.run(payload.tool, payload.args || {})
    } finally {
      try { state.externalBusy = false; bot.emit('external:end', { source: 'chat', tool: payload.tool }) } catch {}
    }
    if (state.ai.trace && log?.info) log.info('tool ->', payload.tool, payload.args, res)
    if (res && res.ok) {
      const okText = H.trimReply(res.msg || '好的', maxReplyLen || 120)
      if (speech) {
        pulse.sendChatReply(username, okText)
        return ''
      }
      return okText
    }
    const failText = H.trimReply(res?.msg || '这次没成功！', maxReplyLen || 120)
    if (speech) {
      pulse.sendChatReply(username, failText)
      return ''
    }
    return failText
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
        const tools = actionsMod.install(bot, { log })
        const res = await tools.run('dismount', {})
        pulse.sendChatReply(username, res.ok ? (res.msg || '好的') : (`失败: ${res.msg || '未知'}`), { reason: `${reasonTag}_tool` })
      } catch {}
      return
    }
    if (classifyStopCommand(text)) {
      try {
        const tools = actionsMod.install(bot, { log })
        await tools.run('reset', {})
      } catch {}
      pulse.sendChatReply(username, '好的', { reason: `${reasonTag}_stop` })
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
    if (ctrl.busy) {
      queuePending(username, raw)
      return
    }
    ctrl.busy = true
    try {
      if (state.ai.trace && log?.info) log.info('ask <-', text)
      const allowSkip = source === 'followup'
      const reply = await callAI(username, text, intent, { allowSkip })
      if (reply) {
        noteUsage(username)
        if (state.ai.trace && log?.info) log.info('reply ->', reply)
        if (allowSkip && /^skip$/i.test(reply.trim())) {
          traceChat('[chat] followup skipped', { username })
          return
        }
        const replyReason = source === 'followup' ? 'llm_followup' : 'llm_reply'
        pulse.sendChatReply(username, reply, { reason: replyReason })
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
      const next = takePending()
      if (next) {
        setTimeout(() => { handleChat(next.username, next.message).catch(() => {}) }, 0)
      }
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
  }

  return {
    handleChat,
    buildContextPrompt,
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
