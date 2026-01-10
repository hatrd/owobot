#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const embeddings = require('../bot_impl/ai-chat/memory-embeddings')

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.replace(/^--+/, '')
    const next = argv[i + 1]
    const hasValue = next && !next.startsWith('--')
    if (hasValue) { out[key] = next; i++; continue }
    out[key] = true
  }
  return out
}

function parseBool (value, fallback = false) {
  if (value == null) return fallback
  if (value === true) return true
  const v = String(value).trim().toLowerCase()
  if (!v) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return fallback
}

function usage () {
  return [
    'Usage:',
    '  node scripts/memory-embeddings-backfill.js [--mem data/ai-memory.json] [--out data/ai-memory-embeddings.json]',
    '    [--provider hash|openai] [--dim 64] [--apply] [--dry-run] [--limit N]',
    '',
    'OpenAI-compatible config (provider=openai):',
    '  AI_EMBEDDING_KEY / AI_EMBEDDING_MODEL / AI_EMBEDDING_BASE_URL / AI_EMBEDDING_PATH',
    '',
    'Notes:',
    '  - Default is dry-run; use --apply to write changes.',
    '  - Writes a timestamped .bak copy of the output file before applying.',
    '',
    'Examples:',
    '  node scripts/memory-embeddings-backfill.js --provider hash --dim 64 --dry-run',
    '  AI_EMBEDDING_KEY=... AI_EMBEDDING_MODEL=... node scripts/memory-embeddings-backfill.js --provider openai --apply'
  ].join('\n')
}

function readJson (filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function backupFile (filePath) {
  if (!fs.existsSync(filePath)) return null
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const backup = path.join(dir, `${base}.bak.${Date.now()}`)
  fs.copyFileSync(filePath, backup)
  return backup
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    process.stdout.write(usage() + '\n')
    process.exitCode = 0
    return
  }

  const projectRoot = path.resolve(__dirname, '..')
  try { process.chdir(projectRoot) } catch {}

  const memPath = path.resolve(String(args.mem || args.memory || path.join(projectRoot, 'data', 'ai-memory.json')))
  const outPath = path.resolve(String(args.out || path.join(projectRoot, 'data', 'ai-memory-embeddings.json')))
  const apply = parseBool(args.apply, false)
  const dryRun = apply ? false : parseBool(args['dry-run'] ?? args.dryRun, true)
  const limitRaw = args.limit != null ? Number(args.limit) : null
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity

  const provider = String(args.provider || process.env.AI_EMBEDDING_PROVIDER || '').toLowerCase() || 'openai'
  const dimRaw = Number(args.dim || process.env.AI_EMBEDDING_DIM)
  const dim = Number.isFinite(dimRaw) && dimRaw > 8 ? Math.floor(dimRaw) : 64

  const mem = readJson(memPath)
  if (!mem || typeof mem !== 'object') {
    process.stderr.write(`failed to read: ${memPath}\n`)
    process.exitCode = 2
    return
  }
  const memories = Array.isArray(mem.memories) ? mem.memories : []

  const store = embeddings.loadStore(outPath)
  if (!store.meta || typeof store.meta !== 'object') store.meta = {}
  store.meta.provider = provider
  store.meta.dim = dim
  if (provider !== 'hash') {
    store.meta.model = process.env.AI_EMBEDDING_MODEL || null
    store.meta.baseUrl = process.env.AI_EMBEDDING_BASE_URL || null
    store.meta.path = process.env.AI_EMBEDDING_PATH || '/v1/embeddings'
  }

  let computed = 0
  let skipped = 0
  for (const m of memories) {
    if (computed >= limit) break
    if (!m || typeof m !== 'object') continue
    if (m.disabledAt) continue
    const id = String(m.id || '')
    if (!id) continue
    const ts = Number(m.updatedAt || m.createdAt || 0) || null
    if (!ts) continue
    const existing = store.vectors?.[id]
    if (existing && Number(existing.updatedAt) === Number(ts) && Array.isArray(existing.v) && existing.v.length) {
      skipped++
      continue
    }
    const text = String(m.instruction || m.text || '').trim()
    if (!text) continue

    let vec = null
    if (provider === 'hash') {
      vec = embeddings.hashEmbedding(text, dim)
    } else {
      vec = await embeddings.embedOpenAICompatible({
        text,
        key: process.env.AI_EMBEDDING_KEY || process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.AI_EMBEDDING_BASE_URL || process.env.DEEPSEEK_BASE_URL || '',
        apiPath: process.env.AI_EMBEDDING_PATH || '/v1/embeddings',
        model: process.env.AI_EMBEDDING_MODEL || '',
        timeoutMs: Number(process.env.AI_EMBEDDING_TIMEOUT_MS) || 15000
      })
    }
    if (!vec) continue
    store.vectors[id] = { updatedAt: ts, v: Array.from(vec) }
    computed++
  }

  process.stdout.write(`mem: ${memPath}\n`)
  process.stdout.write(`out: ${outPath}\n`)
  process.stdout.write(`provider: ${provider}\n`)
  process.stdout.write(`dim: ${dim}\n`)
  process.stdout.write(`computed: ${computed}\n`)
  process.stdout.write(`skipped: ${skipped}\n`)

  if (dryRun) {
    process.stdout.write('dry-run: no files written (use --apply)\n')
    return
  }

  const backup = backupFile(outPath)
  if (backup) process.stdout.write(`backup: ${backup}\n`)
  embeddings.saveStore(outPath, store)
  process.stdout.write(`wrote: ${outPath}\n`)
}

main().catch(err => {
  process.stderr.write(String(err?.stack || err?.message || err) + '\n')
  process.exitCode = 1
})

