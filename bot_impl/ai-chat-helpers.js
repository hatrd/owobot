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

function buildContextPrompt (username, recent, recentOwk, options = {}) {
  const ctx = Object.assign({ include: true, recentCount: 8, recentWindowSec: 300, includeOwk: true, owkWindowSec: 900, owkMax: 5 }, options)
  if (!ctx.include) return ''
  const now = Date.now()
  const cutoff = now - (Math.max(10, (ctx.recentWindowSec || 300)) * 1000)
  const lines = (Array.isArray(recent) ? recent : [])
  const isOwk = (txt) => /\bowk\b/i.test(String(txt || ''))
  const recentKept = lines
    .filter(r => (r?.t ?? cutoff) >= cutoff)
    .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
    .slice(-(ctx.recentCount || 0))
  let owkKept = []
  if (ctx.includeOwk) {
    const source = Array.isArray(recentOwk) ? recentOwk : (Array.isArray(recent) ? recent : [])
    const owkCut = now - (Math.max(10, (ctx.owkWindowSec || 900)) * 1000)
    owkKept = source
      .filter(r => (r?.t ?? owkCut) >= owkCut && isOwk(r.text))
      .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))
    if (ctx.owkMax != null) owkKept = owkKept.slice(-ctx.owkMax)
  }
  const chatLines = recentKept.map(r => `${r.user}: ${String(r.text || '').trim()}`).join(' | ')
  const owkLines = owkKept.map(r => `${r.user}: ${String(r.text || '').trim()}`).join(' | ')
  const parts = [
    `环境: 我们在Minecraft服务器中, 玩家会随意聊天或询问与MC相关的问题; 你的回答要极其简短.`,
    `当前对话玩家: ${username}.`,
    `最近聊天: ${chatLines || '无'}.`,
    ctx.includeOwk ? `含 owk 的历史: ${owkLines || '无'}.` : ''
  ].filter(Boolean)
  return parts.join(' ')
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
