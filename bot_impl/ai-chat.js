// AI chat dispatcher for in-game dialogue.
// Rule: if a player message starts with "owk", route it to the DeepSeek-compatible chat API
// and reply concisely. Per‑player short memory is kept across hot reloads via shared state.

const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const DEFAULT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const DEFAULT_PATH = process.env.DEEPSEEK_PATH || '/v1/chat/completions'
const H = require('./ai-chat-helpers')
const actionsMod = require('./actions')
const observer = require('./agent/observer')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  state.ai = state.ai || {
    enabled: true,
    key: process.env.DEEPSEEK_API_KEY || null,
    baseUrl: DEFAULT_BASE,
    path: DEFAULT_PATH,
    model: DEFAULT_MODEL,
    maxReplyLen: 120,
    limits: null,
    // Cost control
    currency: (process.env.AI_CURRENCY || 'USD'),
    priceInPerKT: parseFloat(process.env.AI_PRICE_IN_PER_KT || '0'),   // USD per 1k input tokens
    priceOutPerKT: parseFloat(process.env.AI_PRICE_OUT_PER_KT || '0'), // USD per 1k output tokens
    budgetDay: null,    // e.g. 1.5 (CNY/USD)
    budgetMonth: null,  // e.g. 10 (CNY/USD)
    budgetTotal: null,  // lifetime cap since bot started
    maxTokensPerCall: 512, // projected worst-case to pre-check against budget
    notifyOnBudget: true,
    // Context memory (global)
    context: { include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5, recentStoreMax: 200, owkStoreMax: 100 },
    trace: false
  }
  // normalize context defaults across reloads
  const DEF_CTX = {
    include: true,
    recentCount: 8,
    recentWindowSec: 300,
    includeOwk: true,
    owkWindowSec: 900,
    owkMax: 5,
    recentStoreMax: 200,
    owkStoreMax: 100,
    game: { include: true, nearPlayerRange: 16, nearPlayerMax: 5, dropsRange: 8, dropsMax: 6, invTop: 6 }
  }
  if (!state.ai.context) state.ai.context = DEF_CTX
  else state.ai.context = {
    ...DEF_CTX,
    ...state.ai.context,
    game: { ...DEF_CTX.game, ...(state.ai.context.game || {}) }
  }

  // global recent chat logs
  state.aiRecent = state.aiRecent || [] // [{t, user, text}]
  state.aiOwk = state.aiOwk || []       // subset with owk
  state.aiLong = state.aiLong || []     // long-term summaries [{t, summary}]
  state.aiStats = state.aiStats || { perUser: new Map(), global: [] }
  state.aiSpend = state.aiSpend || { day: { start: dayStart(), inTok: 0, outTok: 0, cost: 0 }, month: { start: monthStart(), inTok: 0, outTok: 0, cost: 0 }, total: { inTok: 0, outTok: 0, cost: 0 } }

  const ctrl = { busy: false, abort: null }

  function now () { return Date.now() }
  function trimWindow (arr, windowMs) { const t = now(); return arr.filter(ts => t - ts <= windowMs) }
  function statFor (username) {
    if (!state.aiStats.perUser.has(username)) state.aiStats.perUser.set(username, [])
    return state.aiStats.perUser.get(username)
  }

  function dayStart (t = now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  function monthStart (t = now()) { const d = new Date(t); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() }

  function rollSpendWindows () {
    const t = now()
    const d0 = dayStart(t)
    const m0 = monthStart(t)
    if (state.aiSpend.day.start !== d0) state.aiSpend.day = { start: d0, inTok: 0, outTok: 0, cost: 0 }
    if (state.aiSpend.month.start !== m0) state.aiSpend.month = { start: m0, inTok: 0, outTok: 0, cost: 0 }
  }

  const estTokensFromText = H.estTokensFromText

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

  function projectedCostForCall (promptTok, outTokMax) {
    const { priceInPerKT, priceOutPerKT } = state.ai
    return H.projectedCostForCall(priceInPerKT, priceOutPerKT, promptTok, outTokMax)
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
    state.aiSpend.day.inTok += inTok; state.aiSpend.day.outTok += outTok; state.aiSpend.day.cost += cost
    state.aiSpend.month.inTok += inTok; state.aiSpend.month.outTok += outTok; state.aiSpend.month.cost += cost
    state.aiSpend.total.inTok += inTok; state.aiSpend.total.outTok += outTok; state.aiSpend.total.cost += cost
  }

  function canProceed (username) {
    const L = state.ai.limits
    if (!L) return { ok: true }
    const t = now()
    const userArr = statFor(username)
    const globArr = state.aiStats.global
    // Cooldown check
    if (L.cooldownMs && userArr.length > 0) {
      const last = userArr[userArr.length - 1]
      if (t - last < L.cooldownMs) return { ok: false, reason: 'cooldown' }
    }
    // Per-user per-minute
    if (L.userPerMin != null) {
      const u1 = trimWindow(userArr, 60_000)
      if (u1.length >= L.userPerMin) return { ok: false, reason: 'userPerMin' }
    }
    // Per-user per-day
    if (L.userPerDay != null) {
      const uD = trimWindow(userArr, 86_400_000)
      if (uD.length >= L.userPerDay) return { ok: false, reason: 'userPerDay' }
    }
    // Global per-minute
    if (L.globalPerMin != null) {
      const g1 = trimWindow(globArr, 60_000)
      if (g1.length >= L.globalPerMin) return { ok: false, reason: 'globalPerMin' }
    }
    // Global per-day
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
    // GC arrays
    state.aiStats.global = trimWindow(state.aiStats.global, 86_400_000)
    const recent = trimWindow(arr, 86_400_000)
    state.aiStats.perUser.set(username, recent)
  }

  // no per-user memory helpers

  function systemPrompt () {
    return [
      '你是Minecraft服务器中的简洁助手。',
      '优先使用“游戏上下文”和“聊天上下文”的信息作答，直接引用其中的数值与列表。',
      '风格：中文、极简、单句；',
      '如果用户请求执行游戏内操作，请只输出一行: TOOL {"tool":"<名字>","args":{...}}，不要输出其他文字。',
      '可用工具示例: hunt_player{name,range?,durationMs?}, guard{name,radius?}, follow_player{name,range?}, goto{x,y,z,range?}, stop{mode?="soft"|"hard"}, say{text}, equip{name,dest?}, toss{items:[{name|slot,count?},...]}, break_blocks{match?|names?,area:{shape:"sphere"|"down",radius?,height?,steps?,origin?},max?,collect?}, mount_near{radius?,prefer?}, dismount{}, flee_trap{radius?}, observe_detail{what?=entities|players|hostiles|blocks|inventory,radius?,max?}, skill_start{skill,args,expected?}, skill_status{taskId}, skill_cancel{taskId}.',
      '提到：',
      ' - 位置/维度/时间：引用 游戏上下文 的 位置/维度/昼夜。',
      ' - 附近玩家/掉落物：引用相应列表或说“没有”。',
      ' - 背包：引用“背包:”中的物品。'
    ].join('\n')
  }

  function trimReply (text, maxLen) {
    if (typeof text !== 'string') return ''
    const t = text.replace(/\s+/g, ' ').trim()
    if (t.length <= maxLen) return t
    return t.slice(0, Math.max(0, maxLen - 1)) + '…'
  }

  function buildContextPrompt (username) {
    const ctx = state.ai.context || { include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5 }
    return H.buildContextPrompt(username, state.aiRecent, state.aiOwk, ctx)
  }

  // --- Game context via observer ---
  function buildGameContext () {
    try {
      const g = state.ai.context?.game
      if (!g || g.include === false) return ''
      const snap = observer.snapshot(bot, {
        invTop: g.invTop || 6,
        nearPlayerRange: g.nearPlayerRange || 16,
        nearPlayerMax: g.nearPlayerMax || 5,
        dropsRange: g.dropsRange || 8,
        dropsMax: g.dropsMax || 6,
        hostileRange: 24
      })
      return observer.toPrompt(snap)
    } catch { return '' }
  }
  function selectMemory (username, budgetTok) {
    return H.selectMemory(getMemory(username), budgetTok)
  }

  async function callAI (username, content) {
    const { key, baseUrl, path, model, maxReplyLen } = state.ai
    if (!key) throw new Error('AI key not configured')
    const url = (baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (path || DEFAULT_PATH)

    // Build messages with per-user memory (short context)
    // Build context from global recent chat (including owk lines) and game state
    const contextPrompt = buildContextPrompt(username)
    const gameCtx = buildGameContext()
    const messages = [
      { role: 'system', content: systemPrompt() },
      gameCtx ? { role: 'system', content: gameCtx } : null,
      { role: 'system', content: contextPrompt },
      { role: 'user', content }
    ].filter(Boolean)

    // Optional trace of contexts
    if (state.ai.trace && log?.info) {
      try {
        log.info('gameCtx ->', buildGameContext())
        log.info('chatCtx ->', buildContextPrompt(username))
      } catch {}
    }

    // Pre-check against budget using a rough input token estimate
    const estIn = estTokensFromText(messages.map(m => m.content).join(' '))
    const afford = canAfford(estIn)
    if (state.ai.trace && log?.info) log.info('precheck inTok~=', estIn, 'projCost~=', (afford.proj||0).toFixed(4), 'rem=', afford.rem)
    if (!afford.ok) {
      const msg = state.ai.notifyOnBudget ? 'AI余额不足，稍后再试~' : ''
      throw new Error(msg || 'budget_exceeded')
    }

    const body = {
      model: model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 80,
      stream: false
    }

    const ac = new AbortController()
    ctrl.abort = ac
    const timeout = setTimeout(() => ac.abort('timeout'), 12000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status))
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      const reply = data?.choices?.[0]?.message?.content || ''
      // Tool-call protocol: reply can be like \nTOOL {"tool":"attack_player","args":{"name":"Ameyaku"}}\n
      const toolMatch = reply.match(/^[^\S\n]*TOOL\s*(\{[\s\S]*\})/)
      if (toolMatch) {
        let payload = null
        try { payload = JSON.parse(toolMatch[1]) } catch {}
        if (payload && payload.tool) {
          const tools = actionsMod.install(bot, { log })
          const res = await tools.run(payload.tool, payload.args || {})
          if (state.ai.trace && log?.info) log.info('tool ->', payload.tool, payload.args, res)
          // Acknowledge in chat succinctly
          return H.trimReply(res.ok ? (res.msg || '好的') : (`失败: ${res.msg || '未知'}`), maxReplyLen || 120)
        }
      }
      // Usage accounting (if provided), otherwise rough estimate
      const u = data?.usage || {}
      const inTok = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : estIn
      const outTok = Number.isFinite(u.completion_tokens) ? u.completion_tokens : estTokensFromText(reply)
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

  async function handleChat (username, message) {
    const raw = String(message || '')
    const m = raw.trim()
    if (!/^owk\b/i.test(m)) return
    let content = m.replace(/^owk\b\s*/i, '')
    content = content.replace(/^[:：,，。.!！\s]+/, '')
    if (!state.ai.enabled) return
    if (!content) return
    if (ctrl.busy) return // drop if previous still running to avoid flooding
    const allowed = canProceed(username)
    if (!allowed.ok) {
      if (state.ai?.limits?.notify !== false) {
        try { bot.chat('太快啦，稍后再试~') } catch {}
      }
      return
    }

    ctrl.busy = true
    try {
      if (state.ai.trace && log?.info) log.info('ask <-', content)
      const reply = await callAI(username, content)
      if (reply) {
        noteUsage(username)
        if (state.ai.trace && log?.info) log.info('reply ->', reply)
        try { bot.chat(reply) } catch {}
      }
    } catch (e) {
      dlog('ai error:', e?.message || e)
      // Optional: notify user softly if misconfigured
      if (/key not configured/i.test(String(e))) {
        try { bot.chat('AI未配置') } catch {}
      } else if (/budget/i.test(String(e)) && state.ai.notifyOnBudget) {
        try { bot.chat('AI余额不足') } catch {}
      }
    } finally {
      ctrl.busy = false
    }
  }

  const onChat = (username, message) => { handleChat(username, message).catch(() => {}) }
  on('chat', onChat)
  // capture recent chats for context (store even if不以owk开头)
  const onChatCapture = (username, message) => {
    try {
      const text = String(message || '').trim()
      const entry = { t: now(), user: username, text: text.slice(0, 160) }
      state.aiRecent.push(entry)
      const cs = state.ai.context || {}
      const recentMax = Math.max(20, cs.recentStoreMax || 200)
      if (state.aiRecent.length > recentMax) {
        // summarize overflow asynchronously and trim
        ;(async () => {
          try {
            const overflow = state.aiRecent.splice(0, state.aiRecent.length - recentMax)
            // summarize only if we have enough lines
            if (overflow.length >= 20) {
              const sum = await (async () => {
                if (!state.ai?.key) return null
                const sys = '你是对Minecraft服务器聊天内容做摘要的助手。请用中文，20-40字，概括下面聊天要点，保留人名与关键物品/地点。不要换行。'
                const prompt = overflow.map(r => `${r.user}: ${r.text}`).join(' | ')
                const messages = [ { role: 'system', content: sys }, { role: 'user', content: prompt } ]
                const url = (state.ai.baseUrl || DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || DEFAULT_PATH)
                const body = { model: state.ai.model || DEFAULT_MODEL, messages, temperature: 0.2, max_tokens: 60, stream: false }
                try {
                  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.ai.key}` }, body: JSON.stringify(body) })
                  if (!res.ok) return null
                  const data = await res.json()
                  return data?.choices?.[0]?.message?.content?.trim() || null
                } catch { return null }
              })()
              if (sum) {
                state.aiLong.push({ t: Date.now(), summary: sum })
                if (state.aiLong.length > 50) state.aiLong.splice(0, state.aiLong.length - 50)
                try {
                  const DATA_DIR = require('path').resolve(process.cwd(), 'data')
                  require('fs').mkdirSync(DATA_DIR, { recursive: true })
                  require('fs').writeFileSync(require('path').join(DATA_DIR, 'ai-memory.json'), JSON.stringify({ version: 1, long: state.aiLong }))
                } catch {}
                if (state.ai.trace && log?.info) log.info('long summary ->', sum)
              }
            }
          } catch {}
        })()
      }
      if (/\bowk\b/i.test(text)) {
        state.aiOwk.push(entry)
        const owkMax = Math.max(10, cs.owkStoreMax || 100)
        if (state.aiOwk.length > owkMax) state.aiOwk.splice(0, state.aiOwk.length - owkMax)
      }
    } catch {}
  }
  on('chat', onChatCapture)
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChat) } catch {} ; if (ctrl.abort) { try { ctrl.abort.abort() } catch {} } })
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChatCapture) } catch {} })

  // Terminal controls: .ai ...
  function onCli (payload) {
    try {
      if (!payload || payload.cmd !== 'ai') return
      const [sub, ...rest] = payload.args || []
      const print = (...a) => console.log('[AICTL]', ...a)
      switch ((sub || '').toLowerCase()) {
        case 'on': state.ai.enabled = true; print('enabled'); break
        case 'off': state.ai.enabled = false; print('disabled'); break
        case 'key': state.ai.key = rest.join(' ').trim() || null; print('key set'); break
        case 'model': state.ai.model = rest[0] || state.ai.model; print('model =', state.ai.model); break
        case 'base': state.ai.baseUrl = rest[0] || state.ai.baseUrl; print('base =', state.ai.baseUrl); break
        case 'path': state.ai.path = rest[0] || state.ai.path; print('path =', state.ai.path); break
        case 'max': state.ai.maxReplyLen = Math.max(20, parseInt(rest[0] || '120', 10)); print('maxReplyLen =', state.ai.maxReplyLen); break
        case 'clear': { state.aiRecent = []; print('recent chat cleared'); break }
        case 'ctx': {
          try { print('gameCtx ->', buildGameContext()); print('chatCtx ->', buildContextPrompt('')) } catch {}
          break
        }
        case 'tools': {
          const tools = require('./actions').install(bot, { log })
          print('tools =', tools.list())
          break
        }
        case 'limit': {
          const k = (rest[0] || '').toLowerCase()
          const v = rest[1]
          state.ai.limits = state.ai.limits || { notify: true }
          switch (k) {
            case 'show':
              print('limits=', state.ai.limits || null)
              break
            case 'off':
              state.ai.limits = null
              print('limits disabled')
              break
            case 'usermin':
              state.ai.limits.userPerMin = v == null ? null : Math.max(0, parseInt(v, 10))
              print('userPerMin =', state.ai.limits.userPerMin)
              break
            case 'userday':
              state.ai.limits.userPerDay = v == null ? null : Math.max(0, parseInt(v, 10))
              print('userPerDay =', state.ai.limits.userPerDay)
              break
            case 'globalmin':
              state.ai.limits.globalPerMin = v == null ? null : Math.max(0, parseInt(v, 10))
              print('globalPerMin =', state.ai.limits.globalPerMin)
              break
            case 'globalday':
              state.ai.limits.globalPerDay = v == null ? null : Math.max(0, parseInt(v, 10))
              print('globalPerDay =', state.ai.limits.globalPerDay)
              break
            case 'cooldown':
              state.ai.limits.cooldownMs = v == null ? null : Math.max(0, parseInt(v, 10))
              print('cooldownMs =', state.ai.limits.cooldownMs)
              break
            case 'notify':
              state.ai.limits.notify = ['1','true','on','yes'].includes(String(v).toLowerCase())
              print('notify =', state.ai.limits.notify)
              break
            default:
              print('limit usage: .ai limit show|off|usermin N|userday N|globalmin N|globalday N|cooldown ms|notify on|off')
          }
          break
        }
        case 'trace': {
          const v = (rest[0] || '').toLowerCase()
          state.ai.trace = ['1','true','on','yes'].includes(v)
          print('trace =', state.ai.trace)
          break
        }
        case 'budget': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          switch (k) {
            case 'show':
              rollSpendWindows()
              print('currency=', state.ai.currency, 'price(in/out)=', state.ai.priceInPerKT, state.ai.priceOutPerKT, 'budget(day/month)=', state.ai.budgetDay, state.ai.budgetMonth)
              print('spent day=', state.aiSpend.day, 'spent month=', state.aiSpend.month)
              break
            case 'currency': state.ai.currency = v || state.ai.currency; print('currency=', state.ai.currency); break
            case 'pricein': state.ai.priceInPerKT = Math.max(0, parseFloat(v || '0') || 0); print('priceInPerKT=', state.ai.priceInPerKT); break
            case 'priceout': state.ai.priceOutPerKT = Math.max(0, parseFloat(v || '0') || 0); print('priceOutPerKT=', state.ai.priceOutPerKT); break
            case 'day': state.ai.budgetDay = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetDay=', state.ai.budgetDay); break
            case 'month': state.ai.budgetMonth = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetMonth=', state.ai.budgetMonth); break
            case 'total': state.ai.budgetTotal = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetTotal=', state.ai.budgetTotal); break
            case 'maxtokens': state.ai.maxTokensPerCall = Math.max(64, parseInt(v || '512', 10)); print('maxTokensPerCall=', state.ai.maxTokensPerCall); break
            case 'notify': state.ai.notifyOnBudget = ['1','true','on','yes'].includes(String(v).toLowerCase()); print('notifyOnBudget=', state.ai.notifyOnBudget); break
            case 'resetday': state.aiSpend.day = { start: dayStart(), inTok: 0, outTok: 0, cost: 0 }; print('day spend reset'); break
            case 'resetmonth': state.aiSpend.month = { start: monthStart(), inTok: 0, outTok: 0, cost: 0 }; print('month spend reset'); break
            case 'resettotal': state.aiSpend.total = { inTok: 0, outTok: 0, cost: 0 }; print('total spend reset'); break
            default:
              print('budget usage: .ai budget show|currency USD|pricein 0.002|priceout 0.002|day 1.5|month 10|maxtokens 512|notify on|resetday|resetmonth')
          }
          break
        }
        // mem subcommand removed (using global recent chat only)
        case 'context': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          state.ai.context = state.ai.context || { include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5, recentStoreMax: 200, owkStoreMax: 100 }
          switch (k) {
            case 'on': state.ai.context.include = true; print('context include=true'); break
            case 'off': state.ai.context.include = false; print('context include=false'); break
            case 'recent': state.ai.context.recentCount = Math.max(0, parseInt(v || '3', 10)); print('context recentCount=', state.ai.context.recentCount); break
            case 'window': state.ai.context.recentWindowSec = Math.max(10, parseInt(v || '120', 10)); print('context recentWindowSec=', state.ai.context.recentWindowSec); break
            case 'owkmax': state.ai.context.owkMax = Math.max(0, parseInt(v || '5', 10)); print('context owkMax=', state.ai.context.owkMax); break
            case 'owkwindow': state.ai.context.owkWindowSec = Math.max(10, parseInt(v || '900', 10)); print('context owkWindowSec=', state.ai.context.owkWindowSec); break
            case 'recentmax': state.ai.context.recentStoreMax = Math.max(20, parseInt(v || '200', 10)); print('context recentStoreMax=', state.ai.context.recentStoreMax); break
            case 'owkstoremax': state.ai.context.owkStoreMax = Math.max(10, parseInt(v || '100', 10)); print('context owkStoreMax=', state.ai.context.owkStoreMax); break
            case 'show': default: print('context =', state.ai.context)
          }
          break
        }
        case 'info': default:
          print('enabled=', state.ai.enabled, 'model=', state.ai.model, 'base=', state.ai.baseUrl, 'path=', state.ai.path, 'max=', state.ai.maxReplyLen, 'limits=', state.ai.limits || null)
      }
    } catch (e) { dlog('ai cli error:', e?.message || e) }
  }
  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
