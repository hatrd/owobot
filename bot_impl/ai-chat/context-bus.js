const GAP_THRESHOLD_MS = 5 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 200
const STACK_WINDOW_MS = 5000
const EVENT_DATA_MAX = 100

function createContextBus ({ state, now = () => Date.now() }) {
  function ensureStore () {
    if (!Array.isArray(state.aiContextBus)) state.aiContextBus = []
    return state.aiContextBus
  }

  function ensureSeq () {
    if (!Number.isFinite(state.aiContextSeq)) state.aiContextSeq = 0
    return state.aiContextSeq
  }

  function push (type, payload) {
    const store = ensureStore()
    state.aiContextSeq = ensureSeq() + 1
    const entry = {
      t: now(),
      seq: state.aiContextSeq,
      type,
      payload
    }
    store.push(entry)
    enforceLimit()
    return entry
  }

  function enforceLimit () {
    const store = ensureStore()
    const rawMax = state.ai?.context?.busMax
    const parsed = Number(rawMax)
    const max = Number.isFinite(parsed)
      ? Math.max(1, Math.min(5000, Math.floor(parsed)))
      : DEFAULT_MAX_ENTRIES
    if (store.length > max) {
      store.splice(0, store.length - max)
    }
  }

  function pushPlayer (name, content) {
    return push('player', { name, content: String(content || '').slice(0, 200) })
  }

  function pushServer (content) {
    return push('server', { content: String(content || '').slice(0, 200) })
  }

  function pushBot (content) {
    return push('bot', { content: String(content || '').slice(0, 200) })
  }

  function pushBotFrom (content, from) {
    const f = String(from || '').trim()
    return push('bot', {
      content: String(content || '').slice(0, 200),
      from: f ? f.slice(0, 32) : null
    })
  }

  function pushTool (content) {
    return push('tool', { content: String(content || '').slice(0, 200) })
  }

  function parseStackKey (eventType, data) {
    const str = String(data ?? '').slice(0, EVENT_DATA_MAX)
    const m = str.match(/^(.+?)(?:x(\d+))?$/)
    if (!m) return { base: str, count: 1 }
    const base = m[1]
    const n = m[2] ? Number(m[2]) : 1
    return { base, count: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1 }
  }

  function formatStackData (base, count) {
    const n = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1
    const suffix = n > 1 ? `x${n}` : ''
    const maxBaseLen = EVENT_DATA_MAX - suffix.length
    const b = String(base ?? '').slice(0, Math.max(0, maxBaseLen))
    return `${b}${suffix}`
  }

  function tryStackEvent (eventType, data) {
    const store = ensureStore()
    if (!store.length) return null
    const last = store[store.length - 1]
    if (!last || last.type !== 'event' || !last.payload) return null
    const nowTs = now()
    if (!Number.isFinite(last.t) || (nowTs - last.t) > STACK_WINDOW_MS) return null
    if (String(last.payload.eventType || '') !== String(eventType || '')) return null
    const prev = parseStackKey(eventType, last.payload.data)
    const next = parseStackKey(eventType, data)
    if (prev.base !== next.base) return null
    const merged = prev.count + next.count
    last.payload.data = formatStackData(prev.base, merged)
    last.t = nowTs
    return last
  }

  function pushEvent (eventType, data) {
    const stacked = tryStackEvent(eventType, data)
    if (stacked) return stacked
    return push('event', { eventType, data: String(data ?? '').slice(0, EVENT_DATA_MAX) })
  }

  function escapeXml (value) {
    const str = String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g, '')
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  function formatDuration (ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0m'
    const minutes = Math.floor(ms / 60000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remainMin = minutes % 60
    if (hours < 24) {
      return remainMin > 0 ? `${hours}h${remainMin}m` : `${hours}h`
    }
    const days = Math.floor(hours / 24)
    return `${days}d`
  }

  function serializeEntry (entry) {
    const type = entry?.type
    const payload = entry?.payload || {}
    switch (type) {
      case 'player':
        return `<p n="${escapeXml(payload.name)}">${escapeXml(payload.content)}</p>`
      case 'server':
        return `<s>${escapeXml(payload.content)}</s>`
      case 'bot':
        return payload.from
          ? `<b f="${escapeXml(payload.from)}">${escapeXml(payload.content)}</b>`
          : `<b>${escapeXml(payload.content)}</b>`
      case 'tool':
        return `<t>${escapeXml(payload.content)}</t>`
      case 'event':
        return `<e t="${escapeXml(payload.eventType)}" d="${escapeXml(payload.data)}"/>`
      default:
        return ''
    }
  }

  function buildXml (options = {}) {
    const store = ensureStore()
    if (!store.length) return ''

    const maxEntries = Number.isFinite(Number(options.maxEntries))
      ? Math.max(1, Math.floor(Number(options.maxEntries)))
      : 50
    const gapThreshold = Number.isFinite(Number(options.gapThresholdMs))
      ? Math.max(0, Math.floor(Number(options.gapThresholdMs)))
      : GAP_THRESHOLD_MS
    const includeGaps = options.includeGaps !== false

    const nowTs = now()
    const windowSec = Number.isFinite(Number(options.windowSec))
      ? Math.max(0, Math.floor(Number(options.windowSec)))
      : 600
    const cutoff = nowTs - windowSec * 1000

    const filtered = []
    for (let i = store.length - 1; i >= 0; i--) {
      const e = store[i]
      if (!e || !Number.isFinite(e.t)) continue
      if (e.t < cutoff) break
      filtered.push(e)
      if (filtered.length >= maxEntries) break
    }
    if (!filtered.length) return ''
    filtered.reverse()

    const lines = [
      '<ctx>',
      '<!-- p=player s=server e=event b=bot t=tool g=gap -->'
    ]

    let prevTs = null
    for (const entry of filtered) {
      if (includeGaps && prevTs !== null) {
        const gap = entry.t - prevTs
        if (gap >= gapThreshold) {
          lines.push(`<g d="${formatDuration(gap)}"/>`)
        }
      }
      const xml = serializeEntry(entry)
      if (xml) lines.push(xml)
      prevTs = entry.t
    }

    lines.push('</ctx>')
    return lines.join('\n')
  }

  function getStore () {
    return ensureStore()
  }

  function clear () {
    state.aiContextBus = []
    state.aiContextSeq = 0
  }

  return {
    push,
    pushPlayer,
    pushServer,
    pushBot,
    pushBotFrom,
    pushTool,
    pushEvent,
    buildXml,
    getStore,
    clear,
    escapeXml,
    formatDuration
  }
}

module.exports = { createContextBus }
