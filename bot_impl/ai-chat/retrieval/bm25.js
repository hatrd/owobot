function normalizeText (input) {
  return String(input || '').toLowerCase().replace(/\s+/g, '')
}

function resolveNGrams (opts = {}) {
  const list = Array.isArray(opts.nGrams) ? opts.nGrams
    : (Number.isFinite(Number(opts.nGram)) ? [Number(opts.nGram)] : null)
  const cleaned = (list || [2]).map(n => Math.max(1, Math.floor(Number(n) || 0)))
  const uniq = Array.from(new Set(cleaned)).filter(n => n > 0)
  return uniq.length ? uniq : [2]
}

function buildNgrams (text, n) {
  const out = []
  const size = Math.max(1, Math.floor(Number(n) || 0))
  if (!text || text.length < size) return out
  for (let i = 0; i <= text.length - size; i++) {
    out.push(text.slice(i, i + size))
  }
  return out
}

function buildIndex (docs, opts = {}) {
  const items = Array.isArray(docs) ? docs : []
  const nGrams = resolveNGrams(opts)
  const normalized = []
  const df = new Map()
  let totalLen = 0

  for (let i = 0; i < items.length; i++) {
    const raw = items[i]
    const text = typeof raw === 'string' ? raw : String(raw?.text || '')
    if (!text.trim()) continue
    const id = raw && raw.id != null ? raw.id : String(i)
    const meta = raw && raw.meta != null ? raw.meta : null
    const norm = normalizeText(text)
    const tokens = []
    for (const n of nGrams) tokens.push(...buildNgrams(norm, n))
    if (!tokens.length) continue
    const tf = new Map()
    for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1)
    const unique = new Set(tf.keys())
    for (const tok of unique) df.set(tok, (df.get(tok) || 0) + 1)
    const docLen = tokens.length
    totalLen += docLen
    normalized.push({ id, text, meta, tf, len: docLen })
  }

  const avgDocLen = normalized.length ? (totalLen / normalized.length) : 0
  const N = normalized.length
  const idf = new Map()
  for (const [tok, freq] of df.entries()) {
    const val = Math.log(1 + (N - freq + 0.5) / (freq + 0.5))
    idf.set(tok, val)
  }

  return {
    docs: normalized,
    df,
    idf,
    avgDocLen,
    nGrams,
    opts: { ...opts, nGrams }
  }
}

function query (index, text, topK = 5, minScore = 0) {
  if (!index || !Array.isArray(index.docs)) return []
  const q = normalizeText(text)
  if (!q) return []
  const nGrams = Array.isArray(index.nGrams) ? index.nGrams : resolveNGrams(index.opts)
  const qTokens = []
  for (const n of nGrams) qTokens.push(...buildNgrams(q, n))
  if (!qTokens.length) return []

  const qTf = new Map()
  for (const tok of qTokens) qTf.set(tok, (qTf.get(tok) || 0) + 1)

  const k1 = Number.isFinite(Number(index.opts?.k1)) ? Number(index.opts.k1) : 1.2
  const b = Number.isFinite(Number(index.opts?.b)) ? Number(index.opts.b) : 0.75
  const avgDocLen = Number.isFinite(index.avgDocLen) && index.avgDocLen > 0 ? index.avgDocLen : 1
  const limit = Math.max(1, Math.floor(Number(topK) || 5))
  const min = Number.isFinite(Number(minScore)) ? Number(minScore) : 0
  const results = []

  for (const doc of index.docs) {
    let score = 0
    for (const [tok] of qTf) {
      const tf = doc.tf.get(tok) || 0
      if (!tf) continue
      const idf = index.idf.get(tok) || 0
      const denom = tf + k1 * (1 - b + b * (doc.len / avgDocLen))
      score += idf * ((tf * (k1 + 1)) / denom)
    }
    if (score >= min) results.push({ id: doc.id, text: doc.text, meta: doc.meta, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

function selfTest () {
  const docs = [
    { id: 'd1', text: 'mine diamonds in a cave near spawn' },
    { id: 'd2', text: 'cook food and refill hunger' },
    { id: 'd3', text: 'build a wooden shelter before night' },
    { id: 'd4', text: 'trade with villagers for emeralds' },
    { id: 'd5', text: 'explore the nether fortress' },
    { id: 'd6', text: 'gather oak logs and craft planks' }
  ]
  const idx = buildIndex(docs, { nGram: 2 })
  const tests = [
    'diamond ore',
    'food hunger',
    'nether fortress',
    'craft planks'
  ]
  return tests.map(queryText => ({
    query: queryText,
    results: query(idx, queryText, 3, 0).map(r => r.id)
  }))
}

if (require.main === module) {
  const res = selfTest()
  console.log(JSON.stringify(res, null, 2))
}

module.exports = {
  buildIndex,
  query,
  selfTest
}
