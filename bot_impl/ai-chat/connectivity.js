const H = require('../ai-chat-helpers')

function normalizePositiveInt (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function schemaForPath (apiPath) {
  return typeof H.isResponsesApiPath === 'function' && H.isResponsesApiPath(apiPath) ? 'responses' : 'chat'
}

function buildConnectivityBody ({ model, apiPath, prompt, maxOutputTokens }) {
  const schema = schemaForPath(apiPath)
  const messages = [{ role: 'user', content: String(prompt || 'ping? reply OK only.') }]
  const maxOut = normalizePositiveInt(maxOutputTokens, 12, 1, 512)
  if (schema === 'responses') {
    return {
      schema,
      body: {
        model,
        input: messages,
        max_output_tokens: maxOut
      }
    }
  }
  return {
    schema,
    body: {
      model,
      messages,
      temperature: 0,
      max_tokens: maxOut,
      stream: false
    }
  }
}

function sanitizeErrorBody (text, maxLen = 400) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .slice(0, maxLen)
}

function responseShape (data) {
  if (!data || typeof data !== 'object') return { type: typeof data }
  return {
    keys: Object.keys(data).sort(),
    status: typeof data.status === 'string' ? data.status : null,
    incompleteDetails: data.incomplete_details && typeof data.incomplete_details === 'object' ? data.incomplete_details : null,
    error: data.error && typeof data.error === 'object'
      ? {
          type: data.error.type || null,
          code: data.error.code || null,
          message: data.error.message ? sanitizeErrorBody(data.error.message, 200) : null
        }
      : null,
    textKeys: data.text && typeof data.text === 'object' ? Object.keys(data.text).sort() : null,
    choices: Array.isArray(data.choices) ? data.choices.length : null,
    output: Array.isArray(data.output) ? data.output.map(item => ({
      type: String(item?.type || ''),
      keys: item && typeof item === 'object' ? Object.keys(item).sort() : [],
      status: typeof item?.status === 'string' ? item.status : null,
      contentType: Array.isArray(item?.content) ? 'array' : typeof item?.content
    })).slice(0, 5) : null,
    hasOutputText: typeof data.output_text === 'string'
  }
}

async function checkAiConnectivity ({ ai, defaults = {}, prompt, timeoutMs, maxOutputTokens, fetchImpl = global.fetch, now = () => Date.now() } = {}) {
  const key = String(ai?.key || '').trim()
  const baseUrl = ai?.baseUrl || defaults.DEFAULT_BASE
  const apiPath = ai?.pathOverride || ai?.path || defaults.DEFAULT_PATH
  const model = ai?.model || defaults.DEFAULT_MODEL
  if (!key) return { ok: false, error: 'AI key not configured', config: { hasKey: false } }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable', config: { hasKey: true } }

  const url = H.buildAiUrl({ baseUrl, path: apiPath, defaultBase: defaults.DEFAULT_BASE, defaultPath: defaults.DEFAULT_PATH })
  const { schema, body } = buildConnectivityBody({
    model,
    apiPath,
    prompt,
    maxOutputTokens: normalizePositiveInt(maxOutputTokens, 64, 1, 256)
  })
  const timeout = normalizePositiveInt(timeoutMs ?? ai?.timeoutMs, 12000, 1000, 60000)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeout}ms`)), timeout)
  const startedAt = now()
  const config = {
    baseUrl: String(baseUrl || ''),
    path: String(apiPath || ''),
    urlPath: (() => {
      try { return new URL(url).pathname || '' } catch { return String(url || '').replace(/[?#].*$/, '') }
    })(),
    model: String(model || ''),
    schema,
    bodyKeys: Object.keys(body).sort(),
    requestedMaxOutputTokens: body.max_output_tokens || body.max_tokens || null,
    hasKey: true
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    const durationMs = Math.max(0, now() - startedAt)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        status: res.status || null,
        durationMs,
        config,
        error: `HTTP ${res.status || 'unknown'}`,
        errorBody: sanitizeErrorBody(text)
      }
    }
    const data = await res.json()
    const reply = typeof H.extractAssistantTextFromApiResponse === 'function'
      ? H.extractAssistantTextFromApiResponse(data, { allowReasoning: false })
      : H.extractAssistantText(data?.choices?.[0]?.message || {}, { allowReasoning: false })
    const usage = typeof H.extractUsageFromApiResponse === 'function'
      ? H.extractUsageFromApiResponse(data)
      : { inTok: null, outTok: null }
    const text = String(reply || '').trim()
    if (!text) {
      return {
        ok: false,
        status: res.status || 200,
        durationMs,
        config,
        error: 'empty_assistant_text',
        responseShape: responseShape(data),
        usage
      }
    }
    return {
      ok: true,
      status: res.status || 200,
      durationMs,
      config,
      reply: text.slice(0, 120),
      usage
    }
  } catch (err) {
    const durationMs = Math.max(0, now() - startedAt)
    return {
      ok: false,
      durationMs,
      config,
      error: String(err?.message || err)
    }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  buildConnectivityBody,
  responseShape,
  checkAiConnectivity
}
