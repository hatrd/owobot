// Auto-craft iron armor when conditions meet:
// - Inventory has iron_ingot(s)
// - Current armor is missing or worse than iron
// - A crafting_table exists nearby (within radius)
// - No higher-priority external action is running

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  const L = log || { info: (...a) => console.log('[AUTOARMOR]', ...a), debug: (...a) => dlog && dlog(...a), warn: (...a) => console.warn('[AUTOARMOR]', ...a) }

  const S = state.autoArmor = state.autoArmor || {}
  const cfg = S.cfg = Object.assign({ enabled: true, tickMs: 10000, radius: 8, debug: false }, S.cfg || {})
  let timer = null
  let running = false
  // Material rank (lower = better)
  const ORDER = ['netherite','diamond','iron','chainmail','turtle','golden','leather']
  function matRank (mat) { const i = ORDER.indexOf(String(mat||'').toLowerCase()); return i >= 0 ? i : ORDER.length }
  function armorMat (name) { if (!name) return null; if (name === 'turtle_helmet') return 'turtle'; const p = String(name).toLowerCase().split('_'); return p.length >= 2 ? p[0] : null }
  function armorKind (name) { if (!name) return null; if (name === 'turtle_helmet') return 'turtle_helmet'; const p = String(name).toLowerCase().split('_'); return p.length >= 2 ? p.slice(1).join('_') : null }

  function invCount (n) { try { const nm = String(n).toLowerCase(); return (bot.inventory?.items()||[]).filter(it => String(it.name||'').toLowerCase()===nm).reduce((a,b)=>a+(b.count||0),0) } catch { return 0 } }
  function invFind (pred) { try { return (bot.inventory?.items()||[]).find(pred) || null } catch { return null } }
  function equippedName (slotIdx) { try { return String(bot.inventory?.slots?.[slotIdx]?.name || '').toLowerCase() || null } catch { return null } }

  function needArmorSlots () {
    // slots index in inventory: head=5, chest=6, legs=7, feet=8
    const ironRank = matRank('iron')
    const slots = [
      { slot: 'head',   idx: 5, kind: 'helmet' },
      { slot: 'torso',  idx: 6, kind: 'chestplate' },
      { slot: 'legs',   idx: 7, kind: 'leggings' },
      { slot: 'feet',   idx: 8, kind: 'boots' }
    ]
    const out = []
    for (const s of slots) {
      const cur = equippedName(s.idx)
      const curMat = armorMat(cur)
      if (!cur) { out.push(s); continue }
      if (matRank(curMat) > ironRank) { out.push(s); continue } // worse than iron
      // if equal/better than iron, skip crafting for this slot
    }
    return out
  }

  function findCraftingTable (radius) {
    try {
      return bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: Math.max(2, radius) }) || null
    } catch { return null }
  }

  function ensurePathfinder () {
    try {
      const pf = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pf.pathfinder)
      const mcData = bot.mcData || require('minecraft-data')(bot.version)
      const m = new pf.Movements(bot, mcData)
      m.canDig = true; m.allowSprinting = true
      bot.pathfinder.setMovements(m)
      return pf
    } catch (e) { L.warn('pathfinder missing:', e?.message || e); return null }
  }

  async function gotoNear (pos, range = 1) {
    const pf = ensurePathfinder(); if (!pf) return false
    const { goals } = pf
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(0, range)), true)
      const until = Date.now() + 6000
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 100))
        const me = bot.entity?.position; if (!me) break
        if (me.distanceTo(pos) <= (range + 1.2)) break
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      return true
    } catch { return false }
  }

  async function craftOne (itemName, tableBlock) {
    try {
      const mcData = bot.mcData || require('minecraft-data')(bot.version)
      const item = mcData?.itemsByName?.[itemName]
      if (!item) return false
      const recs = bot.recipesFor(item.id, null, 1, tableBlock) || []
      if (!recs.length) return false
      const r = recs[0]
      await bot.craft(r, 1, tableBlock)
      return true
    } catch { return false }
  }

  async function ensureEquipped (name, dest) { try { const it = invFind(it => String(it?.name||'').toLowerCase()===name); if (!it) return false; await bot.equip(it, dest); return true } catch { return false } }

  async function maybeCraftIronArmor () {
    if (!cfg.enabled) { if (cfg.debug) L.debug('skip: disabled'); return }
    if (!bot.entity || !bot.entity.position) { if (cfg.debug) L.debug('skip: not ready'); return }
    if (state.externalBusy) { if (cfg.debug) L.debug('skip: externalBusy'); return }
    if (bot.currentWindow) { if (cfg.debug) L.debug('skip: in window'); return }

    const iron = invCount('iron_ingot')
    if (iron <= 0) { if (cfg.debug) L.debug('skip: no iron'); return }
    const lacking = needArmorSlots()
    if (!lacking.length) { if (cfg.debug) L.debug('skip: armor already iron or better'); return }
    const table = findCraftingTable(cfg.radius)
    if (!table) { if (cfg.debug) L.debug('skip: no crafting table nearby'); return }
    // Approach the table
    try { await gotoNear(table.position, 1) } catch {}

    // Craft order: chestplate (8), leggings (7), helmet (5), boots (4)
    const PIECES = [
      { name: 'iron_chestplate', cost: 8, slot: 'torso' },
      { name: 'iron_leggings',   cost: 7, slot: 'legs'  },
      { name: 'iron_helmet',     cost: 5, slot: 'head'  },
      { name: 'iron_boots',      cost: 4, slot: 'feet'  }
    ]
    let remaining = invCount('iron_ingot')
    let crafted = 0
    try { if (state) state.currentTask = { name: 'auto_armor_craft', source: 'auto', startedAt: Date.now() } } catch {}
    for (const p of PIECES) {
      if (remaining < p.cost) continue
      // Only craft if that slot is in lacking list
      const needThis = lacking.some(s => s.slot === p.slot)
      if (!needThis) continue
      const ok = await craftOne(p.name, table)
      if (ok) {
        remaining -= p.cost
        crafted++
        // Equip immediately if possible
        await ensureEquipped(p.name, p.slot)
      } else if (cfg.debug) { L.debug('craft failed:', p.name) }
    }
    if (crafted > 0) L.info('crafted iron armor pieces:', crafted)
    try { if (state && state.currentTask && state.currentTask.name === 'auto_armor_craft') state.currentTask = null } catch {}
  }

  async function tick () {
    if (running) return
    running = true
    try { await maybeCraftIronArmor() } finally { running = false }
  }

  on('spawn', () => { setTimeout(() => tick().catch(() => {}), 800) })
  timer = setInterval(() => { tick().catch(() => {}) }, Math.max(3000, cfg.tickMs))
  registerCleanup && registerCleanup(() => { if (timer) { try { clearInterval(timer) } catch {} ; timer = null } })

  // CLI: .autoarmor on|off|status|interval ms|radius N|now|debug on|off
  on('cli', ({ cmd, args }) => {
    if (String(cmd||'').toLowerCase() !== 'autoarmor') return
    const sub = String(args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[AUTOARMOR] enabled'); break
      case 'off': cfg.enabled = false; console.log('[AUTOARMOR] disabled'); break
      case 'status': console.log('[AUTOARMOR] enabled=', cfg.enabled, 'tickMs=', cfg.tickMs, 'radius=', cfg.radius, 'debug=', cfg.debug); break
      case 'interval': cfg.tickMs = Math.max(3000, parseInt(val || '10000', 10)); console.log('[AUTOARMOR] tickMs=', cfg.tickMs); break
      case 'radius': cfg.radius = Math.max(2, parseInt(val || '8', 10)); console.log('[AUTOARMOR] radius=', cfg.radius); break
      case 'now': (async () => { try { await maybeCraftIronArmor() } catch {} })(); break
      case 'debug': cfg.debug = String(val||'on').toLowerCase() !== 'off'; console.log('[AUTOARMOR] debug=', cfg.debug); break
      default: console.log('[AUTOARMOR] usage: .autoarmor on|off|status|interval ms|radius N')
    }
  })
}

module.exports = { install }
