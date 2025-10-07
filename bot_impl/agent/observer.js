// Observer: provide lightweight game snapshot for prompts, and on-demand detailed fetchers

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
  return new Set(['creeper','zombie','skeleton','spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma_cube','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden'])
}

function collectHostiles (bot, range = 24) {
  try {
    const hs = hostileSet()
    const me = bot.entity?.position
    if (!me) return { count: 0, nearest: null }
    const list = []
    for (const e of Object.values(bot.entities || {})) {
      if (e?.type !== 'mob' || !e.position) continue
      const nm = (e.name || e.displayName || '').toLowerCase()
      if (!hs.has(nm)) continue
      const d = e.position.distanceTo(me)
      if (d <= range) list.push({ name: nm, d })
    }
    if (!list.length) return { count: 0, nearest: null }
    list.sort((a, b) => a.d - b.d)
    return { count: list.length, nearest: list[0] }
  } catch { return { count: 0, nearest: null } }
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
    try { const r = bot.blockAtCursor?.(5); look = r?.block || null } catch {}
    return { under: under ? under.name : null, look: look ? look.name : null }
  } catch { return { under: null, look: null } }
}

function collectEnv (bot) {
  try {
    const pos = bot.entity?.position
    const here = pos ? bot.blockAt(pos) : null
    const weather = (bot.isRaining ? '下雨' : '晴')
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
    // Current task line (if any)
    if (snap.task && snap.task.name) {
      const src = snap.task.source === 'player' ? '玩家命令' : '自动(背包)'
      parts.push(`当前任务:${snap.task.name} | 触发:${src}`)
    }
    const pos = snap.pos ? `位置:${snap.pos.x},${snap.pos.y},${snap.pos.z}` : '位置:未知'
    parts.push(pos)
    parts.push(`维度:${snap.dim}`)
    if (snap.time) parts.push(`时间:${snap.time}`)
    // Weather only (biome removed from context)
    if (snap.env?.weather) parts.push(`天气:${snap.env.weather}`)
    const v = snap.vitals || {}
    const vParts = []
    if (v.hp != null) vParts.push(`生命:${Math.round(v.hp)}/20`)
    if (v.food != null) vParts.push(`饥饿:${v.food}/20`)
    if (v.saturation != null) vParts.push(`饱和:${Number(v.saturation).toFixed ? Number(v.saturation).toFixed(1) : v.saturation}`)
    if (vParts.length) parts.push(vParts.join(' | '))
    // nearby players
    const npl = snap.nearby?.players || []
    parts.push(npl.length ? ('附近玩家: ' + npl.map(x => `${x.name}@${fmtNum(x.d)}m`).join(', ')) : '附近玩家: 无')
    // hostiles
    const hs = snap.nearby?.hostiles || { count: 0, nearest: null }
    parts.push(hs.count ? (`敌对: ${hs.count}个(最近${hs.nearest.name}@${fmtNum(hs.nearest.d)}m)`) : '敌对: 无')
    // drops
    const dr = snap.nearby?.drops || []
    parts.push(dr.length ? (`附近掉落物: ${dr.length}个, 最近=${fmtNum(dr[0].d)}m`) : '附近掉落物: 0个')
    // inventory: full aggregated items + hands + armor
    const inv = snap.inv || {}
    const invAll = Array.isArray(inv.all) ? inv.all : (Array.isArray(inv.top) ? inv.top : [])
    const invLine = invAll.length ? ('背包: ' + invAll.map(it => `${it.name}x${it.count}`).join(', ')) : '背包: 无'
    const handsLine = `主手: ${inv.held || '无'} | 副手: ${inv.offhand || '无'}`
    const ar = inv.armor || {}
    const armorLine = `装备: 头=${ar.head || '无'}, 胸=${ar.chest || '无'}, 腿=${ar.legs || '无'}, 脚=${ar.feet || '无'}`
    parts.push([invLine, handsLine, armorLine].filter(Boolean).join(' | '))
    // blocks
    const bl = snap.blocks || {}
    const a = bl.under ? `脚下:${bl.under}` : ''
    const b = bl.look ? `准星:${bl.look}` : ''
    const blLine = [a, b].filter(Boolean).join(' | ')
    if (blLine) parts.push(blLine)
    return '游戏上下文: ' + parts.filter(Boolean).join(' | ')
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
  if (what === 'inventory') {
    const inv = collectInventorySummary(bot, 999)
    return { ok: true, msg: `背包物品${inv.top.length}种`, data: inv }
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
