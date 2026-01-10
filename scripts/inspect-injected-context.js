#!/usr/bin/env node

const path = require('path')
const fs = require('fs')

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.replace(/^--+/, '')
    const next = argv[i + 1]
    const hasValue = next && !next.startsWith('--')
    if (hasValue) { out[key] = next; i++; continue }
    out[key] = true
  }
  return out
}

function parseBool (value, fallback = false) {
  if (value == null) return fallback
  if (value === true) return true
  const v = String(value).trim().toLowerCase()
  if (!v) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return fallback
}

function readTextFile (filePath) {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return '' }
}

function buildSystemPrompt ({ projectRoot, botName }) {
  const raw = readTextFile(path.join(projectRoot, 'bot_impl', 'prompts', 'ai-system.txt'))
  if (!raw) return ''
  return raw.replace(/{{BOT_NAME}}/g, botName || 'bot')
}

function buildMetaContext ({ projectRoot, now }) {
  const timeUtils = require(path.join(projectRoot, 'bot_impl', 'time-utils'))
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

function buildIdentityContext ({ projectRoot, state, bot }) {
  try {
    const minimalSelf = require(path.join(projectRoot, 'bot_impl', 'minimal-self'))
    const ms = new minimalSelf.MinimalSelf(bot, state)
    return ms.buildIdentityContext() || ''
  } catch {
    return ''
  }
}

function usage () {
  return [
    'Usage:',
    '  node scripts/inspect-injected-context.js --player <name> --query <text> [--memory-limit <n>] [--debug] [--compare] [--json]',
    '',
    'Prints the exact snippets injected into LLM context for that player:',
    '- system prompt (ai-system.txt)',
    '- meta time context (buildMetaContext)',
    '- minimal-self identity context (best-effort offline)',
    '- long-term memory system message (memory.longTerm.buildContext)',
    '- chat context system message (context bus XML + dialogue memory)',
    '',
    'Examples:',
    "  node scripts/inspect-injected-context.js --player Shiki --query '我家在哪' --debug",
    '  node scripts/inspect-injected-context.js --player Shiki --query 你好 --json',
    "  node scripts/inspect-injected-context.js --player Shiki --query '基地坐标' --compare --json"
  ].join('\n')
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const player = args.player || args.username || args.user || args.p
  const query = typeof args.query === 'string' ? args.query : ''
  const memoryLimitRaw = args['memory-limit'] || args.memoryLimit || args.limit
  const memoryLimit = memoryLimitRaw != null ? Number(memoryLimitRaw) : null
  const debug = parseBool(args.debug, false)
  const compareRaw = args.compare
  const compare = (() => {
    if (compareRaw == null) return false
    if (compareRaw === true) return true
    if (compareRaw === false) return false
    const v = String(compareRaw).trim().toLowerCase()
    if (!v) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
    return true
  })()
  const json = parseBool(args.json, false) || String(args.format || '').toLowerCase() === 'json'
  const injectQuery = !args['no-inject-query'] && parseBool(args['inject-query'], true)
  const debugLimitRaw = args['debug-limit'] || args.debugLimit
  const debugLimit = debugLimitRaw != null ? Number(debugLimitRaw) : 12

  if (!player) {
    process.stderr.write(usage() + '\n')
    process.exitCode = 2
    return
  }

  const projectRoot = path.resolve(__dirname, '..')
  try { process.chdir(projectRoot) } catch {}
  const memoryStore = require(path.join(projectRoot, 'bot_impl', 'memory-store'))
  const peopleStore = require(path.join(projectRoot, 'bot_impl', 'people-store'))
  const H = require(path.join(projectRoot, 'bot_impl', 'ai-chat-helpers'))
  const { prepareAiState } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'state-init'))
  const { createMemoryService } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'memory'))
  const { createPeopleService } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'people'))
  const { buildMemoryQuery } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'memory-query'))
  const { createContextBus } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'context-bus'))
  const { createPulseService } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'pulse'))
  const defaults = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'config'))

  const state = {}
  const bot = { username: process.env.BOT_NAME || 'bot' }
  const log = null
  const now = () => Date.now()
  const dayStart = (t = now()) => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const monthStart = (t = now()) => {
    const d = new Date(t)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  const defaultsBundle = {
    DEFAULT_MODEL: defaults.DEFAULT_MODEL,
    DEFAULT_BASE: defaults.DEFAULT_BASE,
    DEFAULT_PATH: defaults.DEFAULT_PATH,
    DEFAULT_TIMEOUT_MS: defaults.DEFAULT_TIMEOUT_MS,
    DEFAULT_RECENT_COUNT: defaults.DEFAULT_RECENT_COUNT,
    DEFAULT_RECENT_WINDOW_SEC: defaults.DEFAULT_RECENT_WINDOW_SEC,
    DEFAULT_MEMORY_STORE_MAX: defaults.DEFAULT_MEMORY_STORE_MAX,
    buildDefaultContext: defaults.buildDefaultContext
  }

  const memory = createMemoryService({ state, log, memoryStore, defaults: defaultsBundle, bot, now })
  const people = createPeopleService({ state, peopleStore, now })
  const persistedMemory = memoryStore.load()
  const persistedEvolution = memoryStore.loadEvolution()

  prepareAiState(state, {
    defaults: defaultsBundle,
    persistedMemory,
    persistedEvolution,
    trimConversationStore: memory.dialogue.trimStore,
    updateWorldMemoryZones: memory.longTerm.updateWorldZones,
    dayStart,
    monthStart
  })

  const contextBus = createContextBus({ state, now })

  // Offline safety: ensure no accidental network calls for summarization/rewrites.
  try { state.ai.key = null } catch {}

  // Inject the request into recent/context-bus so contextPrompt matches the real call flow.
  const pulse = createPulseService({ state, bot, log, now, H, defaults: defaultsBundle, memory, feedbackCollector: null, contextBus })
  if (injectQuery && query) {
    try { pulse.captureChat(player, query) } catch {}
  }

  const recentChat = (() => {
    try {
      const store = contextBus.getStore ? contextBus.getStore() : []
      const out = []
      for (let i = store.length - 1; i >= 0 && out.length < 8; i--) {
        const e = store[i]
        if (!e || e.type !== 'player') continue
        const who = e.payload?.name
        if (String(who || '').trim() !== String(player || '').trim()) continue
        const text = e.payload?.content
        if (typeof text !== 'string' || !text.trim()) continue
        out.push({ user: who, text, t: e.t })
      }
      out.reverse()
      return out
    } catch {
      return []
    }
  })()

  const memoryQuery = query
    ? buildMemoryQuery({ username: player, message: query, recentChat, worldHint: null })
    : ''

  const ensureMemoryCfg = () => {
    if (!state.ai) state.ai = {}
    if (!state.ai.context || typeof state.ai.context !== 'object') state.ai.context = defaults.buildDefaultContext()
    if (!state.ai.context.memory || typeof state.ai.context.memory !== 'object') state.ai.context.memory = {}
    return state.ai.context.memory
  }
  const memoryCfg = ensureMemoryCfg()

  const runMemoryContext = async (modeOverride) => {
    const cfg = ensureMemoryCfg()
    const prevMode = cfg.mode
    if (modeOverride != null) cfg.mode = modeOverride
    try {
      const result = await memory.longTerm.buildContext({
        query: memoryQuery,
        actor: player,
        withRefs: true,
        ...(debug ? { debug: true, debugLimit } : {}),
        ...(Number.isFinite(memoryLimit) && memoryLimit > 0 ? { limit: Math.floor(memoryLimit) } : {})
      })
      const text = typeof result === 'string' ? result : (result?.text || '')
      const refs = Array.isArray(result?.refs) ? result.refs : []
      const dbg = result && typeof result === 'object' ? (result.debug || null) : null
      const trace = result && typeof result === 'object' ? (result.trace || null) : null
      return { text, refs, debug: dbg, trace }
    } finally {
      try { cfg.mode = prevMode } catch {}
    }
  }

  const memoryMode = typeof memoryCfg.mode === 'string' ? memoryCfg.mode : ''
  const memoryMain = await runMemoryContext(memoryMode)
  const memoryCtx = memoryMain.text || ''
  const memoryRefs = memoryMain.refs || []
  const memoryDebug = memoryMain.debug || null
  const memoryTrace = memoryMain.trace || null

  const compareModes = (() => {
    if (!compare) return []
    if (typeof compareRaw === 'string') {
      const raw = compareRaw.trim()
      const v = raw.toLowerCase()
      const isBoolToken = ['1', 'true', 'yes', 'y', 'on', '0', 'false', 'no', 'n', 'off'].includes(v)
      if (raw && !isBoolToken) return raw.split(',').map(s => String(s || '').trim()).filter(Boolean)
    }
    return ['keyword', 'v2', 'hybrid']
  })()

  const compareResults = {}
  if (compare && compareModes.length) {
    const seen = new Set()
    for (const rawMode of compareModes) {
      const mode = String(rawMode || '').trim()
      if (!mode) continue
      const key = mode.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      compareResults[mode] = await runMemoryContext(mode)
    }
  }

  const ctx = state.ai?.context || defaults.buildDefaultContext()
  const maxEntries = Number.isFinite(ctx.recentCount) ? Math.max(1, Math.floor(ctx.recentCount)) : defaults.DEFAULT_RECENT_COUNT
  const windowSec = Number.isFinite(ctx.recentWindowSec) ? Math.max(0, Math.floor(ctx.recentWindowSec)) : defaults.DEFAULT_RECENT_WINDOW_SEC
  const xmlCtx = contextBus.buildXml({ maxEntries, windowSec, includeGaps: true })
  const conv = memory.dialogue.buildPrompt(player)
  const contextPrompt = [`当前对话玩家: ${player}`, xmlCtx, conv].filter(Boolean).join('\n\n')

  const systemPrompt = buildSystemPrompt({ projectRoot, botName: bot.username })
  const metaCtx = buildMetaContext({ projectRoot, now })
  const identityCtx = buildIdentityContext({ projectRoot, state, bot })
  const peopleProfilesCtx = (() => {
    try { return people.buildAllProfilesContext() || '' } catch { return '' }
  })()
  const peopleCommitmentsCtx = (() => {
    try { return people.buildAllCommitmentsContext() || '' } catch { return '' }
  })()

  const messages = [
    systemPrompt ? { role: 'system', name: 'systemPrompt', content: systemPrompt } : null,
    metaCtx ? { role: 'system', name: 'metaCtx', content: metaCtx } : null,
    identityCtx ? { role: 'system', name: 'identityCtx', content: identityCtx } : null,
    peopleProfilesCtx ? { role: 'system', name: 'peopleProfilesCtx', content: peopleProfilesCtx } : null,
    peopleCommitmentsCtx ? { role: 'system', name: 'peopleCommitmentsCtx', content: peopleCommitmentsCtx } : null,
    memoryCtx ? { role: 'system', name: 'memoryCtx', content: memoryCtx } : null,
    { role: 'system', name: 'contextPrompt', content: contextPrompt }
  ].filter(Boolean)

  const tokenEst = messages.map(m => ({ name: m.name, tokens: H.estTokensFromText(m.content) }))
  const totalTokens = tokenEst.reduce((acc, it) => acc + (it.tokens || 0), 0)

  if (json) {
    const diffRefs = (a = [], b = []) => {
      const left = Array.isArray(a) ? a : []
      const right = Array.isArray(b) ? b : []
      const setL = new Set(left)
      const setR = new Set(right)
      return {
        common: left.filter(id => setR.has(id)),
        onlyLeft: left.filter(id => !setR.has(id)),
        onlyRight: right.filter(id => !setL.has(id))
      }
    }
    const compareDiff = (() => {
      if (!compare) return null
      const baselineMode = Object.prototype.hasOwnProperty.call(compareResults, 'keyword')
        ? 'keyword'
        : (Object.keys(compareResults)[0] || null)
      const base = baselineMode ? compareResults[baselineMode]?.refs : null
      if (!baselineMode || !Array.isArray(base)) return null
      const out = {}
      for (const [mode, res] of Object.entries(compareResults)) {
        if (mode === baselineMode) continue
        out[mode] = diffRefs(base, res?.refs)
      }
      return Object.keys(out).length ? { baseline: baselineMode, modes: out } : null
    })()

    const payload = {
      player,
      query,
      injectedQuery: Boolean(injectQuery && query),
      memory: {
        mode: memoryMode || null,
        query: memoryQuery || '',
        rawQuery: query || '',
        limit: Number.isFinite(memoryLimit) && memoryLimit > 0 ? Math.floor(memoryLimit) : (state.ai?.context?.memory?.max || 6),
        text: memoryCtx || '',
        refs: memoryRefs,
        debug: memoryDebug,
        trace: memoryTrace
      },
      ...(compare && Object.keys(compareResults).length
        ? { compare: { enabled: true, modes: Object.keys(compareResults), memory: compareResults, diff: compareDiff } }
        : null),
      chatContext: {
        xml: xmlCtx || '',
        dialogue: conv || '',
        text: contextPrompt || ''
      },
      people: {
        profiles: peopleProfilesCtx || '',
        commitments: peopleCommitmentsCtx || ''
      },
      messages,
      tokenEstimate: { total: totalTokens, perMessage: tokenEst }
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  const blocks = [
    `player: ${player}`,
    query ? `query: ${query}` : null,
    `injected.query: ${injectQuery && query ? 'yes' : 'no'}`,
    memoryQuery ? `memory.query: ${memoryQuery}` : null,
    `memory.limit: ${Number.isFinite(memoryLimit) && memoryLimit > 0 ? Math.floor(memoryLimit) : (state.ai?.context?.memory?.max || 6)}`,
    `token_est.total: ${totalTokens}`,
    tokenEst.length ? `token_est.by_message: ${tokenEst.map(it => `${it.name}=${it.tokens}`).join(', ')}` : null,
    '',
    '--- injected: systemPrompt (system) ---',
    systemPrompt || '(empty)',
    '',
    '--- injected: metaCtx (system) ---',
    metaCtx || '(empty)',
    '',
    '--- injected: identityCtx (system) ---',
    identityCtx || '(empty)',
    '',
    '--- injected: peopleProfilesCtx (system) ---',
    peopleProfilesCtx || '(empty)',
    '',
    '--- injected: peopleCommitmentsCtx (system) ---',
    peopleCommitmentsCtx || '(empty)',
    '',
    '--- injected: memoryCtx (system) ---',
    memoryCtx || '(empty)',
    memoryRefs.length ? `refs: ${memoryRefs.join(', ')}` : null,
    '',
    '--- injected: contextPrompt (system) ---',
    contextPrompt || '(empty)'
  ].filter(v => v != null)

  if (debug && memoryDebug) {
    blocks.push('')
    blocks.push('--- memory debug ---')
    blocks.push(`mode: ${memoryDebug.mode || 'unknown'}`)
    if (memoryTrace && Number.isFinite(memoryTrace.tokenEstimate)) blocks.push(`token_est.memoryCtx: ${memoryTrace.tokenEstimate}`)
    if (Array.isArray(memoryDebug.tokens)) blocks.push(`tokens: ${memoryDebug.tokens.join(', ')}`)
    if (Number.isFinite(memoryDebug.totalEntries)) blocks.push(`totalEntries: ${memoryDebug.totalEntries}`)
    if (Number.isFinite(memoryDebug.matchedCount)) blocks.push(`matchedCount: ${memoryDebug.matchedCount}`)
    if (Array.isArray(memoryDebug.scoredTop) && memoryDebug.scoredTop.length) {
      for (let i = 0; i < memoryDebug.scoredTop.length; i++) {
        const row = memoryDebug.scoredTop[i]
        const entry = row?.entry || {}
        const id = entry?.id || ''
        const summary = entry?.summary || ''
        blocks.push(`${i + 1}) score=${Number(row?.score || 0).toFixed(3)} hits=${row?.hits || 0} triggerHits=${row?.triggerHits || 0} id=${id} ${summary}`)
      }
    }
  }

  process.stdout.write(blocks.join('\n') + '\n')
}

main().catch(err => {
  process.stderr.write(String(err?.stack || err?.message || err) + '\n')
  process.exitCode = 1
})
