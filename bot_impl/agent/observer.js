// Observer: provide lightweight game snapshot for prompts, and on-demand detailed fetchers

const HOSTILE_TOKENS_EN = ['creeper','zombie','zombie_villager','skeleton','spider','cave_spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden','piglin','piglin_brute']
const HOSTILE_TOKENS_CN = ['苦力怕','僵尸','骷髅','蜘蛛','洞穴蜘蛛','末影人','女巫','史莱姆','溺尸','尸壳','掠夺者','恼鬼','掠夺兽','幻翼','烈焰人','恶魂','岩浆怪','守卫者','远古守卫者','潜影贝','凋灵骷髅','疣猪兽','僵尸疣猪兽','流浪者','蠹虫','唤魔者','卫道士','监守者','猪灵','猪灵蛮兵']

let bookLib = null
try { bookLib = require('../actions/lib/book') } catch {}

function ensureMcData (bot) { try { if (!bot.mcData) bot.mcData = require('minecraft-data')(bot.version) } catch {} ; return bot.mcData }

function fmtNum (n) { return Number.isFinite(n) ? Number(n).toFixed(1) : String(n) }

function dimName (bot) { try { return bot.game?.dimension || 'overworld' } catch { return 'overworld' } }

function timeBrief (bot) { try { const tod = bot.time?.timeOfDay || 0; return (tod >= 13000 && tod <= 23000) ? '夜间' : '白天' } catch { return '' } }

function stripColorCodes (s) {
  try { return String(s || '').replace(/\u00a7./g, '') } catch { return '' }
}

function toPlainTextSafe (v) {
  try {
    if (bookLib && typeof bookLib.toPlainText === 'function') {
      return stripColorCodes(bookLib.toPlainText(v))
    }
    return stripColorCodes(String(v || ''))
  } catch {
    try { return stripColorCodes(String(v || '')) } catch { return '' }
  }
}

function simplifyNbtSync (raw) {
  if (!raw) return null
  try {
    const nbt = require('prismarine-nbt')
    const simplify = nbt.simplify || ((x) => x)
    if (raw.type && raw.value) return simplify(raw)
    if (raw.parsed && raw.parsed.type && raw.parsed.value) return simplify(raw.parsed)
    if (typeof raw === 'object') return raw
  } catch {}
  return null
}

function readTypedNbtString (raw, path) {
  try {
    let node = raw
    if (node && node.parsed) node = node.parsed
    for (const key of (Array.isArray(path) ? path : [path])) {
      if (!node || node.type !== 'compound') return null
      node = node.value?.[key]
    }
    if (!node) return null
    if (node.type === 'string') return String(node.value || '')
    if (node.type && node.value != null) return String(node.value)
    return null
  } catch {
    return null
  }
}

function itemCustomLabel (bot, item) {
  try {
    if (!item) return null
    const slotIdx = Number.isFinite(item.slot) ? item.slot : null
    if (slotIdx != null) {
      const cached = bot?.state?.invLabels?.bySlot?.[String(slotIdx)]
      if (typeof cached === 'string') {
        const t = cached.trim()
        if (t) return t
        // empty string means "known no label"
      }
    }
    try {
      if (bookLib && typeof bookLib.extractItemLabel === 'function') {
        const label = bookLib.extractItemLabel(item, { fallbackBookDisplayName: true })
        if (typeof label === 'string' && label.trim()) return label.trim()
      }
    } catch {}
    const raw = item.nbt
    const tag = simplifyNbtSync(raw)
    const id = String(item?.name || '').toLowerCase()
    if (id === 'written_book' || id === 'writable_book') {
      const titleRaw = tag?.title || readTypedNbtString(raw, ['title'])
      const title = toPlainTextSafe(titleRaw || '').trim()
      if (title) return title
    }
    const nameRaw = tag?.display?.Name || readTypedNbtString(raw, ['display', 'Name'])
    const custom = toPlainTextSafe(nameRaw || '').trim()
    return custom || null
  } catch {
    return null
  }
}

function itemBriefName (bot, item) {
  try {
    if (!item) return null
    const base = item.name || String(item.type)
    const label = itemCustomLabel(bot, item)
    if (!label) return base
    return `${base}「${label}」`
  } catch {
    return null
  }
}

function collectNearbyPlayers (bot, range = 16, max = 5) {
  try {
    const me = bot.entity?.position
    if (!me) return []
    const list = []
    for (const [name, rec] of Object.entries(bot.players || {})) {
      const e = rec?.entity
      if (!e || e === bot.entity) continue
      const d = e.position.distanceTo(me)
      if (d <= range) list.push({ name, d })
    }
    list.sort((a, b) => a.d - b.d)
    return list.slice(0, Math.max(0, max))
  } catch { return [] }
}

function isItemEntity (e) {
  try {
    if (!e || !e.position) return false
    const kind = String(e?.kind || '').toLowerCase()
    if (kind === 'drops') return true
    const nm = String(e.name || e.displayName || '').toLowerCase()
    if (nm === 'item' || nm === 'item_entity' || nm === 'dropped_item') return true
  if (e.item) return true
  return false
  } catch { return false }
}

function collectDrops (bot, range = 8, max = 6) {
  try {
    const me = bot.entity?.position
    if (!me) return []
    const arr = []
    for (const e of Object.values(bot.entities || {})) {
      if (!isItemEntity(e)) continue
      const d = e.position.distanceTo(me)
      if (d <= range) arr.push({ d })
    }
    arr.sort((a, b) => a.d - b.d)
    return arr.slice(0, Math.max(0, max))
  } catch { return [] }
}

