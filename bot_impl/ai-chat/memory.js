const MEMORY_REWRITE_SYSTEM_PROMPT = [
  '你是Minecraft服务器里的记忆整理助手。玩家会告诉你一条记忆，你需要判断是否值得记录。',
  '如果值得记录，请输出 JSON：{"status":"ok","instruction":"...", "triggers":["关键词"],"tags":["标签"],"summary":"一句总结","tone":"语气","location":{"x":0,"y":64,"z":0,"radius":30,"dim":"minecraft:overworld"},"feature":"景观特点","greet_suffix":"问候语","kind":"类别"}',
  '若无需记录，输出 {"status":"reject","reason":"原因"}；若需要玩家补充信息，输出 {"status":"clarify","question":"需要什么信息"}。',
  '所有 JSON 属性都必须双引号，内容用中文，禁止添加额外说明。'
].join('\n')

function createMemoryService ({
  state,
  log,
  memoryStore,
  defaults,
  bot,
  traceChat = () => {},
  now = () => Date.now()
}) {
  const memoryCtrl = { running: false }
  let messenger = () => {}

  function setMessenger (fn) {
    messenger = typeof fn === 'function' ? fn : () => {}
  }

  // --- Long-term memory entries ---

  function normalizeMemoryText (text) {
    if (typeof text !== 'string') return ''
    try { return text.normalize('NFKC').replace(/\s+/g, ' ').trim() } catch { return text.replace(/\s+/g, ' ').trim() }
  }

  function uniqueStrings (arr) {
    if (!Array.isArray(arr)) return []
    const out = []
    const seen = new Set()
    for (const item of arr) {
      const v = normalizeMemoryText(item)
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
    return out
  }

  function normalizeLocationValue (value) {
    if (!value || typeof value !== 'object') return null
    const src = (typeof value.position === 'object' && value.position) ? value.position : value
    const toNumber = (raw) => {
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }
    const x = toNumber(src.x)
    const z = toNumber(src.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    const out = {
      x: Math.round(x),
      z: Math.round(z)
    }
    const y = toNumber(src.y)
    if (Number.isFinite(y)) out.y = Math.round(y)
    const radiusRaw = value.radius ?? src.radius
    const radius = toNumber(radiusRaw)
    if (Number.isFinite(radius) && radius > 0) out.radius = Math.max(1, Math.round(radius))
    const dimRaw = value.dim || value.dimension || value.world || src.dim || src.dimension
    if (typeof dimRaw === 'string' && dimRaw.trim()) {
      const dimNorm = normalizeMemoryText(dimRaw)
      if (dimNorm) out.dim = dimNorm.toLowerCase()
    }
    return out
  }

  function locationLabel (loc) {
    if (!loc || typeof loc !== 'object') return ''
    const { x, y, z } = loc
    if (!Number.isFinite(x) || !Number.isFinite(z)) return ''
    if (Number.isFinite(y)) return `${x},${y},${z}`
    return `${x},${z}`
  }

  function ensureMemoryEntries () {
    if (!state.aiMemory || typeof state.aiMemory !== 'object') state.aiMemory = { entries: [] }
    if (!Array.isArray(state.aiMemory.entries)) state.aiMemory.entries = []
    const arr = state.aiMemory.entries
    const nowTs = now()
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      if (!item || typeof item !== 'object') {
        arr.splice(i, 1)
        i--
        continue
      }
      if (typeof item.text === 'string') item.text = normalizeMemoryText(item.text)
      if (!item.text) {
        arr.splice(i, 1)
        i--
        continue
      }
      if (!Number.isFinite(item.count) || item.count <= 0) item.count = 1
      if (!Number.isFinite(item.createdAt)) item.createdAt = nowTs
      if (!Number.isFinite(item.updatedAt)) item.updatedAt = item.createdAt
      if (!Array.isArray(item.triggers)) item.triggers = uniqueStrings(item.triggers ? [item.triggers].flat() : [])
      else item.triggers = uniqueStrings(item.triggers)
      if (!Array.isArray(item.tags)) item.tags = uniqueStrings(item.tags)
      if (item.summary) item.summary = normalizeMemoryText(item.summary)
      if (item.tone) item.tone = normalizeMemoryText(item.tone)
      if (item.instruction) item.instruction = normalizeMemoryText(item.instruction)
      if (!item.instruction) item.instruction = item.text
      item.fromAI = item.fromAI !== false
      if (item.location) {
        const loc = normalizeLocationValue(item.location)
        if (loc) item.location = loc
        else delete item.location
      }
      if (item.feature) {
        const feat = normalizeMemoryText(item.feature).slice(0, 48)
        item.feature = feat
      }
      if (item.greetSuffix) {
        item.greetSuffix = normalizeMemoryText(item.greetSuffix).slice(0, 80)
      }
      if (item.kind) item.kind = normalizeMemoryText(item.kind)
    }
    return arr
  }

  function buildWorldMemoryZones () {
    const entries = ensureMemoryEntries()
    const zones = []
    for (const entry of entries) {
      const loc = entry && entry.location
      if (!loc || !Number.isFinite(loc.x) || !Number.isFinite(loc.z)) continue
      const radius = Number.isFinite(loc.radius) && loc.radius > 0 ? loc.radius : 50
      const suffix = (() => {
        if (typeof entry.greetSuffix !== 'string') return ''
        const norm = normalizeMemoryText(entry.greetSuffix)
        return norm.slice(0, 80)
      })()
      if (!suffix) continue
      const zone = {
        name: (() => {
          if (typeof entry.feature === 'string' && entry.feature.trim()) return normalizeMemoryText(entry.feature)
          if (typeof entry.summary === 'string' && entry.summary.trim()) return normalizeMemoryText(entry.summary)
          return `memory-${entry.createdAt || Date.now()}`
        })(),
        x: Math.round(loc.x),
        y: Number.isFinite(loc.y) ? Math.round(loc.y) : 64,
        z: Math.round(loc.z),
        radius: Math.max(1, Math.round(radius)),
        suffix,
        enabled: true,
        source: 'memory'
      }
      if (loc.dim) zone.dim = loc.dim
      if (typeof entry.instruction === 'string' && entry.instruction.trim()) zone.memoryInstruction = normalizeMemoryText(entry.instruction)
      zones.push(zone)
    }
    return zones
  }

  function updateWorldMemoryZones () {
    try {
      const zones = buildWorldMemoryZones()
      if (!Array.isArray(state.worldMemoryZones)) state.worldMemoryZones = []
      state.worldMemoryZones = zones
    } catch (err) {
      log?.warn && log.warn('world memory zone update error:', err?.message || err)
    }
  }

  function memoryStoreLimit () {
    const cfg = state.ai.context?.memory
    const limit = cfg?.storeMax
    if (Number.isFinite(limit) && limit > 0) return limit
    if (Number.isFinite(state.aiMemory?.storeMax) && state.aiMemory.storeMax > 0) return state.aiMemory.storeMax
    return 200
  }

  function persistMemoryState () {
    try {
      const payload = {
        long: Array.isArray(state.aiLong) ? state.aiLong : [],
        memories: ensureMemoryEntries(),
        dialogues: Array.isArray(state.aiDialogues) ? state.aiDialogues : []
      }
      memoryStore.save(payload)
    } catch {}
  }

  function pruneMemories () {
    const entries = ensureMemoryEntries()
    const limit = memoryStoreLimit()
    if (entries.length <= limit) return
    entries
      .sort((a, b) => {
        const cb = (a?.count || 1) - (b?.count || 1)
        if (cb !== 0) return cb
        return (a?.updatedAt || a?.createdAt || 0) - (b?.updatedAt || b?.createdAt || 0)
      })
    while (entries.length > limit) entries.shift()
  }

  function addMemoryEntry ({ text, author, source, importance, extra } = {}) {
    const entries = ensureMemoryEntries()
    const normalized = normalizeMemoryText(text)
    if (!normalized) return { ok: false, reason: 'empty' }
    const nowTs = now()
    const boost = Number.isFinite(importance) ? Math.max(1, Math.floor(importance)) : 1
    let entry = findExistingMemoryEntry(entries, normalized, extra)
    if (entry) {
      entry.count = Math.max(1, (entry.count || 1) + boost)
      entry.updatedAt = nowTs
      if (author) entry.lastAuthor = author
      if (source) entry.lastSource = source
      if (extra) {
        if (extra.summary) entry.summary = normalizeMemoryText(extra.summary)
        if (extra.instruction) {
          entry.instruction = normalizeMemoryText(extra.instruction)
          entry.text = entry.instruction
        } else {
          entry.text = normalized
          entry.instruction = normalized
        }
        if (Array.isArray(extra.triggers)) {
          entry.triggers = uniqueStrings((entry.triggers || []).concat(extra.triggers))
        }
        if (Array.isArray(extra.tags)) {
          entry.tags = uniqueStrings((entry.tags || []).concat(extra.tags))
        }
        if (extra.tone) entry.tone = normalizeMemoryText(extra.tone)
        entry.fromAI = extra.fromAI !== false
        if (extra.location) {
          const loc = normalizeLocationValue(extra.location)
          if (loc) entry.location = loc
        }
        if (extra.feature) {
          const feat = normalizeMemoryText(extra.feature).slice(0, 48)
          if (feat) entry.feature = feat
        }
        if (extra.greetSuffix) {
          const suffix = normalizeMemoryText(extra.greetSuffix).slice(0, 80)
          if (suffix) entry.greetSuffix = suffix
        }
        if (extra.kind) {
          const kind = normalizeMemoryText(extra.kind)
          if (kind) entry.kind = kind
        }
      }
    } else {
      entry = {
        text: normalized,
        count: Math.max(1, boost),
        createdAt: nowTs,
        updatedAt: nowTs,
        firstAuthor: author || null,
        lastAuthor: author || null,
        lastSource: source || null,
        instruction: normalized,
        triggers: uniqueStrings(extra?.triggers || []),
        tags: uniqueStrings(extra?.tags || []),
        summary: extra?.summary ? normalizeMemoryText(extra.summary) : '',
        tone: extra?.tone ? normalizeMemoryText(extra.tone) : '',
        fromAI: extra?.fromAI !== false
      }
      if (extra?.instruction) {
        entry.instruction = normalizeMemoryText(extra.instruction)
        entry.text = entry.instruction
      }
      if (extra?.location) {
        const loc = normalizeLocationValue(extra.location)
        if (loc) entry.location = loc
      }
      if (extra?.feature) {
        const feat = normalizeMemoryText(extra.feature).slice(0, 48)
        if (feat) entry.feature = feat
      }
      if (extra?.greetSuffix) {
        const suffix = normalizeMemoryText(extra.greetSuffix).slice(0, 80)
        if (suffix) entry.greetSuffix = suffix
      }
      if (extra?.kind) {
        const kind = normalizeMemoryText(extra.kind)
        if (kind) entry.kind = kind
      }
      if (!entry.summary) entry.summary = ''
      entries.push(entry)
    }
    pruneMemories()
    persistMemoryState()
    updateWorldMemoryZones()
    return { ok: true, entry }
  }

  function findExistingMemoryEntry (entries, text, extra) {
    const norm = normalizeMemoryText(text)
    const loc = normalizeLocationValue(extra?.location)
    return entries.find(entry => {
      if (entry.text === norm) return true
      if (loc && entry.location && locationLabel(entry.location) === locationLabel(loc)) return true
      return false
    }) || null
  }

  function topMemories (limit) {
    const entries = ensureMemoryEntries()
    if (!entries.length) return []
    const top = entries.slice().sort((a, b) => {
      const bc = (b?.count || 1) - (a?.count || 1)
      if (bc !== 0) return bc
      return (b?.updatedAt || b?.createdAt || 0) - (a?.updatedAt || a?.createdAt || 0)
    })
    if (!Number.isFinite(limit) || limit <= 0) return top
    return top.slice(0, limit)
  }

  // --- Rewrite queue & background jobs ---

  function recentChatSnippet (count = 5) {
    const lines = (state.aiRecent || []).slice(-Math.max(1, count))
    return lines.map(r => ({ user: r.user, text: r.text })).filter(Boolean)
  }

  async function invokeMemoryRewrite (job) {
    const { key, baseUrl, path, model } = state.ai || {}
    if (!key) return { status: 'error', reason: 'no_key' }
    const url = (baseUrl || defaults.DEFAULT_BASE).replace(/\/$/, '') + (path || defaults.DEFAULT_PATH)
    const payload = {
      job_id: job.id,
      player: job.player,
      request: job.text,
      original_message: job.original,
      recent_chat: job.recent,
      memory_context: job.context || null,
      existing_triggers: ensureMemoryEntries().map(it => ({ instruction: it.instruction || it.text, triggers: it.triggers || [] })).slice(-10)
    }
    const messages = [
      { role: 'system', content: MEMORY_REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) }
    ]
    const body = {
      model: model || defaults.DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 220,
      stream: false
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => String(res.status))
        return { status: 'error', reason: `HTTP ${res.status}: ${txt.slice(0, 120)}` }
      }
      const data = await res.json()
      const reply = data?.choices?.[0]?.message?.content || ''
      const jsonRaw = extractJsonLoose(reply)
      if (!jsonRaw) return { status: 'error', reason: 'no_json' }
      let parsed = null
      try { parsed = JSON.parse(jsonRaw) } catch (e) { return { status: 'error', reason: 'invalid_json', detail: e?.message } }
      return parsed
    } catch (e) {
      return { status: 'error', reason: e?.message || e }
    }
  }

  async function processMemoryQueue () {
    if (memoryCtrl.running) return
    if (!Array.isArray(state.aiMemory.queue) || !state.aiMemory.queue.length) return
    if (!state.ai?.key) return
    memoryCtrl.running = true
    try {
      while (Array.isArray(state.aiMemory.queue) && state.aiMemory.queue.length) {
        const job = state.aiMemory.queue.shift()
        if (!job) continue
        job.attempts = (job.attempts || 0) + 1
        const result = await invokeMemoryRewrite(job)
        const status = result && result.status ? String(result.status).toLowerCase() : null
        if (!result || status === 'error' || !status) {
          if (job.attempts < 3) {
            state.aiMemory.queue.push(job)
            await delay(200)
          } else {
            safeSend(job.player, '我没能整理好这条记忆，下次再试试~')
          }
          continue
        }
        if (status === 'reject') {
          const reason = normalizeMemoryText(result.reason || '')
          safeSend(job.player, reason ? `这句记不住：${reason}` : '这句记不住喵~')
          continue
        }
        if (status === 'clarify') {
          const q = normalizeMemoryText(result.question || '')
          safeSend(job.player, q || '要不要再多给我一点提示呀？')
          continue
        }
        if (status === 'ok') {
          const instruction = normalizeMemoryText(result.instruction || '')
          if (!instruction) {
            safeSend(job.player, '这句话有点复杂，先不记啦~')
            continue
          }
          const triggers = uniqueStrings(result.triggers || [])
          const tags = uniqueStrings(result.tags || [])
          const summary = result.summary ? normalizeMemoryText(result.summary) : ''
          const tone = result.tone ? normalizeMemoryText(result.tone) : ''
          let location = normalizeLocationValue(result.location || result.loc || null)
          if (!location && job.context && job.context.position) {
            const hint = {
              x: job.context.position.x,
              y: job.context.position.y,
              z: job.context.position.z,
              radius: job.context.radius,
              dim: job.context.dimension
            }
            location = normalizeLocationValue(hint) || location
          }
          const featureRaw = result.feature || result.feature_name || null
          const greetRaw = result.greet_suffix || result.greetSuffix || null
          const kindRaw = result.kind || null
          const extra = { instruction, triggers, tags, summary, tone, fromAI: true }
          if (location) extra.location = location
          if (typeof featureRaw === 'string' && featureRaw.trim()) extra.feature = featureRaw
          if (typeof greetRaw === 'string' && greetRaw.trim()) extra.greetSuffix = greetRaw
          if (typeof kindRaw === 'string' && kindRaw.trim()) extra.kind = kindRaw
          addMemoryEntry({
            text: instruction,
            author: job.player,
            source: job.source || 'player',
            importance: 1,
            extra
          })
          const confirm = summary || (location ? `记住啦（${locationLabel(location)}）` : '记住啦~')
          safeSend(job.player, confirm)
          continue
        }
        safeSend(job.player, '这句我还没想明白，下次再试试~')
      }
    } catch (e) {
      log?.warn && log.warn('memory queue error:', e?.message || e)
    } finally {
      memoryCtrl.running = false
    }
  }

  function safeSend (username, text) {
    try { messenger(username, text) } catch {}
  }

  function enqueueMemoryJob (job) {
    if (!job) return
    if (!Array.isArray(state.aiMemory.queue)) state.aiMemory.queue = []
    state.aiMemory.queue.push(job)
    processMemoryQueue().catch(() => {})
  }

  function buildMemoryContext () {
    const cfg = state.ai.context?.memory
    if (cfg && cfg.include === false) return ''
    const limit = cfg?.max || 6
    const top = topMemories(Math.max(1, limit))
    if (!top.length) return ''
    const parts = top.map((m, idx) => memoryLineWithMeta(m, idx))
    return `长期记忆: ${parts.join(' | ')}`
  }

  function memoryLineWithMeta (entry, idx) {
    const baseText = normalizeMemoryText(entry.summary || entry.text)
    const meta = []
    if (entry.location) {
      const locLabel = locationLabel(entry.location)
      if (locLabel) {
        const dim = entry.location.dim ? String(entry.location.dim).replace(/^minecraft:/, '') : null
        const radius = Number.isFinite(entry.location.radius) ? `r${entry.location.radius}` : null
        const pieces = [locLabel, radius, dim].filter(Boolean)
        if (pieces.length) meta.push(pieces.join(' '))
      }
    }
    if (entry.feature) {
      const feat = normalizeMemoryText(entry.feature).slice(0, 40)
      if (feat) meta.push(feat)
    }
    const signed = entry.lastAuthor || entry.firstAuthor
    const parts = [`${idx + 1}. ${baseText}`]
    if (meta.length) parts[0] += `【${meta.join(' | ')}】`
    if (signed) parts[0] += `（${signed}）`
    return parts[0]
  }

  function formatLocationEntry (entry) {
    if (!entry || !entry.location) return null
    const label = locationLabel(entry.location)
    if (!label) return null
    const dim = entry.location.dim ? String(entry.location.dim).replace(/^minecraft:/, '') : null
    const radius = Number.isFinite(entry.location.radius) ? entry.location.radius : null
    const feature = entry.feature ? normalizeMemoryText(entry.feature) : ''
    const summary = entry.summary ? normalizeMemoryText(entry.summary) : normalizeMemoryText(entry.text)
    const parts = [`${summary}`]
    const locParts = [`坐标 ${label}`]
    if (radius) locParts.push(`半径 ${radius}`)
    if (dim) locParts.push(dim)
    parts.push(locParts.join('，'))
    if (feature) parts.push(feature)
    return parts.join('；')
  }

  function findLocationMemoryAnswer (question) {
    if (!question) return null
    const ask = normalizeMemoryText(question)
    if (!ask) return null
    if (!/(在哪|哪儿|哪里|位置|坐标)/.test(ask)) return null
    const stop = new Set(['在哪', '哪里', '哪儿', '位置', '坐标', '你', '我', '那里'])
    const tokens = Array.from(new Set(ask.split(/[\s,，。!?！?]/g).map(t => t.trim()).filter(t => t.length >= 2 && !stop.has(t))))
    const entries = ensureMemoryEntries().filter(e => e && e.location)
    if (!entries.length) return null
    let best = null
    for (const entry of entries) {
      const haystack = [
        normalizeMemoryText(entry.summary || ''),
        normalizeMemoryText(entry.text || ''),
        normalizeMemoryText(entry.feature || '')
      ].join(' ')
      if (!haystack) continue
      if (tokens.length === 0) {
        best = entry
        break
      }
      if (tokens.every(tok => haystack.includes(tok))) {
        best = entry
        break
      }
      if (!best && tokens.some(tok => haystack.includes(tok))) {
        best = entry
      }
    }
    if (!best) return null
    const formatted = formatLocationEntry(best)
    return formatted || null
  }

  function extractMemoryCommand (content) {
    if (!content) return null
    const text = String(content).trim()
    if (!text) return null
    const patterns = [
      /^记住(?:一下)?[:：,，\s]*(.+)$/i,
      /^(?:帮我|请|要)记住[:：,，\s]*(.+)$/i,
      /^记得[:：,，\s]*(.+)$/i,
      /^记一下[:：,，\s]*(.+)$/i,
      /^帮我记[:：,，\s]*(.+)$/i
    ]
    for (const re of patterns) {
      const m = text.match(re)
      if (m && m[1]) {
        const payload = normalizeMemoryText(m[1])
        if (payload) return payload
      }
    }
    return null
  }

  // --- Dialogue memory & summaries ---

  function relativeTimeLabel (ts) {
    if (!Number.isFinite(ts)) return '未知时间'
    const delta = now() - ts
    if (delta < 60 * 1000) return '刚刚'
    if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.round(delta / (60 * 1000)))}分钟前`
    if (delta < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(delta / (60 * 60 * 1000)))}小时前`
    const days = Math.max(1, Math.round(delta / (24 * 60 * 60 * 1000)))
    if (days < 7) return `${days}天前`
    const weeks = Math.max(1, Math.round(days / 7))
    return `${weeks}周前`
  }

  const ONE_HOUR_MS = 60 * 60 * 1000
  const ONE_DAY_MS = 24 * ONE_HOUR_MS
  const ONE_WEEK_MS = 7 * ONE_DAY_MS
  const ONE_MONTH_MS = 30 * ONE_DAY_MS
  const DAY_WINDOW_SHIFT_HOUR = 4

  function conversationTimestamp (entry) {
    if (!entry || typeof entry !== 'object') return null
    const ts = Number(entry.endedAt ?? entry.startedAt)
    return Number.isFinite(ts) ? ts : null
  }

  function pad2 (num) {
    return String(num).padStart(2, '0')
  }

  function formatDate (date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }

  function startOfHour (ts) {
    const d = new Date(ts)
    d.setMinutes(0, 0, 0)
    return d.getTime()
  }

  function startOfDay (ts) {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  function startOfWeek (ts) {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    const day = d.getDay() === 0 ? 7 : d.getDay()
    d.setDate(d.getDate() - (day - 1))
    return d.getTime()
  }

  function startOfMonth (ts) {
    const d = new Date(ts)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  function startOfDailyWindow (ts) {
    const d = new Date(ts)
    d.setHours(DAY_WINDOW_SHIFT_HOUR, 0, 0, 0)
    if (ts < d.getTime()) d.setDate(d.getDate() - 1)
    return d.getTime()
  }

  function startOfWeeklyWindow (ts) {
    const start = startOfDailyWindow(ts)
    const d = new Date(start)
    const day = d.getDay() === 0 ? 7 : d.getDay()
    d.setDate(d.getDate() - (day - 1))
    return d.getTime()
  }

  function formatBucketLabel (kind, start, end) {
    const startDate = new Date(start)
    const endDate = new Date(end - 1)
    if (kind === 'hour') {
      return `${formatDate(startDate)} ${pad2(startDate.getHours())}:00 小时段`
    }
    if (kind === 'day') {
      return `${formatDate(startDate)} 日汇总`
    }
    if (kind === 'week') {
      return `${formatDate(startDate)}~${formatDate(endDate)} 周汇总`
    }
    if (kind === 'month') {
      return `${startDate.getFullYear()}-${pad2(startDate.getMonth() + 1)} 月汇总`
    }
    return relativeTimeLabel(start)
  }

  function dialogueBucketSpec (entry) {
    const ts = conversationTimestamp(entry)
    if (!Number.isFinite(ts)) return { kind: 'single' }
    const age = now() - ts
    if (!Number.isFinite(age) || age <= ONE_HOUR_MS) return { kind: 'single' }
    if (age <= ONE_DAY_MS) {
      const start = startOfHour(ts)
      return { kind: 'hour', start, end: start + ONE_HOUR_MS, label: formatBucketLabel('hour', start, start + ONE_HOUR_MS) }
    }
    if (age <= ONE_WEEK_MS) {
      const start = startOfDay(ts)
      return { kind: 'day', start, end: start + ONE_DAY_MS, label: formatBucketLabel('day', start, start + ONE_DAY_MS) }
    }
    if (age <= ONE_MONTH_MS) {
      const start = startOfWeek(ts)
      return { kind: 'week', start, end: start + ONE_WEEK_MS, label: formatBucketLabel('week', start, start + ONE_WEEK_MS) }
    }
    const start = startOfMonth(ts)
    const endBase = new Date(start)
    endBase.setMonth(endBase.getMonth() + 1)
    return { kind: 'month', start, end: endBase.getTime(), label: formatBucketLabel('month', start, endBase.getTime()) }
  }

  function aggregateDialogueEntries (entries) {
    if (!Array.isArray(entries) || !entries.length) return []
    const sorted = entries.slice().sort((a, b) => {
      const ta = conversationTimestamp(a) || 0
      const tb = conversationTimestamp(b) || 0
      return tb - ta
    })
    const out = []
    const bucketRefs = new Map()
    for (const entry of sorted) {
      if (!entry) continue
      const spec = dialogueBucketSpec(entry)
      if (!spec || spec.kind === 'single') {
        out.push({ type: 'single', entry })
        continue
      }
      const key = `${spec.kind}:${spec.start}`
      let bucket = bucketRefs.get(key)
      if (!bucket) {
        bucket = {
          type: 'aggregate',
          kind: spec.kind,
          start: spec.start,
          end: spec.end,
          label: spec.label,
          latestEndedAt: conversationTimestamp(entry) || spec.start,
          entries: [],
          participants: new Set()
        }
        bucketRefs.set(key, bucket)
        out.push(bucket)
      }
      bucket.entries.push(entry)
      const ts = conversationTimestamp(entry)
      if (Number.isFinite(ts) && ts > bucket.latestEndedAt) bucket.latestEndedAt = ts
      for (const p of entry.participants || []) {
        const name = typeof p === 'string' ? p.trim() : ''
        if (name) bucket.participants.add(name)
      }
    }
    return out
  }

  function formatPeopleLabel (list) {
    const seen = new Set()
    const names = []
    for (const raw of list || []) {
      const name = typeof raw === 'string' ? raw.trim() : ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
    if (!names.length) return '玩家们'
    const MAX = 3
    const head = names.slice(0, MAX)
    if (names.length > MAX) return `${head.join('、')} 等${names.length}人`
    return head.join('、')
  }

  function summarizeBucketEntries (entries) {
    const texts = entries
      .map(e => (typeof e?.summary === 'string' ? e.summary.trim() : ''))
      .filter(Boolean)
    if (!texts.length) return `${entries.length}条对话`
    const MAX = 3
    const head = texts.slice(0, MAX).join(' / ')
    if (texts.length > MAX) return `${head} / 等${texts.length}条`
    return head
  }

  function formatDialogueLine (item, idx) {
    if (!item) return null
    if (item.type === 'aggregate') {
      const rel = relativeTimeLabel(item.latestEndedAt)
      const label = `${rel} ${item.label}（合并${item.entries.length}条）`
      const people = formatPeopleLabel([...item.participants])
      const summary = summarizeBucketEntries(item.entries)
      return `${idx + 1}. ${label} ${people}: ${summary}`
    }
    const entry = item.entry
    if (!entry) return null
    const label = relativeTimeLabel(entry.endedAt)
    const people = formatPeopleLabel(entry.participants)
    const summary = typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : '（无摘要）'
    return `${idx + 1}. ${label} ${people}: ${summary}`
  }

  function formatDialogueEntriesForDisplay (entries) {
    const aggregated = aggregateDialogueEntries(entries)
    return aggregated
      .map((item, idx) => formatDialogueLine(item, idx))
      .filter(Boolean)
  }

  const aggregationCtrl = { running: false, lastCheck: 0 }

  function ensureDialogueBucketsState () {
    if (!state.aiDialogueBuckets || typeof state.aiDialogueBuckets !== 'object') state.aiDialogueBuckets = {}
    return state.aiDialogueBuckets
  }

  function entryTier (entry) {
    if (!entry || typeof entry !== 'object') return null
    return entry.tier || 'raw'
  }

  function entriesInWindow (tier, start, end) {
    if (!Array.isArray(state.aiDialogues)) state.aiDialogues = []
    return state.aiDialogues.filter(entry => {
      if (!entry) return false
      const currentTier = entryTier(entry)
      if (tier && currentTier !== tier) return false
      const ts = conversationTimestamp(entry)
      if (!Number.isFinite(ts)) return false
      return ts >= start && ts < end
    })
  }

  function existingAggregate (tier, start, end) {
    if (!Array.isArray(state.aiDialogues)) return false
    return state.aiDialogues.some(entry => entry && entryTier(entry) === tier && entry.bucket && entry.bucket.start === start && entry.bucket.end === end)
  }

  function aggregateParticipants (entries) {
    const set = new Set()
    for (const entry of entries) {
      for (const name of entry?.participants || []) {
        if (!name) continue
        set.add(String(name))
      }
    }
    return [...set]
  }

  function summarizationFallback (entries) {
    const texts = entries
      .map(e => typeof e?.summary === 'string' ? e.summary.trim() : '')
      .filter(Boolean)
    if (!texts.length) return `${entries.length}条对话活动`
    const sample = texts.slice(0, 3).join(' / ')
    if (texts.length > 3) return `${sample} / 等${texts.length}条`
    return sample
  }

  async function summarizeDialogueWindow (entries, label, tierName) {
    const fallback = summarizationFallback(entries)
    const names = aggregateParticipants(entries)
    const combined = entries
      .map(e => {
        const who = formatPeopleLabel(e?.participants || [])
        const text = typeof e?.summary === 'string' ? e.summary.trim() : ''
        return `${who}: ${text}`.trim()
      })
      .filter(Boolean)
      .join(' | ')
    if (!combined) return fallback
    const sys = '你是Minecraft服务器里的记忆整理助手。请压缩给定时间段内的对话摘要，50字以内，强调主要事件、地点和相关玩家。禁止编造。'
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: `时间段：${label}\n层级：${tierName}\n参与者：${names.join('、') || '玩家们'}\n摘要列表：${combined}\n请输出一段≤50字总结。` }
    ]
    const summary = await runSummaryModel(messages, 100, 0.2)
    if (!summary) return fallback
    return summary.replace(/\s+/g, ' ').trim()
  }

  async function aggregateDialogueWindow ({ sourceTier, targetTier, kind, start, end }) {
    const list = entriesInWindow(sourceTier, start, end)
    if (!list.length) return false
    const label = formatBucketLabel(kind, start, end)
    const summary = await summarizeDialogueWindow(list, label, targetTier)
    const participants = aggregateParticipants(list)
    const entry = {
      id: `agg_${targetTier}_${start}`,
      tier: targetTier,
      participants,
      summary,
      startedAt: start,
      endedAt: end - 1,
      bucket: { kind, start, end, label },
      sourceTier,
      sourceCount: list.length,
      createdAt: now()
    }
    for (let i = state.aiDialogues.length - 1; i >= 0; i--) {
      const current = state.aiDialogues[i]
      if (!current || entryTier(current) !== sourceTier) continue
      const ts = conversationTimestamp(current)
      if (!Number.isFinite(ts)) continue
      if (ts >= start && ts < end) state.aiDialogues.splice(i, 1)
    }
    state.aiDialogues.push(entry)
    return true
  }

  async function aggregateHourlyBuckets (nowTs) {
    const buckets = ensureDialogueBucketsState()
    let cursor = Number.isFinite(buckets.hourlyEnd) ? buckets.hourlyEnd : startOfHour(nowTs)
    const target = startOfHour(nowTs)
    let changed = false
    while (cursor + ONE_HOUR_MS <= target) {
      const start = cursor
      const end = cursor + ONE_HOUR_MS
      if (!existingAggregate('hour', start, end)) {
        const ok = await aggregateDialogueWindow({ sourceTier: 'raw', targetTier: 'hour', kind: 'hour', start, end })
        if (ok) changed = true
      }
      cursor = end
    }
    buckets.hourlyEnd = cursor
    return changed
  }

  async function aggregateDailyBuckets (nowTs) {
    const buckets = ensureDialogueBucketsState()
    let cursor = Number.isFinite(buckets.dailyEnd) ? buckets.dailyEnd : startOfDailyWindow(nowTs)
    const target = startOfDailyWindow(nowTs)
    let changed = false
    while (cursor + ONE_DAY_MS <= target) {
      const start = cursor
      const end = cursor + ONE_DAY_MS
      if (!existingAggregate('day', start, end)) {
        const ok = await aggregateDialogueWindow({ sourceTier: 'hour', targetTier: 'day', kind: 'day', start, end })
        if (ok) changed = true
      }
      cursor = end
    }
    buckets.dailyEnd = cursor
    return changed
  }

  async function aggregateWeeklyBuckets (nowTs) {
    const buckets = ensureDialogueBucketsState()
    let cursor = Number.isFinite(buckets.weeklyEnd) ? buckets.weeklyEnd : startOfWeeklyWindow(nowTs)
    const target = startOfWeeklyWindow(nowTs)
    let changed = false
    while (cursor + ONE_WEEK_MS <= target) {
      const start = cursor
      const end = cursor + ONE_WEEK_MS
      if (!existingAggregate('week', start, end)) {
        const ok = await aggregateDialogueWindow({ sourceTier: 'day', targetTier: 'week', kind: 'week', start, end })
        if (ok) changed = true
      }
      cursor = end
    }
    buckets.weeklyEnd = cursor
    return changed
  }

  function pruneExpiredDialogues (nowTs) {
    if (!Array.isArray(state.aiDialogues)) state.aiDialogues = []
    const cutoff = nowTs - ONE_MONTH_MS
    let changed = false
    for (let i = state.aiDialogues.length - 1; i >= 0; i--) {
      const entry = state.aiDialogues[i]
      const ts = conversationTimestamp(entry)
      if (!Number.isFinite(ts) || ts < cutoff) {
        state.aiDialogues.splice(i, 1)
        changed = true
      }
    }
    return changed
  }

  async function maybeRunDialogueAggregation () {
    const nowTs = now()
    if (aggregationCtrl.running) return
    if (nowTs - aggregationCtrl.lastCheck < 60 * 1000) return
    aggregationCtrl.running = true
    aggregationCtrl.lastCheck = nowTs
    try {
      let changed = false
      changed = await aggregateHourlyBuckets(nowTs) || changed
      changed = await aggregateDailyBuckets(nowTs) || changed
      changed = await aggregateWeeklyBuckets(nowTs) || changed
      changed = pruneExpiredDialogues(nowTs) || changed
      if (changed) {
        trimConversationStore()
        persistMemoryState()
      }
    } catch (err) {
      traceChat('[chat] dialogue aggregation error', err?.message || err)
    } finally {
      aggregationCtrl.running = false
    }
  }

  function selectDialoguesForContext (username) {
    if (!Array.isArray(state.aiDialogues) || !state.aiDialogues.length) return []
    const sorted = state.aiDialogues.slice().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    const prioritized = username ? sorted.filter(entry => Array.isArray(entry.participants) && entry.participants.includes(username)) : sorted
    const remaining = username ? sorted.filter(entry => !prioritized.includes(entry)) : []
    const combined = username ? prioritized.concat(remaining) : sorted
    const selected = []
    const used = new Set()
    const nowTs = now()
    const CONVERSATION_BUCKETS = [
      { maxDays: 3, limit: 4 },
      { maxDays: 7, limit: 6 },
      { maxDays: 15, limit: 8 },
      { maxDays: 30, limit: 10 }
    ]
    for (const bucket of CONVERSATION_BUCKETS) {
      let count = 0
      for (const entry of combined) {
        if (!entry) continue
        const key = entry.id || `${entry.endedAt || 0}_${entry.summary || ''}`
        if (used.has(key)) continue
        const ageDays = Number.isFinite(entry.endedAt) ? (nowTs - entry.endedAt) / (24 * 60 * 60 * 1000) : Infinity
        if (!Number.isFinite(ageDays) || ageDays > bucket.maxDays) continue
        selected.push(entry)
        used.add(key)
        count++
        if (count >= bucket.limit) break
      }
    }
    return selected
  }

  function buildConversationMemoryPrompt (username) {
    const entries = selectDialoguesForContext(username)
    if (!entries.length) return ''
    const lines = formatDialogueEntriesForDisplay(entries)
    if (!lines.length) return ''
    return `对话记忆：\n${lines.join('\n')}`
  }

  function conversationParticipantsFromLines (lines) {
    const selfName = String(bot?.username || '')
    const set = new Set()
    for (const line of lines) {
      const name = String(line?.user || '').trim()
      if (!name || name === selfName) continue
      set.add(name)
    }
    return [...set]
  }

  async function runSummaryModel (messages, maxTokens = 60, temperature = 0.2) {
    const { key, model } = state.ai || {}
    if (!key) return null
    const url = (state.ai.baseUrl || defaults.DEFAULT_BASE).replace(/\/$/, '') + (state.ai.path || defaults.DEFAULT_PATH)
    const body = { model: model || defaults.DEFAULT_MODEL, messages, temperature, max_tokens: maxTokens, stream: false }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      })
      if (!res.ok) return null
      const data = await res.json()
      return data?.choices?.[0]?.message?.content?.trim() || null
    } catch { return null }
  }

  function fallbackConversationSummary (lines, participants) {
    const parts = participants.length ? participants.join('、') : '玩家们'
    const recent = lines.slice(-2).map(l => `${l.user}: ${l.text}`).join(' / ')
    return `${parts} 聊天：${recent.slice(0, 50)}`
  }

  async function summarizeConversationLines (lines, participants) {
    if (!lines.length) return ''
    const fallback = fallbackConversationSummary(lines, participants)
    const joined = lines.map(l => `${l.user}: ${l.text}`).join(' | ')
    const sys = '你是Minecraft服务器里的聊天总结助手。请用中文≤40字，概括玩家互动主题，提到参与者名字和关键行动/地点，不要编造。'
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: `玩家：${participants.join('、') || '未知'}\n聊天摘录（旧→新）：${joined}\n请输出一句总结。` }
    ]
    const summary = await runSummaryModel(messages, 80, 0.3)
    if (!summary) return fallback
    return summary.replace(/\s+/g, ' ').trim()
  }

  async function processConversationSummary (job) {
    try {
      const lines = (state.aiRecent || []).filter(line => Number(line?.seq) > job.startSeq && Number(line?.seq) <= job.endSeq)
      if (!lines.length) return
      const participants = job.participants && job.participants.length ? job.participants : conversationParticipantsFromLines(lines)
      if (!participants.length) participants.push(job.username || '玩家')
      const summary = await summarizeConversationLines(lines, participants)
      if (!summary) return
      const record = {
        id: job.id,
        participants: participants.map(p => String(p || '').trim()).filter(Boolean),
        summary,
        startedAt: job.startedAt || now(),
        endedAt: job.endedAt || now(),
        tier: 'raw'
      }
      state.aiDialogues.push(record)
      trimConversationStore()
      persistMemoryState()
    } catch (e) {
      traceChat('[chat] process summary error', e?.message || e)
    }
  }

  function queueConversationSummary (username, entry, reason) {
    try {
      if (!entry) return
      const startSeq = Number(entry.startSeq)
      const endSeq = Number(entry.lastSeq || state.aiRecentSeq)
      if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq) || endSeq <= startSeq) return
      const participants = entry.participants instanceof Set ? [...entry.participants] : []
      const payload = {
        id: `conv_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        username,
        participants,
        startSeq,
        endSeq,
        startedAt: entry.startedAt || now(),
        endedAt: entry.lastAt || now(),
        reason
      }
      processConversationSummary(payload).catch(err => traceChat('[chat] summary error', err?.message || err))
    } catch (e) {
      traceChat('[chat] summary queue error', e?.message || e)
    }
  }

  function trimConversationStore () {
    if (!Array.isArray(state.aiDialogues)) state.aiDialogues = []
    const CONVERSATION_STORE_MAX = 60
    if (state.aiDialogues.length <= CONVERSATION_STORE_MAX) return
    state.aiDialogues.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
    while (state.aiDialogues.length > CONVERSATION_STORE_MAX) state.aiDialogues.shift()
  }

  function extractJsonLoose (raw) {
    if (!raw) return null
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence && fence[1]) return fence[1].trim()
    let depth = 0
    let inString = false
    let start = -1
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (ch === '"' && raw[i - 1] !== '\\') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') {
        if (depth === 0) start = i
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0 && start !== -1) return raw.slice(start, i + 1)
      }
    }
    return null
  }

  function delay (ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0))) }

  const longTerm = {
    persistState: persistMemoryState,
    updateWorldZones: updateWorldMemoryZones,
    buildContext: buildMemoryContext,
    addEntry: addMemoryEntry,
    findLocationAnswer: findLocationMemoryAnswer,
    extractCommand: extractMemoryCommand,
    normalizeText: normalizeMemoryText
  }

  const dialogue = {
    trimStore: trimConversationStore,
    selectForContext: selectDialoguesForContext,
    buildPrompt: buildConversationMemoryPrompt,
    queueSummary: queueConversationSummary,
    relativeTimeLabel,
    formatEntriesForDisplay: formatDialogueEntriesForDisplay,
    maybeRunAggregation: maybeRunDialogueAggregation
  }

  const rewrite = {
    enqueueJob: enqueueMemoryJob,
    processQueue: processMemoryQueue,
    recentSnippet: recentChatSnippet
  }

  return {
    setMessenger,
    longTerm,
    dialogue,
    rewrite
  }
}

module.exports = { createMemoryService }
