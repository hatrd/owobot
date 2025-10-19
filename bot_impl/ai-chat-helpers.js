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

function buildContextPrompt (username, recent, recentTrig, options = {}) {
  const ctx = Object.assign({ include: true, recentCount: 8, recentWindowSec: 300 }, options)
  if (!ctx.include) return ''
  const now = Date.now()
  const cutoff = now - (Math.max(10, (ctx.recentWindowSec || 300)) * 1000)
  const lines = (Array.isArray(recent) ? recent : [])
  const recentKept = lines
    .filter(r => (r?.t ?? cutoff) >= cutoff)
    .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
    .slice(-(ctx.recentCount || 0))
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

module.exports = {
  estTokensFromText,
  trimReply,
  buildContextPrompt,
  projectedCostForCall,
  canAfford
}
