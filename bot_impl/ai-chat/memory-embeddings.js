const fs = require('fs')
const path = require('path')
const H = require('../ai-chat-helpers')

const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g
const ASCII_WORD_RE = /[a-z0-9_]{2,}/g

function normalizeText (text) {
  if (typeof text !== 'string') return ''
  try { return text.normalize('NFKC').replace(/\s+/g, ' ').trim() } catch { return text.replace(/\s+/g, ' ').trim() }
}

function tokenizeForHashEmbedding (text) {
  const s = normalizeText(text).toLowerCase()
  if (!s) return []
  const out = []
  const seen = new Set()
  const MAX = 96

  function push (raw) {
    if (out.length >= MAX) return
    const t = normalizeText(raw).toLowerCase()
    if (!t || t.length < 2) return
    if (seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  const cjkRuns = s.match(CJK_RUN_RE) || []
  for (const run of cjkRuns) {
    if (out.length >= MAX) break
    if (run.length <= 6) push(run)
    if (run.length >= 3) {
      for (let i = 0; i <= run.length - 3 && out.length < MAX; i++) push(run.slice(i, i + 3))
    }
    for (let i = 0; i <= run.length - 2 && out.length < MAX; i++) push(run.slice(i, i + 2))
  }

  const asciiWords = s.match(ASCII_WORD_RE) || []
  for (const word of asciiWords) {
    if (out.length >= MAX) break
    push(word)
  }

  if (!out.length) {
    const parts = s.split(/[\s,，。.!！?？;；:："“”‘’"'()[\]{}<>]/g).map(t => t.trim()).filter(Boolean)
    for (const part of parts) {
      if (out.length >= MAX) break
      push(part)
    }
  }

  return out
}

function fnv1a32 (text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function l2Norm (vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]
    sum += v * v
  }
  return Math.sqrt(sum)
}

function cosineSimilarity (a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const va = a[i]
    const vb = b[i]
    dot += va * vb
    na += va * va
    nb += vb * vb
  }
  if (na <= 0 || nb <= 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function hashEmbedding (text, dim = 64) {
  const d = Number(dim)
  const size = Number.isFinite(d) && d > 8 ? Math.floor(d) : 64
  const tokens = tokenizeForHashEmbedding(text)
  if (!tokens.length) return null
  const vec = new Float32Array(size)
  for (const tok of tokens) {
    const h = fnv1a32(tok)
    const idx = h % size
    const sign = (h & 1) ? 1 : -1
    vec[idx] += sign * 1
  }
  const n = l2Norm(vec)
  if (!Number.isFinite(n) || n <= 0) return null
  for (let i = 0; i < vec.length; i++) vec[i] /= n
  return vec
}

function resolveEmbeddingConfig ({ cfg, state, defaults }) {
  const providerRaw = normalizeText(cfg?.embeddingProvider || process.env.AI_EMBEDDING_PROVIDER || '').toLowerCase()
  const provider = providerRaw || ''
  const dimRaw = Number(cfg?.embeddingDim || process.env.AI_EMBEDDING_DIM)
  const dim = Number.isFinite(dimRaw) && dimRaw > 8 ? Math.floor(dimRaw) : 64

  if (!provider) return { enabled: false, provider: '', dim }
  if (provider === 'hash') return { enabled: true, provider: 'hash', dim }

  const key = normalizeText(process.env.AI_EMBEDDING_KEY || state?.ai?.key || '')
  const model = normalizeText(process.env.AI_EMBEDDING_MODEL || '')
  const baseUrl = normalizeText(process.env.AI_EMBEDDING_BASE_URL || state?.ai?.baseUrl || defaults?.DEFAULT_BASE || '')
  const apiPath = normalizeText(process.env.AI_EMBEDDING_PATH || '/v1/embeddings') || '/v1/embeddings'

  if (!key || !model || !baseUrl) return { enabled: false, provider, dim, key: key || null, model: model || null, baseUrl: baseUrl || null, path: apiPath }
  return { enabled: true, provider, dim, key, model, baseUrl, path: apiPath }
}

function defaultStorePath () {
  return path.join(process.cwd(), 'data', 'ai-memory-embeddings.json')
}

function loadStore (filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw) return { version: 1, meta: {}, vectors: {} }
    const parsed = JSON.parse(raw)
    const vectors = parsed && typeof parsed.vectors === 'object' ? parsed.vectors : {}
    return { version: Number(parsed?.version) || 1, meta: parsed?.meta || {}, vectors }
  } catch {
    return { version: 1, meta: {}, vectors: {} }
  }
}

function saveStore (filePath, store) {
  const dir = path.dirname(filePath)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const payload = {
    version: 1,
    meta: store?.meta || {},
    vectors: store?.vectors || {},
    savedAt: Date.now()
  }
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload))
  fs.renameSync(tmp, filePath)
}

