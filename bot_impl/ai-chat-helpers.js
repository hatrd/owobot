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
  const cutoff = now - (Math.max(10, (ctx.recentWindowSec || DEFAULT_RECENT_WINDOW_SEC)) * 1000)
  const lines = (Array.isArray(recent) ? recent : [])
  const recentKept = lines
    .filter(r => (r?.t ?? cutoff) >= cutoff)
    .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
    .slice(-(ctx.recentCount || DEFAULT_RECENT_COUNT))
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
  projectedCostForCall,
  canAfford,
  stripReasoningText,
  isResponsesApiPath,
  extractAssistantText,
  extractAssistantTextFromApiResponse,
  extractToolCallsFromApiResponse,
  extractUsageFromApiResponse,
  buildAiUrl
}
