const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DEFAULT_POOL_FILE = path.join(DATA_DIR, 'requirements-pool.txt')

function normalizeNeed (need) {
  if (typeof need !== 'string') return ''
  let out = ''
  try { out = need.normalize('NFKC') } catch { out = need }
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/[\r\n]+/g, ' ').trim()
  return out.slice(0, 200)
}

function normalizePublicMessage (text) {
  if (typeof text !== 'string') return ''
  let out = ''
  try { out = text.normalize('NFKC') } catch { out = text }
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/[\r\n]+/g, ' ').trim()
  return out.slice(0, 240)
}

function safeJson (value) {
  try { return JSON.stringify(value, null, 2) } catch { return 'null' }
}

function formatIso (t) {
  try {
    const d = new Date(Number(t) || 0)
    if (Number.isNaN(d.getTime())) return ''
    return d.toISOString()
  } catch { return '' }
}

function formatContextBusEntry (entry) {
  if (!entry || typeof entry !== 'object') return ''
  const ts = formatIso(entry.t)
  const prefix = ts ? `[${ts}]` : '[time?]'
  const type = String(entry.type || '').trim()
  const p = entry.payload || {}
  if (type === 'player') return `${prefix} <${String(p.name || '?')}> ${String(p.content || '')}`
  if (type === 'bot') return `${prefix} <bot${p.from ? `:${String(p.from)}` : ''}> ${String(p.content || '')}`
  if (type === 'server') return `${prefix} <server> ${String(p.content || '')}`
  if (type === 'tool') return `${prefix} <tool> ${String(p.content || '')}`
  if (type === 'event') return `${prefix} <event:${String(p.event || '?')}> ${String(p.data || '')}`
  return `${prefix} <${type || 'unknown'}> ${safeJson(p)}`
}

function collectContext ({ contextBus, state, username, userMessage, capturedAt }) {
  const store = (() => {
    if (contextBus && typeof contextBus.getStore === 'function') return contextBus.getStore()
    if (Array.isArray(state?.aiContextBus)) return state.aiContextBus
    return []
  })()
  const lines = Array.isArray(store) ? store.map(formatContextBusEntry).filter(Boolean) : []
  const header = [
    `捕获时间: ${formatIso(capturedAt) || String(capturedAt || '')}`,
    username ? `玩家: ${username}` : null,
    userMessage ? `触发消息: ${String(userMessage).replace(/\s+/g, ' ').trim().slice(0, 400)}` : null
  ].filter(Boolean).join('\n')
  const transcript = lines.length ? lines.join('\n') : '(empty)'
  const raw = safeJson(store)
  return [header, '', '--- 原始对话（context bus transcript）---', transcript, '', '--- 原始数据（context bus JSON）---', raw].join('\n')
}

function buildDocument ({ need, publicMessage, contextText }) {
  return [
    `标题：${need}`,
    publicMessage ? `对外说明：${publicMessage}` : null,
    '上下文：',
    contextText
  ].filter(Boolean).join('\n')
}

function appendFeedback ({
  need,
  publicMessage,
  username,
  userMessage,
  contextBus,
  state,
  now = () => Date.now(),
  filePath
} = {}) {
  const normalized = normalizeNeed(String(need || ''))
  if (!normalized) return { ok: false, reason: 'empty_need' }
  const normalizedPublicMessage = normalizePublicMessage(publicMessage)

  const capturedAt = now()
  const contextText = collectContext({ contextBus, state, username, userMessage, capturedAt })
  const doc = buildDocument({ need: normalized, publicMessage: normalizedPublicMessage, contextText })

  const target = filePath || DEFAULT_POOL_FILE
  try { fs.mkdirSync(path.dirname(target), { recursive: true }) } catch {}
  try {
    fs.appendFileSync(target, `\n\n===== feedback @ ${formatIso(capturedAt) || capturedAt} =====\n${doc}\n`)
    return { ok: true, filePath: target, capturedAt }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  }
}

module.exports = {
  appendFeedback,
  normalizeNeed,
  normalizePublicMessage,
  collectContext,
  buildDocument
}
