// Observer: provide lightweight game snapshot for prompts, and on-demand detailed fetchers

const HOSTILE_TOKENS_EN = ['creeper','zombie','zombie_villager','skeleton','spider','cave_spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden','piglin','piglin_brute']
const HOSTILE_TOKENS_CN = ['苦力怕','僵尸','骷髅','蜘蛛','洞穴蜘蛛','末影人','女巫','史莱姆','溺尸','尸壳','掠夺者','恼鬼','掠夺兽','幻翼','烈焰人','恶魂','岩浆怪','守卫者','远古守卫者','潜影贝','凋灵骷髅','疣猪兽','僵尸疣猪兽','流浪者','蠹虫','唤魔者','卫道士','监守者','猪灵','猪灵蛮兵']

function ensureMcData (bot) { try { if (!bot.mcData) bot.mcData = require('minecraft-data')(bot.version) } catch {} ; return bot.mcData }

function fmtNum (n) { return Number.isFinite(n) ? Number(n).toFixed(1) : String(n) }

function dimName (bot) { try { return bot.game?.dimension || 'overworld' } catch { return 'overworld' } }

function timeBrief (bot) { try { const tod = bot.time?.timeOfDay || 0; return (tod >= 13000 && tod <= 23000) ? '夜间' : '白天' } catch { return '' } }

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

  function collectAnimals (bot, range = 16, species = null) {
  try {
    const me = bot.entity?.position
    if (!me) return { count: 0, nearest: null, list: [] }
    const want = species ? String(species).toLowerCase() : null
    const matches = (nm) => {
      const s = String(nm || '').toLowerCase()
      if (!s) return false
      if (want) {
        if (want === 'cow' || want === 'cows') {
          // English + common Chinese aliases
          return s.includes('cow') || s.includes('mooshroom') || s.includes('奶牛') || s.includes('蘑菇牛') || s.includes('牛')
        }
        return s.includes(want)
      }
      // broad passive set (common farm animals)
      const en = ['cow','mooshroom','sheep','pig','chicken','horse','donkey','mule','llama','camel','goat','cat','wolf','fox','rabbit']
      const cn = ['奶牛','蘑菇牛','牛','绵羊','羊','猪','鸡','马','驴','骡','羊驼','骆驼','山羊','猫','狼','狐狸','兔','兔子']
      return en.some(t => s.includes(t)) || cn.some(t => s.includes(t))
    }
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      try {
        if (!e || !e.position) continue
        // Exclude players; accept all other types (animal/passive/mob/object variants)
        const et = String(e.type || '').toLowerCase()
        if (et === 'player') continue
        const raw = e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || ''
        const nm = String(raw).replace(/\u00a7./g, '').toLowerCase()
        if (!matches(nm)) continue
        const d = e.position.distanceTo(me)
        if (Number.isFinite(d) && d <= range) list.push({ name: nm, d: Number(d.toFixed(2)) })
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
    const held = bot.heldItem ? (bot.heldItem.name || String(bot.heldItem.type)) : null
    const offhand = (() => { try { return bot.inventory?.slots?.[45]?.name || null } catch { return null } })()
    const armor = {
      head: (() => { try { return bot.inventory?.slots?.[5]?.name || null } catch { return null } })(),
      chest: (() => { try { return bot.inventory?.slots?.[6]?.name || null } catch { return null } })(),
      legs: (() => { try { return bot.inventory?.slots?.[7]?.name || null } catch { return null } })(),
      feet: (() => { try { return bot.inventory?.slots?.[8]?.name || null } catch { return null } })()
    }
    const mcData = ensureMcData(bot)
    const foodsByName = mcData?.foodsByName || {}
    let foodCount = 0
    const byName = new Map()
    for (const it of inv) {
      const name = it.name || String(it.type)
      byName.set(name, (byName.get(name) || 0) + (it.count || 0))
      if (foodsByName[name]) foodCount += it.count || 0
    }
    const tiers = ['netherite','diamond','iron','stone','golden','wooden']
    let bestPick = null
    for (const t of tiers) { const key = `${t}_pickaxe`; if (byName.get(key)) { bestPick = key; break } }
    const allSorted = Array.from(byName.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ name: n, count: c }))
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
      if (it && it.name) names.push({ slot: i - 36, name: it.name, count: it.count || 0 })
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
      const shown = invAll.slice(0, maxShow).map(it => `${it.name}x${it.count}`).join(',')
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

function detail (bot, args = {}) {
  const what = String(args.what || 'entities').toLowerCase()
  const radius = Math.max(1, parseInt(args.radius || '16', 10))
  const max = Math.max(1, parseInt(args.max || '24', 10))
  const me = bot.entity?.position
  if (!me) return { ok: false, msg: '未就绪', data: null }
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
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      try {
        if (!e?.position) continue
        const d = e.position.distanceTo(me)
        if (d > radius) continue
        list.push({ id: e.id, type: e.type, name: e.name || e.displayName || null, kind: e.kind || null, d: Number(d.toFixed(2)) })
      } catch {}
    }
    list.sort((a, b) => a.d - b.d)
    return { ok: true, msg: `附近实体${list.length}个(半径${radius})`, data: list.slice(0, max) }
  }
  if (what === 'animals' || what === 'passives') {
    const r = collectAnimals(bot, radius, null)
    return { ok: true, msg: `附近动物${r.count}个(半径${radius})`, data: r.list.slice(0, max) }
  }
  if (what === 'inventory' || what === 'inv' || what === 'bag') {
    const inv = collectInventorySummary(bot, 999)
    const all = Array.isArray(inv.all) ? inv.all : []
    const line = all.length ? all.map(it => `${it.name}x${it.count}`).join(', ') : '空'
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
    const byName = new Map((inv.top || []).map(it => [String(it.name), it.count]))
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
