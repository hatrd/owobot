const DEFAULT_RECENT_LIMIT = 80

function normalizeText (value) {
  return String(value == null ? '' : value).trim()
}

function parseBoolEnv (name, fallback = false) {
  const raw = process.env[name]
  if (raw == null) return fallback
  const v = String(raw).toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(v)) return true
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(v)) return false
  return fallback
}

function ensureAiCallMonitorState (state, now = () => Date.now()) {
  if (!state || typeof state !== 'object') return null
  if (!state.aiCallMonitor || typeof state.aiCallMonitor !== 'object') {
    state.aiCallMonitor = {}
  }
  const mon = state.aiCallMonitor
  if (!Array.isArray(mon.recent)) mon.recent = []
  if (!mon.counts || typeof mon.counts !== 'object') mon.counts = {}
  for (const key of ['started', 'ok', 'error', 'blocked']) {
    if (!Number.isFinite(mon.counts[key])) mon.counts[key] = 0
  }
  if (!mon.bySource || typeof mon.bySource !== 'object') mon.bySource = {}
  if (!Number.isFinite(mon.seq)) mon.seq = 0
  if (!Number.isFinite(mon.recentLimit) || mon.recentLimit <= 0) mon.recentLimit = DEFAULT_RECENT_LIMIT
  if (!Number.isFinite(mon.createdAt)) mon.createdAt = now()
  return mon
}

function createAiCallMonitor ({ state, log = null, now = () => Date.now() } = {}) {
  const monitorState = ensureAiCallMonitorState(state, now)

  function sourceAllowed (source, kind) {
    const ai = state?.ai || {}
    const cfg = ai.externalCalls || {}
    const normalized = normalizeText(source || kind || 'unknown')
    if (cfg.blockAll === true) return false
    if (cfg.allowBackground === true) return true
    if (normalized === 'main_chat') return true
    const allow = Array.isArray(cfg.allowSources) ? cfg.allowSources.map(normalizeText).filter(Boolean) : []
    return allow.includes(normalized)
  }

  function pushRecent (entry) {
    const mon = ensureAiCallMonitorState(state, now)
    if (!mon) return
    mon.recent.push(entry)
    const limit = Math.max(1, Math.floor(mon.recentLimit || DEFAULT_RECENT_LIMIT))
    if (mon.recent.length > limit) mon.recent.splice(0, mon.recent.length - limit)
  }

  function bumpSource (source, field) {
    const mon = ensureAiCallMonitorState(state, now)
    if (!mon) return
    const key = normalizeText(source || 'unknown') || 'unknown'
    if (!mon.bySource[key] || typeof mon.bySource[key] !== 'object') {
      mon.bySource[key] = { started: 0, ok: 0, error: 0, blocked: 0 }
    }
    mon.bySource[key][field] = (Number(mon.bySource[key][field]) || 0) + 1
  }

  async function request ({ source, kind = 'chat', model, url, body, headers, signal, timeoutMs, fetchImpl = global.fetch } = {}) {
    const mon = ensureAiCallMonitorState(state, now)
    const normalizedSource = normalizeText(source || 'unknown') || 'unknown'
    const normalizedKind = normalizeText(kind || 'chat') || 'chat'
    const normalizedModel = normalizeText(model || body?.model || '')
    if (!sourceAllowed(normalizedSource, normalizedKind)) {
      if (mon) {
        mon.seq += 1
        mon.counts.blocked += 1
        bumpSource(normalizedSource, 'blocked')
        pushRecent({
          id: mon.seq,
          t: now(),
          source: normalizedSource,
          kind: normalizedKind,
          model: normalizedModel,
          status: 'blocked',
          error: 'ai_call_blocked'
        })
      }
      throw new Error(`ai_call_blocked:${normalizedSource}`)
    }
    if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable')

    const id = mon ? (mon.seq += 1) : 0
    const startedAt = now()
    if (mon) {
      mon.counts.started += 1
      bumpSource(normalizedSource, 'started')
      pushRecent({ id, t: startedAt, source: normalizedSource, kind: normalizedKind, model: normalizedModel, status: 'start' })
    }

    const timeoutCtrl = (!signal && Number.isFinite(timeoutMs) && timeoutMs > 0) ? new AbortController() : null
    const timer = timeoutCtrl ? setTimeout(() => timeoutCtrl.abort('timeout'), Math.floor(timeoutMs)) : null
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: headers || {},
        body: typeof body === 'string' ? body : JSON.stringify(body || {}),
        signal: signal || timeoutCtrl?.signal
      })
      const endedAt = now()
      if (mon) {
        mon.counts.ok += res?.ok ? 1 : 0
        if (!res?.ok) mon.counts.error += 1
        bumpSource(normalizedSource, res?.ok ? 'ok' : 'error')
        pushRecent({
          id,
          t: endedAt,
          source: normalizedSource,
          kind: normalizedKind,
          model: normalizedModel,
          status: res?.ok ? 'ok' : 'http_error',
          httpStatus: res?.status || null,
          durationMs: endedAt - startedAt
        })
      }
      return res
    } catch (err) {
      const endedAt = now()
      if (mon) {
        mon.counts.error += 1
        bumpSource(normalizedSource, 'error')
        pushRecent({
          id,
          t: endedAt,
          source: normalizedSource,
          kind: normalizedKind,
          model: normalizedModel,
          status: 'error',
          error: normalizeText(err?.message || err).slice(0, 160),
          durationMs: endedAt - startedAt
        })
      }
      if (log?.warn) {
        try { log.warn('[AI] external call failed', normalizedSource, err?.message || err) } catch {}
      }
      throw err
    } finally {
      if (timer) {
        try { clearTimeout(timer) } catch {}
      }
    }
  }

  return {
    ensureState: () => ensureAiCallMonitorState(state, now),
    sourceAllowed,
    request,
    snapshot: () => {
      const mon = ensureAiCallMonitorState(state, now)
      return mon ? {
        counts: { ...mon.counts },
        bySource: { ...mon.bySource },
        recent: mon.recent.slice()
      } : { counts: {}, bySource: {}, recent: [] }
    }
  }
}

function buildDefaultExternalCallPolicy () {
  return {
    allowBackground: parseBoolEnv('AI_ALLOW_BACKGROUND_CALLS', false),
    allowSources: ['main_chat']
  }
}

module.exports = {
  createAiCallMonitor,
  ensureAiCallMonitorState,
  buildDefaultExternalCallPolicy
}