function hostileSet () {
  return new Set(['creeper','zombie','zombie_villager','skeleton','spider','cave_spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma_cube','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden','piglin','piglin_brute'])
}

function collectHostiles (bot, range = 24) {
  try {
    const hs = hostileSet()
    const me = bot.entity?.position
    if (!me) return { count: 0, nearest: null }
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      try {
        if (!e || !e.position) continue
        // Skip players explicitly
        if (String(e.type || '').toLowerCase() === 'player') continue
        // Robust name extraction (displayName may be a ChatMessage object)
        let raw = e.name
        if (!raw && e.displayName) raw = (typeof e.displayName.toString === 'function') ? e.displayName.toString() : String(e.displayName)
        const nm = String(raw || '').toLowerCase().replace(/\u00a7./g, '')
        // Accept exact id or fuzzy token match to handle servers with custom name suffixes
        const isLike = hs.has(nm) || HOSTILE_TOKENS_EN.some(t => nm.includes(t)) || HOSTILE_TOKENS_CN.some(t => nm.includes(t))
        if (!isLike) continue
        const d = e.position.distanceTo(me)
        if (Number.isFinite(d) && d <= range) list.push({ name: nm, d })
      } catch {}
    }
    if (!list.length) return { count: 0, nearest: null }
    list.sort((a, b) => a.d - b.d)
    return { count: list.length, nearest: list[0] }
  } catch { return { count: 0, nearest: null } }
}

function entityText (v) {
  try {
    let s = ''
    if (typeof v === 'string') s = v
    else if (v && typeof v === 'object') s = toPlainTextSafe(v)
    else if (v != null) s = String(v)
    if ((!s || s === '[object Object]') && v && typeof v.toString === 'function') s = String(v.toString())
    s = stripColorCodes(String(s || '')).trim()
    if (s === '[object Object]') return ''
    return s
  } catch {
    return ''
  }
}

