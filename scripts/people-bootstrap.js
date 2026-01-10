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

function normalizeName (name) {
  return String(name || '').replace(/\u00a7./g, '').trim().slice(0, 40)
}

function normalizeKey (name) {
  const clean = normalizeName(name)
  return clean ? clean.toLowerCase() : ''
}

function uniquePush (arr, value) {
  const v = String(value || '').trim()
  if (!v) return
  if (arr.includes(v)) return
  arr.push(v)
}

function usage () {
  return [
    'Usage:',
    '  node scripts/people-bootstrap.js [--memory-file data/ai-memory.json] [--apply] [--dry-run]',
    '  node scripts/people-bootstrap.js --apply --bot owkowk',
    '',
    'Bootstraps People Memory (profiles + commitments) from existing ai-memory.json (memories + dialogues).',
    '- Default is dry-run; use --apply to write data/ai-people.json (with a .bak timestamp backup).',
    '- Default does NOT overwrite existing non-empty profiles; use --overwrite to force overwrite.',
    '',
    'Options:',
    '  --memory-file <path>   Source ai-memory.json (default: data/ai-memory.json)',
    '  --apply                Write data/ai-people.json',
    '  --dry-run              Print proposed patch (default: true unless --apply)',
    '  --overwrite            Overwrite existing profiles (default: false)',
    '  --bot <name>           Bot username to exclude from player profiles (default: $MC_USERNAME || $BOT_NAME || "bot")',
    '  --include-bot          Include bot name as a profile too',
    '  --only <a,b,c>         Only generate for these players (comma-separated, case-insensitive)'
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

function splitCsv (raw) {
  const s = String(raw || '').trim()
  if (!s) return []
  return s.split(',').map(x => String(x || '').trim()).filter(Boolean)
}

function extractQuoted (text) {
  const out = []
  const re = /"([^"]{1,32})"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const v = String(m[1] || '').trim()
    if (!v) continue
    out.push(v)
  }
  return out
}