async function embedOpenAICompatible ({ text, key, baseUrl, apiPath, model, timeoutMs = 15000 }) {
  const input = normalizeText(text)
  if (!input) return null
  if (!key || !baseUrl || !apiPath || !model) return null
  const url = H.buildAiUrl({ baseUrl, path: apiPath, defaultBase: baseUrl, defaultPath: apiPath })
  const body = { model, input }
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort('timeout'), Math.max(1000, Math.floor(timeoutMs)))
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    const emb = data?.data?.[0]?.embedding
    if (!Array.isArray(emb) || !emb.length) return null
    return new Float32Array(emb.map(n => Number(n) || 0))
  } catch {
    return null
  } finally {
    try { clearTimeout(timeout) } catch {}
  }
}

function createMemoryEmbeddings ({ state, defaults, log }) {
  const ctrl = { store: null, storePath: defaultStorePath(), running: false, queue: [] }

  function debug (...args) {
    if (log?.debug) log.debug('[memory-embeddings]', ...args)
  }

  function getStore () {
    if (!ctrl.store) ctrl.store = loadStore(ctrl.storePath)
    return ctrl.store
  }

  function getStoredVector (id, updatedAt) {
    const store = getStore()
    const rec = store?.vectors?.[id]
    if (!rec || typeof rec !== 'object') return null
    if (Number.isFinite(updatedAt) && Number(rec.updatedAt) !== Number(updatedAt)) return null
    const v = rec.v
    if (!Array.isArray(v) || !v.length) return null
    return new Float32Array(v.map(n => Number(n) || 0))
  }

  function setStoredVector (id, updatedAt, vec, meta) {
    const store = getStore()
    if (!store.vectors || typeof store.vectors !== 'object') store.vectors = {}
    store.meta = meta || store.meta || {}
    store.vectors[id] = { updatedAt: Number(updatedAt) || null, v: Array.from(vec || []) }
    try { saveStore(ctrl.storePath, store) } catch (e) { debug('save error', e?.message || e) }
  }

  async function embedText (text, cfg) {
    const embCfg = resolveEmbeddingConfig({ cfg, state, defaults })
    if (!embCfg.enabled) return null
    if (embCfg.provider === 'hash') return hashEmbedding(text, embCfg.dim)
    return embedOpenAICompatible({
      text,
      key: embCfg.key,
      baseUrl: embCfg.baseUrl,
      apiPath: embCfg.path,
      model: embCfg.model,
      timeoutMs: Number(cfg?.embeddingTimeoutMs) || 15000
    })
  }

  function getEntryVector (entry, cfg) {
    const embCfg = resolveEmbeddingConfig({ cfg, state, defaults })
    if (!embCfg.enabled) return null
    const text = entry?.instruction || entry?.text || ''
    if (embCfg.provider === 'hash') return hashEmbedding(text, embCfg.dim)
    const id = String(entry?.id || '')
    if (!id) return null
    return getStoredVector(id, entry?.updatedAt || entry?.createdAt || null)
  }

  async function embedQuery (text, cfg) {
    return embedText(text, cfg)
  }

  function enqueueEntry (entry, cfg) {
    const embCfg = resolveEmbeddingConfig({ cfg, state, defaults })
    if (!embCfg.enabled || embCfg.provider === 'hash') return
    const id = String(entry?.id || '')
    const ts = Number(entry?.updatedAt || entry?.createdAt || 0) || null
    const text = String(entry?.instruction || entry?.text || '')
    if (!id || !text || !ts) return
    ctrl.queue.push({ id, ts, text, meta: { provider: embCfg.provider, model: embCfg.model, dim: embCfg.dim } })
    processQueue(cfg).catch(() => {})
  }

  async function processQueue (cfg) {
    if (ctrl.running) return
    ctrl.running = true
    try {
      while (ctrl.queue.length) {
        const job = ctrl.queue.shift()
        if (!job) continue
        const vec = await embedText(job.text, cfg)
        if (!vec) continue
        setStoredVector(job.id, job.ts, vec, job.meta)
      }
    } finally {
      ctrl.running = false
    }
  }

  return {
    resolveConfig: (cfg) => resolveEmbeddingConfig({ cfg, state, defaults }),
    cosineSimilarity,
    embedQuery,
    getEntryVector,
    enqueueEntry,
    storePath: ctrl.storePath
  }
}

module.exports = {
  tokenizeForHashEmbedding,
  hashEmbedding,
  cosineSimilarity,
  resolveEmbeddingConfig,
  loadStore,
  saveStore,
  embedOpenAICompatible,
  createMemoryEmbeddings
}