function entityNameProfile (e) {
  try {
    const base = entityText(e?.name)
    const display = entityText(e?.displayName)
    const username = entityText(e?.username)
    const candidates = [e?.customName, e?.metadata?.customName, e?.metadata?.CustomName]
    const meta = e?.metadata
    if (Array.isArray(meta)) {
      for (const idx of [2, 3, 4, 5, 6, 7, 8, 9]) candidates.push(meta[idx])
    } else if (meta && typeof meta === 'object') {
      for (const key of ['2', '3', '4', '5', '6']) candidates.push(meta[key])
    }
    let custom = ''
    for (const c of candidates) {
      const t = entityText(c)
      if (t && t !== 'null' && t !== 'undefined') { custom = t; break }
    }
    const title = custom || username || display || base || 'unknown'
    const searchable = [base, display, username, custom, title, String(e?.type || ''), String(e?.kind || '')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return { base, display, username, custom, title, searchable }
  } catch {
    return { base: '', display: '', username: '', custom: '', title: 'unknown', searchable: '' }
  }
}

function isSignBlockName (name) {
  const s = String(name || '').toLowerCase()
  if (!s) return false
  if (s === 'sign' || s === 'wall_sign' || s === 'standing_sign') return true
  return s.endsWith('_sign') || s.endsWith('_wall_sign') || s.endsWith('_hanging_sign') || s.endsWith('_wall_hanging_sign')
}

function normalizeSignLines (text) {
  try {
    const s = stripColorCodes(String(text || '')).trim()
    if (!s) return []
    return s
      .split('\n')
      .map(x => stripColorCodes(String(x || '')).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function extractSignText (block) {
  const front = []
  const back = []
  try {
    if (typeof block?.getSignText === 'function') {
      const [frontText, backText] = block.getSignText()
      front.push(...normalizeSignLines(frontText))
      back.push(...normalizeSignLines(backText))
    }
  } catch {}
  try {
    if (!front.length && block?.signText != null) {
      front.push(...normalizeSignLines(block.signText))
    }
  } catch {}
  try {
    if (!front.length && block?.blockEntity) {
      const be = block.blockEntity
      const direct = [be?.Text1, be?.Text2, be?.Text3, be?.Text4, be?.text1, be?.text2, be?.text3, be?.text4]
      for (const v of direct) front.push(...normalizeSignLines(v))
      const fm = be?.front_text?.messages
      if (Array.isArray(fm)) for (const v of fm) front.push(...normalizeSignLines(v))
      const bm = be?.back_text?.messages
      if (Array.isArray(bm)) for (const v of bm) back.push(...normalizeSignLines(v))
    }
  } catch {}
  return {
    front: Array.from(new Set(front)),
    back: Array.from(new Set(back))
  }
}

function collectNearbySigns (bot, { radius = 20, max = 20 } = {}) {
  try {
    const me = bot.entity?.position
    if (!me) return []
    const count = Math.min(256, Math.max(max * 4, max))
    const poses = bot.findBlocks({
      matching: (b) => b && isSignBlockName(b.name),
      maxDistance: Math.max(2, radius),
      count
    }) || []
    poses.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const out = []
    for (const p of poses.slice(0, max)) {
      try {
        const b = bot.blockAt(p)
        if (!b || !isSignBlockName(b.name)) continue
        const { front, back } = extractSignText(b)
        const all = [...front, ...back]
        out.push({
          blockName: String(b.name || ''),
          x: b.position.x,
          y: b.position.y,
          z: b.position.z,
          d: Number(b.position.distanceTo(me).toFixed(2)),
          front,
          back,
          text: all.length ? all.join(' | ') : ''
        })
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

function blockIsPassable (block) {
  try {
    if (!block) return true
    const name = String(block.name || '').toLowerCase()
    if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return true
    if (name.includes('water') || name.includes('lava')) return true
    const bb = String(block.boundingBox || '').toLowerCase()
    if (bb === 'empty') return true
    return false
  } catch {
    return true
  }
}

function blockIsSolidSupport (block) {
  try {
    if (!block) return false
    if (blockIsPassable(block)) return false
    return true
  } catch {
    return false
  }
}

function collectSpaceProfile (bot, args = {}) {
  try {
    const me = bot.entity?.position
    if (!me) return null
    const center = me.floored()
    const radiusRaw = parseInt(args.radius || '8', 10)
    const r = Math.max(3, Math.min(12, Number.isFinite(radiusRaw) ? radiusRaw : 8))

    const readCell = (x, y, z) => {
      const p = center.offset(x, y, z)
      const block = bot.blockAt(p)
      return { p, block }
    }

    const stats = {
      samples: 0,
      walkable: 0,
      withRoof: 0,
      boundary: { total: 0, blocked: 0 }
    }

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const floor = readCell(dx, -1, dz).block
        const feet = readCell(dx, 0, dz).block
        const head = readCell(dx, 1, dz).block
        const roof = readCell(dx, 2, dz).block
        const walkable = blockIsSolidSupport(floor) && blockIsPassable(feet) && blockIsPassable(head)
        stats.samples += 1
        if (walkable) stats.walkable += 1
        if (!blockIsPassable(roof)) stats.withRoof += 1

        if (Math.abs(dx) === r || Math.abs(dz) === r) {
          stats.boundary.total += 1
          if (!blockIsPassable(feet) || !blockIsPassable(head)) stats.boundary.blocked += 1
        }
      }
    }

    const ray = (dx, dz) => {
      for (let i = 1; i <= r; i++) {
        const feet = readCell(dx * i, 0, dz * i).block
        const head = readCell(dx * i, 1, dz * i).block
        if (!blockIsPassable(feet) || !blockIsPassable(head)) {
          return {
            distance: i,
            block: String((!blockIsPassable(feet) ? feet?.name : head?.name) || 'unknown')
          }
        }
      }
      return { distance: null, block: null }
    }

    const walls = {
      east: ray(1, 0),
      west: ray(-1, 0),
      south: ray(0, 1),
      north: ray(0, -1)
    }

    const wallDistances = Object.values(walls).map(w => w.distance).filter(Number.isFinite)
    const nearestWall = wallDistances.length ? Math.min(...wallDistances) : null
    const wallKnownRaw = Object.values(walls).every(w => Number.isFinite(w.distance))
    // If all "walls" are within 1 block, it's usually nearby furniture/utility blocks, not real room boundaries.
    const wallKnown = wallKnownRaw && Number.isFinite(nearestWall) && nearestWall >= 2
    const width = wallKnown ? (walls.east.distance + walls.west.distance - 1) : null
    const depth = wallKnown ? (walls.north.distance + walls.south.distance - 1) : null
    const squareLike = (Number.isFinite(width) && Number.isFinite(depth))
      ? (Math.abs(width - depth) <= 1 && width >= 4 && depth >= 4)
      : false

    const walkableRatio = stats.samples > 0 ? stats.walkable / stats.samples : 0
    const roofRatio = stats.samples > 0 ? stats.withRoof / stats.samples : 0
    const boundaryBlockedRatio = stats.boundary.total > 0 ? stats.boundary.blocked / stats.boundary.total : 0

    const enclosureScore = Math.max(0, Math.min(1,
      (wallKnown ? 0.35 : 0) +
      (boundaryBlockedRatio * 0.35) +
      (roofRatio * 0.30)
    ))

    let kind = 'semi_enclosed'
    let label = '半开放区域'
    let confidence = Math.max(0.35, enclosureScore)

    if (enclosureScore >= 0.68 && squareLike) {
      kind = 'square_room'
      label = '近似正方形室内空间'
      confidence = Math.max(confidence, 0.82)
    } else if (enclosureScore >= 0.62) {
      kind = 'room'
      label = '室内空间'
      confidence = Math.max(confidence, 0.72)
    } else if (boundaryBlockedRatio < 0.25 && roofRatio < 0.25) {
      kind = 'open_outdoor'
      label = '开阔室外区域'
      confidence = Math.max(confidence, 0.7)
    } else {
      const longX = (Number.isFinite(width) && Number.isFinite(depth)) ? (width >= depth * 1.8) : false
      const longZ = (Number.isFinite(width) && Number.isFinite(depth)) ? (depth >= width * 1.8) : false
      if ((longX || longZ) && enclosureScore >= 0.45) {
        kind = 'corridor_like'
        label = '走廊状空间'
        confidence = Math.max(confidence, 0.66)
      }
    }

    const signs = collectNearbySigns(bot, { radius: r, max: 64 })
    const containerPos = bot.findBlocks({
      matching: (b) => b && isContainerNameMatch(b.name, 'any'),
      maxDistance: Math.max(2, r),
      count: 64
    }) || []

    return {
      center: { x: center.x, y: center.y, z: center.z },
      probeRadius: r,
      environment: { kind, label, confidence: Number(confidence.toFixed(2)) },
      geometry: {
        wallKnown,
        wallKnownRaw,
        nearestWall,
        squareLike,
        width,
        depth,
        walls
      },
      metrics: {
        walkableRatio: Number(walkableRatio.toFixed(3)),
        roofRatio: Number(roofRatio.toFixed(3)),
        boundaryBlockedRatio: Number(boundaryBlockedRatio.toFixed(3)),
        enclosureScore: Number(enclosureScore.toFixed(3))
      },
      anchors: {
        signCount: signs.length,
        signWithTextCount: signs.filter(x => x.text).length,
        containerCount: containerPos.length
      }
    }
  } catch {
    return null
  }
}

function collectAnimals (bot, range = 16, species = null) {
  try {
    const me = bot.entity?.position
    if (!me) return { count: 0, nearest: null, list: [] }
    const want = species ? String(species).toLowerCase() : null
    const matches = (s) => {
      const text = String(s || '').toLowerCase()
      if (!text) return false
      if (want === 'cat' || want === 'cats' || want === '猫') {
        return text.includes('cat') || text.includes('猫')
      }
      if (!s) return false
      if (want) {
        if (want === 'cow' || want === 'cows') {
          // English + common Chinese aliases
          return text.includes('cow') || text.includes('mooshroom') || text.includes('奶牛') || text.includes('蘑菇牛') || text.includes('牛')
        }
        return text.includes(want)
      }
      // broad passive set (common farm animals)
      const en = ['cow','mooshroom','sheep','pig','chicken','horse','donkey','mule','llama','camel','goat','cat','wolf','fox','rabbit']
      const cn = ['奶牛','蘑菇牛','牛','绵羊','羊','猪','鸡','马','驴','骡','羊驼','骆驼','山羊','猫','狼','狐狸','兔','兔子']
      return en.some(t => text.includes(t)) || cn.some(t => text.includes(t))
    }
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      try {
        if (!e || !e.position) continue
        // Exclude players; accept all other types (animal/passive/mob/object variants)
        const et = String(e.type || '').toLowerCase()
        if (et === 'player') continue
        const info = entityNameProfile(e)
        if (!matches(info.searchable)) continue
        const d = e.position.distanceTo(me)
        if (Number.isFinite(d) && d <= range) {
          list.push({
            id: e.id,
            type: e.type,
            kind: e.kind || null,
            name: info.title,
            entityName: info.base || null,
            displayName: info.display || null,
            customName: info.custom || null,
            d: Number(d.toFixed(2))
          })
        }
      } catch {}
    }
    if (!list.length) return { count: 0, nearest: null, list: [] }
    list.sort((a, b) => a.d - b.d)
    return { count: list.length, nearest: list[0], list }
  } catch { return { count: 0, nearest: null, list: [] } }
}

function collectInventorySummary (bot, top = 6) {
  try {
    const inv = bot.inventory?.items() || []
    const held = bot.heldItem ? itemBriefName(bot, bot.heldItem) : null
    const offhand = (() => { try { return itemBriefName(bot, bot.inventory?.slots?.[45]) } catch { return null } })()
    const armor = {
      head: (() => { try { return itemBriefName(bot, bot.inventory?.slots?.[5]) } catch { return null } })(),
      chest: (() => { try { return itemBriefName(bot, bot.inventory?.slots?.[6]) } catch { return null } })(),
      legs: (() => { try { return itemBriefName(bot, bot.inventory?.slots?.[7]) } catch { return null } })(),
      feet: (() => { try { return itemBriefName(bot, bot.inventory?.slots?.[8]) } catch { return null } })()
    }
    const mcData = ensureMcData(bot)
    const foodsByName = mcData?.foodsByName || {}
    let foodCount = 0
    const byBaseName = new Map()
    const byKey = new Map()
    for (const it of inv) {
      const baseName = it.name || String(it.type)
      const label = itemCustomLabel(bot, it)
      const key = `${baseName}\u0000${label || ''}`
      const prev = byKey.get(key) || { name: baseName, label: label || null, count: 0 }
      prev.count += (it.count || 0)
      byKey.set(key, prev)

      byBaseName.set(baseName, (byBaseName.get(baseName) || 0) + (it.count || 0))
      if (foodsByName[baseName]) foodCount += it.count || 0
    }
    const tiers = ['netherite','diamond','iron','stone','golden','wooden']
    let bestPick = null
    for (const t of tiers) { const key = `${t}_pickaxe`; if (byBaseName.get(key)) { bestPick = key; break } }
    const allSorted = Array.from(byKey.values()).sort((a, b) => (b.count || 0) - (a.count || 0))
    const rows = allSorted.slice(0, Math.max(1, top))
    return { held, offhand, armor, top: rows, all: allSorted, foodCount, bestPick }
  } catch { return { held: null, top: [], foodCount: 0, bestPick: null } }
}

function collectHotbar (bot) {
  try {
    const slots = bot.inventory?.slots || []
    const names = []
    for (let i = 36; i <= 44; i++) {
      const it = slots[i]
      if (it && it.name) names.push({ slot: i - 36, name: it.name, label: itemCustomLabel(bot, it), count: it.count || 0 })
    }
    return names
  } catch { return [] }
}

  function collectBlocks (bot) {
  try {
    const pos = bot.entity?.position
    const under = pos ? bot.blockAt(pos.offset(0, -1, 0)) : null
    let look = null
    try {
      const r = bot.blockAtCursor?.(5)
      // mineflayer.blockAtCursor may return a Block or { block, face, ... }
      const b = (r && r.name) ? r : (r && r.block) ? r.block : null
      look = b || null
    } catch {}
    return { under: under ? under.name : null, look: look ? look.name : null }
  } catch { return { under: null, look: null } }
}

function collectEnv (bot) {
  try {
    const pos = bot.entity?.position
    const here = pos ? bot.blockAt(pos) : null
    const rainLevel = Number(bot.rainState)
    const thunderLevel = Number(bot.thunderState)
    const raining = Number.isFinite(rainLevel) ? rainLevel > 0 : Boolean(bot.isRaining)
    const storming = Number.isFinite(thunderLevel) ? thunderLevel > 0 : false
    // Use rain/thunder states because modern servers emit level_change packets instead of start/stop events.
    const weather = storming && raining ? '雷雨' : (raining ? '下雨' : '晴')
    // Note: biome intentionally omitted from prompt context per policy
    return { weather }
  } catch { return { weather: '' } }
}

function collectVitals (bot) {
  try {
    const hp = bot.health ?? null
    const food = bot.food ?? null
    const sat = bot.foodSaturation ?? null
    return { hp, food, saturation: sat }
  } catch { return { hp: null, food: null, saturation: null } }
}

function snapshot (bot, opts = {}) {
  const now = Date.now()
  const pos = (() => { try { const p = bot.entity?.position?.floored?.() || bot.entity?.position; return p ? { x: p.x, y: p.y, z: p.z } : null } catch { return null } })()
  const dim = dimName(bot)
  const tod = timeBrief(bot)
  const env = collectEnv(bot)
  const vitals = collectVitals(bot)
  const inv = collectInventorySummary(bot, Math.max(1, opts.invTop || 6))
  const hotbar = collectHotbar(bot)
  const players = collectNearbyPlayers(bot, Math.max(1, opts.nearPlayerRange || 16), Math.max(0, opts.nearPlayerMax || 5))
  const drops = collectDrops(bot, Math.max(1, opts.dropsRange || 8), Math.max(0, opts.dropsMax || 6))
  const hostiles = collectHostiles(bot, Math.max(1, opts.hostileRange || 24))
  const blocks = collectBlocks(bot)
  // Current task from shared state (if any)
  const task = (bot.state && bot.state.currentTask) ? { name: bot.state.currentTask.name, source: bot.state.currentTask.source, startedAt: bot.state.currentTask.startedAt } : null
  return { t: now, pos, dim, time: tod, env, vitals, inv, hotbar, nearby: { players, drops, hostiles }, blocks, task }
}

function toPrompt (snap) {
  try {
    if (!snap) return ''
    const parts = []
    if (snap.task && snap.task.name) {
      const src = snap.task.source === 'player' ? '玩家命令' : '自动'
      parts.push(`任务:${snap.task.name}(${src})`)
    }
    const pos = snap.pos ? `位置:${snap.pos.x},${snap.pos.y},${snap.pos.z}` : null
    if (pos) parts.push(pos)
    parts.push(`维度:${snap.dim}`)
    if (snap.time) parts.push(`时间:${snap.time}`)
    if (snap.env?.weather && snap.env.weather !== '晴') parts.push(`天气:${snap.env.weather}`)
    const v = snap.vitals || {}
    const vParts = []
    if (v.hp != null) vParts.push(`HP:${Math.round(v.hp)}`)
    if (v.food != null) vParts.push(`饥饿:${v.food}`)
    if (vParts.length) parts.push(vParts.join('/'))
    const npl = snap.nearby?.players || []
    if (npl.length) parts.push('玩家:' + npl.map(x => `${x.name}@${fmtNum(x.d)}m`).join(','))
    const hs = snap.nearby?.hostiles || { count: 0, nearest: null }
    if (hs.count && hs.nearest) parts.push(`敌对:${hs.count}(${hs.nearest.name}@${fmtNum(hs.nearest.d)}m)`)
    else if (hs.count) parts.push(`敌对:${hs.count}`)
    const dr = snap.nearby?.drops || []
    if (dr.length) parts.push(`掉落:${dr.length}个`)
    const inv = snap.inv || {}
    const invAll = Array.isArray(inv.all) ? inv.all : (Array.isArray(inv.top) ? inv.top : [])
    if (invAll.length) {
      const maxShow = 24
      const shown = invAll.slice(0, maxShow).map(it => `${it.name}${it.label ? `「${it.label}」` : ''}x${it.count}`).join(',')
      const suffix = invAll.length > maxShow ? `,…+${invAll.length - maxShow}种` : ''
      parts.push(`背包:${shown}${suffix}`)
    }
    const hands = []
    if (inv.held && inv.held !== '无') hands.push(`主手:${inv.held}`)
    if (inv.offhand && inv.offhand !== '无') hands.push(`副手:${inv.offhand}`)
    if (hands.length) parts.push(hands.join('|'))
    const ar = inv.armor || {}
    const arParts = []
    if (ar.head && ar.head !== '无') arParts.push(`头:${ar.head}`)
    if (ar.chest && ar.chest !== '无') arParts.push(`胸:${ar.chest}`)
    if (ar.legs && ar.legs !== '无') arParts.push(`腿:${ar.legs}`)
    if (ar.feet && ar.feet !== '无') arParts.push(`脚:${ar.feet}`)
    if (arParts.length) parts.push('装备:' + arParts.join(','))
    const bl = snap.blocks || {}
    if (bl.under) parts.push(`脚下:${bl.under}`)
    if (bl.look) parts.push(`准星:${bl.look}`)
    return '游戏: ' + parts.filter(Boolean).join(' | ')
  } catch { return '' }
}

function normalizeContainerType (raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return 'any'
  if (['any', 'auto', 'default', 'all', '任意', '随便'].includes(s)) return 'any'
  if (['chest', 'box', '箱子', '箱'].includes(s)) return 'chest'
  if (['barrel', '木桶', '桶'].includes(s)) return 'barrel'
  if (['ender_chest', 'enderchest', 'ender-chest', 'ender chest', 'ender', '末影箱', '末影'].includes(s)) return 'ender_chest'
  if (['shulker_box', 'shulkerbox', 'shulker-box', 'shulker box', 'shulker', '潜影箱', '潜影盒', '潜影'].includes(s)) return 'shulker_box'
  return 'any'
}

function containerGroupFromName (name) {
  const s = String(name || '').toLowerCase()
  if (s === 'chest' || s === 'trapped_chest') return 'chest'
  if (s === 'barrel') return 'barrel'
  if (s === 'ender_chest') return 'ender_chest'
  if (s === 'shulker_box' || s.endsWith('_shulker_box')) return 'shulker_box'
  return 'other'
}

function containerTypeLabel (type) {
  if (type === 'chest') return '箱子'
  if (type === 'barrel') return '木桶'
  if (type === 'ender_chest') return '末影箱'
  if (type === 'shulker_box') return '潜影箱'
  return '容器'
}

function isContainerNameMatch (name, containerType = 'any') {
  const s = String(name || '').toLowerCase()
  if (containerType === 'chest') return (s === 'chest' || s === 'trapped_chest')
  if (containerType === 'barrel') return s === 'barrel'
  if (containerType === 'ender_chest') return s === 'ender_chest'
  if (containerType === 'shulker_box') return (s === 'shulker_box' || s.endsWith('_shulker_box'))
  return (s === 'chest' || s === 'trapped_chest' || s === 'barrel' || s === 'ender_chest' || s === 'shulker_box' || s.endsWith('_shulker_box'))
}

function containerItems (container) {
  try {
    if (typeof container?.containerItems === 'function') {
      const items = container.containerItems()
      if (Array.isArray(items)) return items.filter(it => it && Number(it.count) > 0)
    }
  } catch {}
  const out = []
  try {
    const invStart = Number(container?.inventoryStart)
    const limit = Number.isFinite(invStart) ? Math.max(0, invStart) : 0
    const slots = Array.isArray(container?.slots) ? container.slots : []
    for (let i = 0; i < limit; i++) {
      const it = slots[i]
      if (it && Number(it.count) > 0) out.push(it)
    }
  } catch {}
  return out
}

function summarizeItems (bot, items, maxKinds = 24) {
  const byKey = new Map()
  for (const it of (Array.isArray(items) ? items : [])) {
    try {
      if (!it || Number(it.count) <= 0) continue
      const name = String(it.name || it.type || 'unknown')
      const label = itemCustomLabel(bot, it)
      const key = `${name}\u0000${label || ''}`
      const prev = byKey.get(key) || { name, label: label || null, count: 0 }
      prev.count += Number(it.count) || 0
      byKey.set(key, prev)
    } catch {}
  }
  const all = Array.from(byKey.values()).sort((a, b) => (b.count || 0) - (a.count || 0))
  return {
    total: all.reduce((sum, it) => sum + (it.count || 0), 0),
    kinds: all.length,
    items: all.slice(0, Math.max(1, maxKinds)),
    all
  }
}

async function openContainerReadOnly (bot, block) {
  if (!block) return { container: null, error: 'missing_block', method: null }

  async function wait (ms) {
    return await new Promise(resolve => setTimeout(resolve, ms))
  }

  async function withTimeout (label, fn, timeoutMs = 3500) {
    let timer = null
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout:${label}:${timeoutMs}ms`)), timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const errors = []
  const blockName = String(block.name || '').toLowerCase()
  if (blockName === 'ender_chest' && typeof bot.openEnderChest !== 'function') {
    errors.push('openEnderChest API unavailable on this bot version')
  }
  const openers = []
  if (blockName === 'ender_chest' && typeof bot.openEnderChest === 'function') {
    openers.push({ method: 'openEnderChest(block)', fn: async () => await bot.openEnderChest(block) })
    openers.push({ method: 'openEnderChest()', fn: async () => await bot.openEnderChest() })
  }
  if (typeof bot.openContainer === 'function') {
    openers.push({ method: 'openContainer(block)', fn: async () => await bot.openContainer(block) })
  }
  if (typeof bot.openChest === 'function') {
    openers.push({ method: 'openChest(block)', fn: async () => await bot.openChest(block) })
  }
  if (typeof bot.activateBlock === 'function') {
    openers.push({
      method: 'activateBlock+currentWindow',
      fn: async () => {
        await bot.activateBlock(block)
        await wait(260)
        const win = bot.currentWindow
        if (!win || !Array.isArray(win.slots)) throw new Error('currentWindow_unavailable')
        if (typeof win.close !== 'function') {
          win.close = () => {
            try {
              if (typeof bot.closeWindow === 'function') bot.closeWindow(win)
            } catch {}
          }
        }
        return win
      }
    })
  }
  if (!openers.length) return { container: null, error: 'no_open_api', method: null }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (bot.currentWindow && typeof bot.closeWindow === 'function') {
        try { bot.closeWindow(bot.currentWindow) } catch {}
        await wait(60)
      }
      try { await bot.lookAt?.(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
      if (attempt >= 2 && typeof bot.activateBlock === 'function') {
        try { await bot.activateBlock(block) } catch (e) { errors.push(`activateBlock:${String(e?.message || e)}`) }
        await wait(140)
      }

      for (const opener of openers) {
        try {
          const container = await withTimeout(opener.method, opener.fn, 3500)
          if (container) return { container, error: null, method: opener.method }
          errors.push(`${opener.method}:empty_result`)
        } catch (e) {
          errors.push(`${opener.method}:${String(e?.message || e)}`)
        }
      }
    } catch (e) {
      errors.push(`attempt_${attempt}:${String(e?.message || e)}`)
    }
    await wait(120)
  }

  return {
    container: null,
    method: null,
    error: errors.length ? errors[errors.length - 1] : 'open_failed',
    errors
  }
}

async function detailContainers (bot, args = {}) {
  const me = bot.entity?.position
  if (!me) return { ok: false, msg: '未就绪', data: null }
  const radius = Math.max(1, parseInt(args.radius || '16', 10))
  const max = Math.max(1, parseInt(args.max || '12', 10))
  const itemMax = Math.max(1, parseInt(args.itemMax || args.items || '24', 10))
  const full = String(args.full || '').toLowerCase() === 'true'
  const containerType = normalizeContainerType(args.containerType ?? args.container ?? args.type)
  const count = Math.max(max * 4, max)
  const positions = bot.findBlocks({
    matching: (b) => b && isContainerNameMatch(b.name, containerType),
    maxDistance: Math.max(2, radius),
    count: Math.min(128, count)
  }) || []

  if (!positions.length) return { ok: true, msg: `附近没有${containerTypeLabel(containerType)}(半径${radius})`, data: [] }

  positions.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  const rows = []

  for (const pos of positions.slice(0, max)) {
    const block = bot.blockAt(pos)
    if (!block || !isContainerNameMatch(block.name, containerType)) continue
    const row = {
      containerType: containerGroupFromName(block.name),
      blockName: String(block.name || ''),
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      d: Number(block.position.distanceTo(me).toFixed(2)),
      ok: false,
      kinds: 0,
      total: 0,
      items: []
    }
    let container = null
    let openMeta = null
    try {
      openMeta = await openContainerReadOnly(bot, block)
      container = openMeta?.container || null
      if (!container) {
        row.error = openMeta?.error || 'open_failed'
        if (Array.isArray(openMeta?.errors) && openMeta.errors.length) row.openErrors = openMeta.errors
        rows.push(row)
        continue
      }
      row.openMethod = openMeta?.method || null
      const items = containerItems(container)
      const summarized = summarizeItems(bot, items, itemMax)
      row.ok = true
      row.kinds = summarized.kinds
      row.total = summarized.total
      row.items = summarized.items
      if (full) row.allItems = summarized.all
      rows.push(row)
    } catch (e) {
      row.error = String(e?.message || e)
      rows.push(row)
    } finally {
      try { container?.close?.() } catch {}
    }
  }

  const okCount = rows.filter(r => r.ok).length
  const failCount = rows.length - okCount
  const msg = `附近${containerTypeLabel(containerType)}${rows.length}个(半径${radius})，读取成功${okCount}个${failCount > 0 ? `，失败${failCount}个` : ''}`
  return { ok: true, msg, data: rows }
}

function detail (bot, args = {}) {
  const what = String(args.what || 'entities').toLowerCase()
  const radius = Math.max(1, parseInt(args.radius || '16', 10))
  const max = Math.max(1, parseInt(args.max || '24', 10))
  const me = bot.entity?.position
  if (!me) return { ok: false, msg: '未就绪', data: null }
  if (what === 'containers' || what === 'container' || what === 'chests' || what === 'boxes' || what === 'container_contents' || what === 'chest_contents') {
    return detailContainers(bot, args)
  }
  if (what === 'players') {
    const list = []
    for (const [name, rec] of Object.entries(bot.players || {})) {
      try {
        const e = rec?.entity; if (!e || e === bot.entity) continue
        const d = e.position.distanceTo(me)
        if (d > radius) continue
        list.push({ name, d: Number(d.toFixed(2)) })
      } catch {}
    }
    list.sort((a, b) => a.d - b.d)
    return { ok: true, msg: `附近玩家${list.length}个(半径${radius})`, data: list.slice(0, max) }
  }
  if (what === 'hostiles') {
    const hs = hostileSet()
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      try {
        if (e?.type !== 'mob' || !e.position) continue
        const nm = (e.name || e.displayName || '').toLowerCase()
        if (!hs.has(nm)) continue
        const d = e.position.distanceTo(me)
        if (d > radius) continue
        list.push({ name: nm, d: Number(d.toFixed(2)) })
      } catch {}
    }
    list.sort((a, b) => a.d - b.d)
    return { ok: true, msg: `附近敌对${list.length}个(半径${radius})`, data: list.slice(0, max) }
  }
  if (what === 'entities') {
    const species = String(args.species || args.entity || '').trim().toLowerCase()
    const match = String(args.match || '').trim().toLowerCase()
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      try {
        if (!e?.position) continue
        const d = e.position.distanceTo(me)
        if (d > radius) continue
        const info = entityNameProfile(e)
        const text = info.searchable
        if (species && !text.includes(species)) continue
        if (match && !text.includes(match)) continue
        list.push({
          id: e.id,
          type: e.type,
          kind: e.kind || null,
          name: info.title || null,
          entityName: info.base || null,
          displayName: info.display || null,
          customName: info.custom || null,
          d: Number(d.toFixed(2))
        })
      } catch {}
    }
    list.sort((a, b) => a.d - b.d)
    return { ok: true, msg: `附近实体${list.length}个(半径${radius})`, data: list.slice(0, max) }
  }
  if (what === 'nearby_entities') {
    return detail(bot, { ...args, what: 'entities' })
  }
  if (what === 'animals' || what === 'passives') {
    const r = collectAnimals(bot, radius, null)
    return { ok: true, msg: `附近动物${r.count}个(半径${radius})`, data: r.list.slice(0, max) }
  }
  if (what === 'cats' || what === 'cat') {
    const r = collectAnimals(bot, radius, 'cat')
    return { ok: true, msg: `附近猫${r.count}只(半径${radius})`, data: r.list.slice(0, max) }
  }
  if (what === 'signs' || what === 'sign' || what === 'signboard' || what === 'boards') {
    const list = collectNearbySigns(bot, { radius, max })
    const withText = list.filter(x => x.text)
    return {
      ok: true,
      msg: `附近告示牌${list.length}个(半径${radius})，有内容${withText.length}个`,
      data: list
    }
  }
  if (what === 'space' || what === 'space_snapshot' || what === 'room_probe' || what === 'environment') {
    const profile = collectSpaceProfile(bot, args)
    if (!profile) return { ok: false, msg: '空间探测失败', data: null }
    const env = profile.environment || {}
    const geo = profile.geometry || {}
    const m = profile.metrics || {}
    const msg = `环境=${env.label || env.kind || '未知'} 置信=${Math.round((env.confidence || 0) * 100)}% 封闭=${Math.round((m.enclosureScore || 0) * 100)}% 顶盖=${Math.round((m.roofRatio || 0) * 100)}% 边界阻挡=${Math.round((m.boundaryBlockedRatio || 0) * 100)}% ${Number.isFinite(geo.width) && Number.isFinite(geo.depth) ? `尺寸≈${geo.width}x${geo.depth}` : ''}`.trim()
    return { ok: true, msg, data: profile }
  }
  if (what === 'inventory' || what === 'inv' || what === 'bag') {
    const inv = collectInventorySummary(bot, 999)
    const all = Array.isArray(inv.all) ? inv.all : []
    const line = all.length ? all.map(it => `${it.name}${it.label ? `「${it.label}」` : ''}x${it.count}`).join(', ') : '空'
    return { ok: true, msg: `背包物品(${all.length}种): ${line}`, data: inv }
  }
  if (what === 'cows' || what === 'cow') {
    const r = collectAnimals(bot, radius, 'cow')
    return { ok: true, msg: `附近奶牛${r.count}头(半径${radius})`, data: r.list.slice(0, max) }
  }
  if (what === 'blocks') {
    const list = []
    const center = me.floored()
    const r = Math.min(radius, 8) // hard cap to keep it light
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          try {
            const p = center.offset(dx, dy, dz)
            const b = bot.blockAt(p)
            if (!b) continue
            const n = String(b.name || '')
            if (!n || n === 'air') continue
            const d = p.distanceTo(me)
            list.push({ name: n, x: p.x, y: p.y, z: p.z, d: Number(d.toFixed(2)) })
          } catch {}
        }
      }
    }
    list.sort((a, b) => a.d - b.d)
    return { ok: true, msg: `附近方块${list.length}个(半径${r})`, data: list.slice(0, max) }
  }
  return { ok: false, msg: '未知类别', data: null }
}

function affordances (bot, snap = null) {
  try {
    const s = snap || snapshot(bot, {})
    const a = []
    const inv = s.inv || {}
    const byName = new Map()
    for (const it of (inv.top || [])) {
      const n = String(it?.name || '')
      if (!n) continue
      byName.set(n, (byName.get(n) || 0) + (it.count || 0))
    }
    const has = (n) => (byName.get(n) || 0) > 0
    // Suggest crafting torches if low and materials present
    if ((inv.torch || 0) < 8 && (has('coal') || has('charcoal')) && (has('stick') || (has('oak_planks') && (inv.foodCount || 0) >= 0))) {
      a.push({ tool: 'craft', argsHint: { item: 'torch', qty: 8 } })
    }
    // Suggest gather planks if none
    if (!has('oak_planks')) {
      a.push({ tool: 'gather', argsHint: { item: 'oak_planks', qty: 16 } })
    }
    return a
  } catch { return [] }
}

module.exports = { snapshot, toPrompt, detail, affordances }