function extractParenAfterQuote (text, quotedValue) {
  const q = String(quotedValue || '').trim()
  if (!q) return ''
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\"${escaped}\"\\s*\\(([^)]{1,32})\\)`)
  const m = text.match(re)
  return m && m[1] ? String(m[1]).trim() : ''
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

  const memoryFile = args['memory-file'] ? path.resolve(String(args['memory-file'])) : path.join(projectRoot, 'data', 'ai-memory.json')
  const apply = parseBool(args.apply, false)
  const dryRun = apply ? false : parseBool(args['dry-run'] ?? args.dryRun, true)
  const overwrite = parseBool(args.overwrite, false)
  const botName = normalizeName(args.bot || process.env.MC_USERNAME || process.env.BOT_NAME || 'bot')
  const includeBot = parseBool(args['include-bot'] ?? args.includeBot, false)
  const onlyList = splitCsv(args.only).map(normalizeName).filter(Boolean)
  const onlySet = onlyList.length ? new Set(onlyList.map(n => n.toLowerCase())) : null

  const memoryJson = readJson(memoryFile)
  if (!memoryJson || typeof memoryJson !== 'object') {
    process.stderr.write(`failed to read json: ${memoryFile}\n`)
    process.exitCode = 2
    return
  }

  const peopleMod = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'people'))
  const { createPeopleService } = peopleMod
  const baseStore = require(path.join(projectRoot, 'bot_impl', 'people-store'))
  const peopleFile = baseStore.DATA_FILE
  const state = {}
  const now = () => Date.now()

  const wrappedStore = {
    load: baseStore.load,
    save: baseStore.save
  }
  const people = createPeopleService({ state, peopleStore: wrappedStore, now })

  const existingByKey = new Map()
  for (const p of (people.listProfiles ? people.listProfiles() : [])) {
    const key = normalizeKey(p?.name || p?.key || '')
    if (!key) continue
    const profile = typeof p.profile === 'string' ? p.profile.trim() : ''
    if (profile) existingByKey.set(key, profile)
  }

  const memories = Array.isArray(memoryJson.memories) ? memoryJson.memories : []
  const dialogues = Array.isArray(memoryJson.dialogues) ? memoryJson.dialogues : []

  const candidates = new Map() // key -> { name, prefers:[], avoids:[], rules:[], notes:[], commitments:[] }

  function ensure (name) {
    const n = normalizeName(name)
    const key = normalizeKey(n)
    if (!key) return null
    if (!includeBot && botName && key === botName.toLowerCase()) return null
    if (onlySet && !onlySet.has(key)) return null
    if (!candidates.has(key)) {
      candidates.set(key, { name: n, prefers: [], avoids: [], rules: [], notes: [], commitments: [] })
    }
    return candidates.get(key)
  }

  // Seed from authors/owners + dialogue participants
  for (const m of memories) {
    ensure(m?.firstAuthor)
    ensure(m?.lastAuthor)
    const owners = Array.isArray(m?.owners) ? m.owners : []
    for (const o of owners) ensure(o)
  }
  for (const d of dialogues) {
    const parts = Array.isArray(d?.participants) ? d.participants : []
    for (const p of parts) ensure(p)
  }

  // Discover extra usernames from strong patterns in memory text (e.g., Amy)
  for (const m of memories) {
    const text = String(m?.text || '')
    const nm = text.match(/当([A-Za-z0-9._]{2,20})搭话时/i)
    if (nm && nm[1]) ensure(nm[1])
    const home = text.match(/这里是\s*([A-Za-z0-9._]{2,20})\s*的家/i)
    if (home && home[1]) ensure(home[1])
  }

  // Extract preferences + commitments from memories
  for (const m of memories) {
    const text = String(m?.text || '').trim()
    if (!text) continue

    // 1) "当X上线时,要大喊\"...\"来欢迎他"
    const greet = text.match(/^当([A-Za-z0-9._]{2,20})上线时[,，]?要大喊\"([^\"]{1,40})\"/i)
    if (greet && greet[1] && greet[2]) {
      const rec = ensure(greet[1])
      if (rec) {
        uniquePush(rec.rules, `上线欢迎：喊“${greet[2].trim()}”`)
      }
    }

    // 2) "当Amy搭话时,不要回复..."
    const noReply = text.match(/^当([A-Za-z0-9._]{2,20})搭话时[,，]?不要回复/i)
    if (noReply && noReply[1]) {
      const rec = ensure(noReply[1])
      if (rec) uniquePush(rec.rules, '交互规则：不要回复（危险/避免灾难）')
    }

    // 3) "X要求...以后称呼他为\"...\""
    const wantCall = text.match(/^([A-Za-z0-9._]{2,40})要求.*以后称呼他为\"([^\"]{1,32})\"/i)
    if (wantCall && wantCall[1] && wantCall[2]) {
      const rec = ensure(wantCall[1])
      const prefer = wantCall[2].trim()
      const extra = extractParenAfterQuote(text, prefer)
      const combined = extra ? `${prefer} (${extra})` : prefer
      if (rec) uniquePush(rec.prefers, combined)
      for (const q of extractQuoted(text)) {
        if (q === prefer) continue
        if (rec && /不再叫|而不是/.test(text)) uniquePush(rec.avoids, q)
      }
    }

    // 4) "X要求...以后不准叫他Y"
    const forbid = text.match(/^([A-Za-z0-9._]{2,40})要求.*以后不准叫他([^\s，。！？,.!?\"]{1,20})/i)
    if (forbid && forbid[1] && forbid[2]) {
      const rec = ensure(forbid[1])
      if (rec) uniquePush(rec.avoids, forbid[2].trim())
    }

    // 5) "X要求...欢迎他上线时...加上\"Y\""
    const welcomeSuffix = text.match(/^([A-Za-z0-9._]{2,40})要求.*欢迎他上线时.*加上\"([^\"]{1,20})\"/i)
    if (welcomeSuffix && welcomeSuffix[1] && welcomeSuffix[2]) {
      const rec = ensure(welcomeSuffix[1])
      if (rec) uniquePush(rec.notes, `曾提到上线欢迎时加“${welcomeSuffix[2].trim()}”后缀`)
    }

    // 6) Bot commitment recorded as fact memory: "owkowk承诺..."
    const promise = text.match(/承诺(.{2,120})/)
    if (promise && promise[1]) {
      const who = normalizeName(m?.lastAuthor || m?.firstAuthor || '')
      const key = normalizeKey(who)
      const looksLikePlayer = key && candidates.has(key)
      if (looksLikePlayer && /承诺/.test(text) && /只认|保密|答应|会/.test(text)) {
        const rec = ensure(who)
        if (rec) {
          const action = text.replace(/\s+/g, ' ').trim()
          uniquePush(rec.commitments, action)
        }
      }
    }
  }

  // Extract relationship hints from dialogue summaries (only if no explicit name preference was found)
  const dialogueByKey = new Map()
  for (const d of dialogues) {
    const parts = Array.isArray(d?.participants) ? d.participants : []
    for (const p of parts) {
      const key = normalizeKey(p)
      if (!key) continue
      if (!dialogueByKey.has(key)) dialogueByKey.set(key, [])
      dialogueByKey.get(key).push(String(d?.summary || '').trim())
    }
  }

  for (const [key, rec] of candidates.entries()) {
    const summaries = dialogueByKey.get(key) || []
    if (!summaries.length) continue
    if (rec.prefers.length || rec.avoids.length || rec.rules.length) continue
    const master = summaries.some(s => /主人|主仆/.test(s))
    if (master) uniquePush(rec.notes, '对话摘要中多次出现“主人/主仆”互动（可能偏好相关称呼）')
    const emoji = summaries.some(s => /表情/.test(s))
    if (emoji) uniquePush(rec.notes, '聊天中出现互发表情互动')
  }

  const patch = { profiles: [], commitments: [] }
  for (const [key, rec] of candidates.entries()) {
    if (!overwrite && existingByKey.has(key)) continue
    const parts = []
    if (rec.prefers.length) parts.push(`称呼偏好：${rec.prefers.join(' / ')}`)
    else parts.push(`称呼偏好：${rec.name}`)
    if (rec.avoids.length) parts.push(`禁忌称呼：${rec.avoids.join('、')}`)
    for (const r of rec.rules) parts.push(r)
    for (const n of rec.notes) parts.push(`备注：${n}`)
    patch.profiles.push({ player: rec.name, profile: parts.join('；') })

    for (const action of rec.commitments) {
      patch.commitments.push({ player: rec.name, action, status: 'pending' })
    }
  }

  patch.profiles.sort((a, b) => String(a.player).localeCompare(String(b.player), 'zh'))

  const targets = patch.profiles.length
  process.stdout.write(`memory: ${memoryFile}\n`)
  process.stdout.write(`people: ${peopleFile}\n`)
  process.stdout.write(`bot: ${botName || '(none)'} includeBot=${includeBot ? 'yes' : 'no'}\n`)
  process.stdout.write(`candidates: ${candidates.size}\n`)
  process.stdout.write(`profiles: ${targets} (overwrite=${overwrite ? 'yes' : 'no'})\n`)
  process.stdout.write(`commitments: ${patch.commitments.length}\n`)

  if (dryRun) {
    process.stdout.write('dry-run: no files written (use --apply)\n')
    process.stdout.write(JSON.stringify(patch, null, 2) + '\n')
    return
  }

  if (fs.existsSync(peopleFile)) {
    const backup = backupFile(peopleFile)
    process.stdout.write(`backup: ${backup}\n`)
  }

  // Save via people service (single persist)
  const res = people.applyPatch({ ...patch, source: 'bootstrap' })
  process.stdout.write(`applied: changed=${res && res.changed ? 'yes' : 'no'}\n`)
  process.stdout.write(`wrote: ${peopleFile}\n`)
}

main()
