#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

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
    '  node scripts/memory-backfill-v2.js [--file data/ai-memory.json] [--apply] [--dry-run]',
    '  node scripts/memory-backfill-v2.js --rollback <backup-file> [--file data/ai-memory.json]',
    '',
    'Backfills LTM namespace fields (scope/owners) using current inference rules in memory service.',
    '- Default is dry-run; use --apply to write changes.',
    '- Writes a timestamped .bak copy before applying.',
    '',
    'Examples:',
    '  node scripts/memory-backfill-v2.js --dry-run',
    '  node scripts/memory-backfill-v2.js --apply',
    '  node scripts/memory-backfill-v2.js --rollback data/ai-memory.json.bak.1700000000000'
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
  const ts = Date.now()
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const backup = path.join(dir, `${base}.bak.${ts}`)
  fs.copyFileSync(filePath, backup)
  return backup
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    process.stdout.write(usage() + '\n')
    process.exitCode = 0
    return
  }

  const projectRoot = path.resolve(__dirname, '..')
  try { process.chdir(projectRoot) } catch {}

  const file = args.file ? path.resolve(String(args.file)) : path.join(projectRoot, 'data', 'ai-memory.json')
  const rollback = args.rollback ? path.resolve(String(args.rollback)) : null
  const apply = parseBool(args.apply, false)
  const dryRun = apply ? false : parseBool(args['dry-run'] ?? args.dryRun, true)

  if (rollback) {
    if (!fs.existsSync(rollback)) {
      process.stderr.write(`rollback file not found: ${rollback}\n`)
      process.exitCode = 2
      return
    }
    fs.copyFileSync(rollback, file)
    process.stdout.write(`rolled back: ${file}\n`)
    return
  }

  const before = readJson(file)
  if (!before || typeof before !== 'object') {
    process.stderr.write(`failed to read json: ${file}\n`)
    process.exitCode = 2
    return
  }

  const beforeMemories = Array.isArray(before.memories) ? before.memories : []
  const beforeLong = Array.isArray(before.long) ? before.long : []
  const beforeDialogues = Array.isArray(before.dialogues) ? before.dialogues : []

  const memoryMod = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'memory'))
  const { createMemoryService } = memoryMod

  const state = {
    ai: { context: { memory: { include: true, max: 6 } } },
    aiLong: JSON.parse(JSON.stringify(beforeLong)),
    aiDialogues: JSON.parse(JSON.stringify(beforeDialogues)),
    aiMemory: { entries: JSON.parse(JSON.stringify(beforeMemories)) }
  }

  let saved = null
  const memoryStore = {
    save: (payload) => {
      saved = {
        version: 3,
        long: Array.isArray(payload?.long) ? payload.long : [],
        memories: Array.isArray(payload?.memories) ? payload.memories : [],
        dialogues: Array.isArray(payload?.dialogues) ? payload.dialogues : []
      }
    }
  }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const botName = process.env.BOT_NAME || 'bot'
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: botName } })

  memory.longTerm.persistState()
  if (!saved) {
    process.stderr.write('unexpected: no payload produced\n')
    process.exitCode = 2
    return
  }

  const afterMemories = saved.memories
  const beforeById = new Map(beforeMemories.map(m => [String(m?.id || ''), m]))
  let changed = 0
  let playerScoped = 0
  let globalScoped = 0
  for (const m of afterMemories) {
    const id = String(m?.id || '')
    const b = beforeById.get(id) || {}
    const scopeBefore = String(b?.scope || '')
    const ownersBefore = JSON.stringify(b?.owners || b?.owner || null)
    const scopeAfter = String(m?.scope || '')
    const ownersAfter = JSON.stringify(m?.owners || m?.owner || null)
    if (scopeBefore !== scopeAfter || ownersBefore !== ownersAfter) changed++
    if (scopeAfter === 'player') playerScoped++
    else globalScoped++
  }

  process.stdout.write(`file: ${file}\n`)
  process.stdout.write(`memories: ${afterMemories.length}\n`)
  process.stdout.write(`namespace changes: ${changed}\n`)
  process.stdout.write(`scope: player=${playerScoped} global=${globalScoped}\n`)

  if (dryRun) {
    process.stdout.write('dry-run: no files written (use --apply)\n')
    return
  }

  const backup = backupFile(file)
  fs.writeFileSync(file, JSON.stringify(saved))
  process.stdout.write(`backup: ${backup}\n`)
  process.stdout.write(`wrote: ${file}\n`)
}

main()

