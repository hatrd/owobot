// Pure helpers for AI chat — unit-testable without bot state

function estTokensFromText (s) {
  if (!s) return 0
  return Math.ceil(String(s).length / 4)
}

function trimReply (text, maxLen) {
  if (typeof text !== 'string') return ''
  const t = text.replace(/\s+/g, ' ').trim()
  if (!Number.isFinite(maxLen) || maxLen <= 0) return t
  if (t.length <= maxLen) return t
  return t.slice(0, Math.max(0, maxLen - 1)) + '…'
}

function buildContextPrompt (username, recent, options = {}) {
  const DEFAULT_RECENT_COUNT = 50
  const DEFAULT_RECENT_WINDOW_SEC = 24 * 60 * 60
  const ctx = Object.assign({ include: true, recentCount: DEFAULT_RECENT_COUNT, recentWindowSec: DEFAULT_RECENT_WINDOW_SEC }, options)
  if (!ctx.include) return ''
  const now = Date.now()
  const recentWindowSec = Number.isFinite(Number(ctx.recentWindowSec))
    ? Math.max(0, Math.floor(Number(ctx.recentWindowSec)))
    : DEFAULT_RECENT_WINDOW_SEC
  const recentCount = Number.isFinite(Number(ctx.recentCount))
    ? Math.max(0, Math.floor(Number(ctx.recentCount)))
    : DEFAULT_RECENT_COUNT
  const cutoff = now - (recentWindowSec * 1000)
  const lines = (Array.isArray(recent) ? recent : [])
  const recentKept = recentCount <= 0
    ? []
    : lines
      .filter(r => (r?.t ?? cutoff) >= cutoff)
      .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
      .slice(-recentCount)
  const fmtTime = (ts) => {
    if (!Number.isFinite(ts)) return ''
    try {
      const date = new Date(ts)
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}`
    } catch { return '' }
  }
  const orderedLines = recentKept.map((r, idx) => {
    const base = String(r?.text || '').trim()
    const time = fmtTime(r?.t)
    const prefix = `${idx + 1}. ${r?.user || '??'}:`
    if (time) return `${prefix} [${time}] ${base}`
    return `${prefix} ${base}`
  })
  const summary = orderedLines.length
    ? `最近聊天顺序（旧→新）：\n${orderedLines.join('\n')}`
    : '最近聊天顺序（旧→新）：无'
  return `当前对话玩家: ${username}。\n${summary}`
}

function selectContextProfile (intent = {}, options = {}) {
  const explicit = String(options?.contextProfile || options?.profile || '').trim().toLowerCase()
  const reason = String(options?.reason || '').trim().toLowerCase()
  const topic = String(intent?.topic || '').trim().toLowerCase()
  const kind = String(intent?.kind || '').trim().toLowerCase()
  const nearby = intent?.nearby === true

  const profiles = {
    greet_minimal: {
      name: 'greet_minimal',
      recentCount: 0,
      recentWindowSec: 0,
      memoryQueryRecentCount: 0,
      includeSystem: true,
      includeMeta: false,
      includeGame: false,
      includeMemory: false,
      includePeople: false,
      includeCommitments: false,
      includeDialogue: false,
      includeRecent: false,
      withTools: false,
      maxInputTokens: 1200
    },
    chat_context: {
      name: 'chat_context',
      recentCount: 50,
      recentWindowSec: 24 * 60 * 60,
      memoryQueryRecentCount: 8,
      includeSystem: true,
      includeMeta: true,
      includeGame: true,
      includeMemory: true,
      includePeople: true,
      includeCommitments: true,
      includeDialogue: false,
      includeRecent: true,
      withTools: true,
      maxInputTokens: 5000
    },
    task_context: {
      name: 'task_context',
      recentCount: 16,
      recentWindowSec: 60 * 60,
      memoryQueryRecentCount: 6,
      includeSystem: true,
      includeMeta: true,
      includeGame: true,
      includeMemory: true,
      includePeople: true,
      includeCommitments: true,
      includeDialogue: false,
      includeRecent: true,
      withTools: true,
      maxInputTokens: 5000
    },
    local_observe_context: {
      name: 'local_observe_context',
      recentCount: 12,
      recentWindowSec: 30 * 60,
      memoryQueryRecentCount: 0,
      includeSystem: true,
      includeMeta: true,
      includeGame: true,
      includeMemory: false,
      includePeople: true,
      includeCommitments: false,
      includeDialogue: false,
      includeRecent: true,
      withTools: true,
      maxInputTokens: 3600
    },
    plan_context: {
      name: 'plan_context',
      recentCount: 20,
      recentWindowSec: 2 * 60 * 60,
      memoryQueryRecentCount: 8,
      includeSystem: true,
      includeMeta: true,
      includeGame: true,
      includeMemory: true,
      includePeople: true,
      includeCommitments: true,
      includeDialogue: true,
      includeRecent: true,
      withTools: true,
      maxInputTokens: 6500
    }
  }

  const clone = (name) => ({ ...profiles[name] })
  if (explicit === 'greet' || explicit === 'minimal' || explicit === 'greet_minimal') return clone('greet_minimal')
  if (explicit === 'chat' || explicit === 'chat_context') return clone('chat_context')
  if (explicit === 'task' || explicit === 'action' || explicit === 'query' || explicit === 'task_context') return clone('task_context')
  if (explicit === 'plan' || explicit === 'loop' || explicit === 'tool_loop' || explicit === 'plan_context') return clone('plan_context')

  if (reason === 'look_greet' || reason === 'auto-look' || reason === 'auto_look') return clone('greet_minimal')
  if (topic === 'greet' && nearby) return clone('greet_minimal')
  if (topic === 'plan') return clone('plan_context')
  if (['drops', 'players'].includes(topic)) return clone('local_observe_context')
  if (kind === 'action' || kind === 'command') return clone('task_context')
  if (['position', 'players', 'drops', 'observe'].includes(topic)) return clone('task_context')
  return clone('chat_context')
}

function classifyIntent (text) {
  const trimmed = String(text || '').trim()
  const lower = trimmed.toLowerCase()
  const intent = { topic: 'generic', nearby: false, kind: 'chat' }
  if (!trimmed) return intent
  if (/^\/tpa\s+/i.test(trimmed)) return { topic: 'command', nearby: false, kind: 'command' }
  if (/座标|坐标|坐標|在哪|哪里|哪儿|哪边|where|location|position|位置/.test(lower)) intent.topic = 'position'
  if (/谁在线|在线.*谁|附近.*谁|谁.*附近|附近.*玩家|玩家.*附近|player|玩家|同行|online/.test(lower)) intent.topic = 'players'
  if (/掉落|战利|loot|drop/.test(lower)) intent.topic = 'drops'
  if (/排行榜|排行|榜单|leaderboard|rank(ing)?/.test(lower)) intent.topic = 'leaderboard'
  if (intent.topic !== 'leaderboard' && /统计|在线时长|发言|聊天次数|死亡次数|活跃度|stats?\b/.test(lower)) intent.topic = 'stats'
  if (/承诺|待办|todo|promise|commitment/.test(lower)) intent.topic = 'commitment'
  if (/附近|near|around|周围/.test(lower)) intent.nearby = true
  if (/攻击|追击|追杀|清怪|清理|守护|防守|保护|护卫|跟随|跟着|跟我|跟上|跟来|移动|走到|走去|过去|去到|站到|站在|到.+上|到.+边|follow|kill|defend|hunt|guard|escort|move|walk|go to|goto/.test(lower)) intent.kind = 'action'
  if (intent.topic === 'generic' && /观察|看看|look|observe/.test(lower)) intent.topic = 'observe'
  return intent
}

function stripInternalMessageFields (msg, options = {}) {
  if (!msg || typeof msg !== 'object') return msg
  const out = {
    role: msg.role || 'system',
    content: String(msg.content || '')
  }
  if (options.keepName === true) out.name = msg.name || msg.label || undefined
  return out
}

function messageTokens (msg) {
  return estTokensFromText(String(msg?.content || ''))
}

function truncateTextForTokens (text, maxTokens, label = '') {
  const limit = Math.floor(Number(maxTokens) || 0)
  const raw = String(text || '')
  if (limit <= 0 || !raw) return ''
  if (estTokensFromText(raw) <= limit) return raw
  const prefix = label ? `[${label} 已按预算截断]\n` : '[已按预算截断]\n'
  const reserveChars = Math.max(0, (limit * 4) - prefix.length - 8)
  if (reserveChars <= 0) return prefix.trim()
  return prefix + raw.slice(0, reserveChars)
}

function fitMessagesToTokenBudget (messages, maxInputTokens, options = {}) {
  const budget = Math.floor(Number(maxInputTokens) || 0)
  const list = Array.isArray(messages) ? messages.filter(Boolean) : []
  const strip = (msg) => stripInternalMessageFields(msg, options)
  if (budget <= 0) return list.map(strip)
  if (list.reduce((sum, msg) => sum + messageTokens(msg), 0) <= budget) return list.map(strip)

  const fixed = list.filter(msg => msg.keep === true)
  const flexible = list.filter(msg => msg.keep !== true)
  const fixedTokens = fixed.reduce((sum, msg) => sum + messageTokens(msg), 0)
  let remaining = Math.max(0, budget - fixedTokens)
  const out = []
  for (const msg of list) {
    if (msg.keep === true) {
      out.push(msg)
      continue
    }
    const minTokens = Math.max(0, Math.floor(Number(msg.minTokens) || 0))
    const maxShare = Math.max(minTokens, Math.floor(Number(msg.maxTokens) || 0))
    const laterFlexible = flexible.filter(item => !out.includes(item) && item !== msg)
    const reservedForLater = laterFlexible.reduce((sum, item) => {
      const min = Math.max(0, Math.floor(Number(item?.minTokens) || 0))
      return sum + min
    }, 0)
    const allowance = Math.max(0, Math.min(
      maxShare || remaining,
      remaining - Math.min(remaining, reservedForLater)
    ))
    if (allowance <= 0) continue
    const content = truncateTextForTokens(msg.content, allowance, msg.label || msg.name || '')
    if (!content) continue
    const next = { ...msg, content }
    out.push(next)
    remaining = Math.max(0, remaining - messageTokens(next))
  }

  const finalTokens = out.reduce((sum, msg) => sum + messageTokens(msg), 0)
  if (finalTokens <= budget) return out.map(strip)

  const trimmed = []
  let used = 0
  for (const msg of out) {
    const tok = messageTokens(msg)
    if (used + tok <= budget) {
      trimmed.push(msg)
      used += tok
      continue
    }
    if (msg.keep === true) {
      const content = truncateTextForTokens(msg.content, Math.max(1, budget - used), msg.label || msg.name || '')
      if (content) trimmed.push({ ...msg, content })
      break
    }
  }
  return trimmed.map(strip)
}

function projectedCostForCall (priceInPerKT, priceOutPerKT, promptTok, outTokMax) {
  const cIn = (promptTok / 1000) * (priceInPerKT || 0)
  const cOut = (outTokMax / 1000) * (priceOutPerKT || 0)
  return cIn + cOut
}

function canAfford (estInTok, maxOutTok, budgets, prices) {
  const proj = projectedCostForCall(prices?.in || 0, prices?.out || 0, estInTok || 0, maxOutTok || 0)
  const remDay = budgets?.day ?? Infinity
  const remMonth = budgets?.month ?? Infinity
  const remTotal = budgets?.total ?? Infinity
  const ok = remDay >= proj && remMonth >= proj && remTotal >= proj
  return { ok, proj, rem: { day: remDay, month: remMonth, total: remTotal } }
}

function stripReasoningText (text) {
  if (typeof text !== 'string') return ''
  let s = text
  // Many reasoning models include chain-of-thought inside tags; never leak this to chat.
  // Examples: DeepSeek-R1: <think>...</think>
  s = s.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
  s = s.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '')
  // Handle missing closing tags by truncating to the prefix before the tag.
  s = s.replace(/<think\b[^>]*>[\s\S]*$/gi, '')
  s = s.replace(/<analysis\b[^>]*>[\s\S]*$/gi, '')
  // Remove any stray tags left behind.
  s = s.replace(/<\/?think\b[^>]*>/gi, '')
  s = s.replace(/<\/?analysis\b[^>]*>/gi, '')
  return s.trim()
}

function isResponsesApiPath (path) {
  const p = String(path || '').toLowerCase()
  return p.includes('/responses')
}

function extractAssistantText (message, options = {}) {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''

  const allowReasoning = options?.allowReasoning !== false

  const isReasoningType = (typeRaw) => {
    const t = String(typeRaw || '').toLowerCase()
    if (!t) return false
    // Provider-specific/compat variants:
    // - OpenAI: reasoning_content (stream delta), reasoning (responses)
    // - DeepSeek-R1: reasoning/thinking
    // - Some adapters: analysis
    return t.includes('reasoning') || t.includes('thinking') || t === 'analysis'
  }

  const extractFromValue = (value, depth = 0) => {
    if (typeof value === 'string') return value.trim()
    if (!value || typeof value !== 'object') return ''
    if (depth > 2) return ''
    if (Array.isArray(value)) {
      const parts = []
      for (const item of value) {
        if (!allowReasoning && item && typeof item === 'object' && isReasoningType(item.type)) continue
        const text = extractFromValue(item, depth + 1)
        if (text) parts.push(text)
      }
      const joined = parts.join('').trim()
      return joined
    }
    if (!allowReasoning && isReasoningType(value.type)) return ''
    const direct = value.text ?? value.content ?? value.value
    if (typeof direct === 'string') return direct.trim()
    if (direct && typeof direct === 'object') {
      const nested = extractFromValue(direct, depth + 1)
      if (nested) return nested
    }
    return ''
  }

  const contentText = extractFromValue(message.content)
  if (contentText) return allowReasoning ? contentText : stripReasoningText(contentText)

  // Prefer normal answer fields over model "thinking"/"reasoning" fields.
  const alt = extractFromValue(message.text ?? message.output_text ?? message.completion ?? message.result ?? message.answer ?? message.output)
  if (alt) return allowReasoning ? alt : stripReasoningText(alt)

  if (allowReasoning) {
    const reasoning = extractFromValue(message.reasoning_content ?? message.reasoning ?? message.thinking)
    if (reasoning) return reasoning
  }

  return ''
}

function extractAssistantTextFromApiResponse (data, options = {}) {
  if (!data || typeof data !== 'object') return ''

  if (Array.isArray(data.choices)) {
    const choice0 = data.choices[0]
    const msg = choice0?.message ?? choice0 ?? data
    return extractAssistantText(msg, options)
  }

  // Responses API (OpenAI) shapes:
  // - { output_text: "..." }
  // - { output: [{ type: "message", content: [...] }, { type: "function_call", ... }] }
  const direct = typeof data.output_text === 'string' ? data.output_text.trim() : ''
  if (direct) return (options?.allowReasoning === false) ? stripReasoningText(direct) : direct

  const output = Array.isArray(data.output) ? data.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message' || item.content != null) {
      const text = extractAssistantText(item, options)
      if (text) return text
    }
    if (item.type === 'output_text' && typeof item.text === 'string') {
      const text = (options?.allowReasoning === false) ? stripReasoningText(item.text) : item.text.trim()
      if (text) return text
    }
  }

  return ''
}

function extractToolCallsFromApiResponse (data) {
  if (!data || typeof data !== 'object') return []

  if (Array.isArray(data.choices)) {
    const msg = data.choices?.[0]?.message
    if (Array.isArray(msg?.tool_calls)) return msg.tool_calls.filter(Boolean)
    if (msg?.function_call) return [{ id: msg.id || 'fn-0', function: msg.function_call }]
    return []
  }

  const output = Array.isArray(data.output) ? data.output : []
  const calls = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    if (item.type !== 'function_call') continue
    const name = String(item.name || '').trim()
    if (!name) continue
    const args = item.arguments
    const argsStr = typeof args === 'string' ? args : (args && typeof args === 'object' ? JSON.stringify(args) : '')
    calls.push({
      id: item.call_id || item.id || `call_${calls.length}`,
      function: { name, arguments: argsStr }
    })
  }
  return calls
}

function parseInlineJsonObjectAt (raw, start) {
  if (raw[start] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const jsonText = raw.slice(start, i + 1)
        try {
          const args = JSON.parse(jsonText)
          if (!args || typeof args !== 'object' || Array.isArray(args)) return null
          return { args, end: i + 1 }
        } catch {
          return null
        }
      }
      if (depth < 0) return null
    }
  }
  return null
}

function isIgnorableInlineToolTail (tail) {
  const trimmed = String(tail || '').trim()
  if (!trimmed) return true
  return /^[\]}),，。！？!?.、；;：:\s]+$/.test(trimmed)
}

function isInlinePauseArgs (args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const keys = Object.keys(args)
  if (!keys.length) return false
  if (!keys.every(key => ['kind', 'pauseMs', 'ms', 'delayMs'].includes(key))) return false
  if (args.kind != null && String(args.kind) !== 'pause') return false
  return args.pauseMs != null || args.ms != null || args.delayMs != null
}

function parseInlineToolNameAt (raw, offset) {
  const m = String(raw || '').slice(offset).match(/^([A-Za-z_][A-Za-z0-9_]*)/)
  return m ? m[1] : ''
}

function extractInlineToolCallsFromText (text, toolNames) {
  const raw = String(text || '').trim()
  if (!raw) return []
  const names = Array.isArray(toolNames)
    ? toolNames.map(name => String(name || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length)
    : []
  if (!names.length) return []
  const calls = []
  let offset = 0
  while (offset < raw.length) {
    while (offset < raw.length && /\s/.test(raw[offset])) offset += 1
    if (offset >= raw.length) break
    if (raw[offset] === '{') {
      const parsed = parseInlineJsonObjectAt(raw, offset)
      if (!parsed || !isInlinePauseArgs(parsed.args)) return []
      calls.push({
        function: {
          name: 'say',
          arguments: JSON.stringify({ steps: [{ kind: 'pause', pauseMs: parsed.args.pauseMs ?? parsed.args.ms ?? parsed.args.delayMs }] })
        }
      })
      offset = parsed.end
      const tail = raw.slice(offset)
      if (tail && isIgnorableInlineToolTail(tail)) break
      continue
    }
    const name = names.find(name => raw.startsWith(name, offset))
    if (!name) {
      const unknownName = parseInlineToolNameAt(raw, offset)
      if (!unknownName || !calls.length) return []
      let unknownArgsOffset = offset + unknownName.length
      while (unknownArgsOffset < raw.length && /\s/.test(raw[unknownArgsOffset])) unknownArgsOffset += 1
      if (raw[unknownArgsOffset] !== '{') return []
      const unknownParsed = parseInlineJsonObjectAt(raw, unknownArgsOffset)
      if (!unknownParsed) return []
      offset = unknownParsed.end
      const tail = raw.slice(offset)
      if (tail && isIgnorableInlineToolTail(tail)) break
      continue
    }
    let argsOffset = offset + name.length
    while (argsOffset < raw.length && /\s/.test(raw[argsOffset])) argsOffset += 1
    if (raw[argsOffset] !== '{') return []
    const parsed = parseInlineJsonObjectAt(raw, argsOffset)
    if (!parsed) return []
    calls.push({
      function: {
        name,
        arguments: JSON.stringify(parsed.args)
      }
    })
    offset = parsed.end
    const tail = raw.slice(offset)
    if (tail && isIgnorableInlineToolTail(tail)) break
  }
  return calls
}

function extractInlineToolCallFromText (text, toolNames) {
  const calls = extractInlineToolCallsFromText(text, toolNames)
  return calls.length === 1 ? calls[0] : null
}

function extractUsageFromApiResponse (data) {
  const usage = (data && typeof data === 'object') ? (data.usage || {}) : {}
  const inTok = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens
    : (Number.isFinite(usage.input_tokens) ? usage.input_tokens : null)
  const outTok = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens
    : (Number.isFinite(usage.output_tokens) ? usage.output_tokens : null)
  return { inTok, outTok }
}

function buildAiUrl ({ baseUrl, path, defaultBase, defaultPath }) {
  const baseRaw = String(baseUrl || defaultBase || '').trim()
  const pathRaw = String(path || defaultPath || '').trim()
  const base = baseRaw.replace(/\/+$/, '')
  let finalPath = pathRaw ? (pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`) : ''

  const baseVersion = base.match(/\/(v\d+)$/i)?.[1]?.toLowerCase()
  const pathVersion = finalPath.match(/^\/(v\d+)(\/|$)/i)?.[1]?.toLowerCase()
  if (baseVersion && pathVersion && baseVersion === pathVersion) {
    finalPath = finalPath.replace(new RegExp(`^/${pathVersion}(?=/|$)`, 'i'), '')
    if (!finalPath) finalPath = '/'
  }

  return base + finalPath
}

module.exports = {
  estTokensFromText,
  trimReply,
  buildContextPrompt,
  selectContextProfile,
  classifyIntent,
  stripInternalMessageFields,
  fitMessagesToTokenBudget,
  projectedCostForCall,
  canAfford,
  stripReasoningText,
  isResponsesApiPath,
  extractAssistantText,
  extractAssistantTextFromApiResponse,
  extractToolCallsFromApiResponse,
  extractInlineToolCallsFromText,
  extractInlineToolCallFromText,
  extractUsageFromApiResponse,
  buildAiUrl
}
