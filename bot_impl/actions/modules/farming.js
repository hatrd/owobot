const inventory = require('../lib/inventory')
const { ensureMcData } = require('../../lib/mcdata')

module.exports = function registerFarming (ctx) {
  const { bot, register, ok, fail, wait, assertCanEquipHand } = ctx
  const DEFAULT_INV_OPTS = {
    includeArmor: true,
    includeOffhand: true,
    includeHeld: true,
    includeMain: true,
    includeHotbar: true
  }
  function invCount (name) { return inventory.countItemByName(bot, name, DEFAULT_INV_OPTS) }
  async function ensureHandItem (name) { return inventory.ensureItemEquipped(bot, name, { assertCanEquipHand, includeArmor: true, includeOffhand: true, includeMain: true, includeHotbar: true }) }
  function ensurePathfinder () {
    const ok = ctx.ensurePathfinder()
    return ok ? ctx.pathfinder : null
  }

  async function feed_animals (args = {}) {
    const species = String(args.species || 'cow').toLowerCase()
    const itemName = String(args.item || (species === 'cow' || species === 'mooshroom' ? 'wheat' : 'wheat')).toLowerCase()
    const radius = Math.max(2, parseInt(args.radius || '12', 10))
    const rawMax = args.max
    const max = (rawMax == null || String(rawMax).toLowerCase() === 'all' || Number(rawMax) === 0)
      ? Infinity
      : Math.max(1, parseInt(rawMax, 10) || 1)
    const pkg = ensurePathfinder()
    if (!pkg) return fail('无寻路')
    const { Movements, goals } = pkg
    const mcData = ensureMcData(bot)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true; m.canDig = false
    bot.pathfinder.setMovements(m)

    function now () { return Date.now() }
    function isTargetSpecies (e) {
      try {
        if (!e || !e.position) return false
        const et = String(e.type || '').toLowerCase()
        if (et === 'player') return false
        const raw = e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || ''
        const n = String(raw).toLowerCase()
        if (species === 'cow') return n.includes('cow') || n.includes('mooshroom') || n.includes('奶牛') || n.includes('蘑菇牛') || n.includes('牛')
        return n.includes(species)
      } catch { return false }
    }
    function nearbyTargets () {
      try {
        const me = bot.entity?.position; if (!me) return []
        const list = []
        for (const e of Object.values(bot.entities || {})) {
          try {
            if (!isTargetSpecies(e) || !e.position) continue
            const d = me.distanceTo(e.position)
            if (!Number.isFinite(d) || d > radius) continue
            list.push({ e, d })
          } catch {}
        }
        list.sort((a, b) => a.d - b.d)
        return list.map(x => x.e)
      } catch { return [] }
    }

    const have = invCount(itemName)
    if (have <= 0) return fail(`缺少${itemName}`)

    let fed = 0
    const lockName = itemName
    let lockApplied = false
    try {
      if (bot.state && !bot.state.holdItemLock) {
        bot.state.holdItemLock = lockName
        lockApplied = true
      }
    } catch {}
    try {
      const start = now()
      while (fed < max && (now() - start) < 20000) {
        const list = nearbyTargets()
        if (!list.length) break
        for (const t of list) {
          if (fed >= max) break
          if (invCount(itemName) <= 0) break
          try { bot.pathfinder.setGoal(new goals.GoalFollow(t, 2.0), true) } catch {}
          const until = now() + 4000
          while (now() < until) {
            const cur = bot.entities?.[t.id]
            if (!cur || !cur.position) break
            const d = cur.position.distanceTo(bot.entity.position)
            if (d <= 3.0) break
            await wait(80)
          }
          try { bot.pathfinder.setGoal(null) } catch {}
          const before = invCount(itemName)
          const okEquip = await ensureHandItem(itemName)
          if (!okEquip) break
          try { await bot.lookAt((t.position && t.position.offset(0, 1.2, 0)) || bot.entity.position, true) } catch {}
          try { await bot.useOn(t) } catch {}
          await wait(350)
          const after = invCount(itemName)
          if (after < before) fed++
          if (fed >= max) break
        }
        if (fed === 0) await wait(200)
      }
    } finally {
      try { bot.pathfinder.setGoal(null) } catch {}
      try {
        if (lockApplied && bot.state && String(bot.state.holdItemLock || '').toLowerCase() === lockName) bot.state.holdItemLock = null
      } catch {}
    }
    return fed > 0 ? ok(`已喂食${fed}`) : fail('附近没有可喂食目标或缺少小麦')
  }

  async function harvest (args = {}) {
    const radius = Math.max(2, parseInt(args.radius || '12', 10))
    const onlyRaw = args.only ? String(args.only).toLowerCase() : null
    const replant = (args.replant !== false)
    const sowOnly = (args.sowOnly === true)
    const pkg = ensurePathfinder()
    if (!pkg) return fail('无寻路')
    const { Movements, goals } = pkg
    const mcData = ensureMcData(bot)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true)
    m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    function blockName (b) { try { return String(b?.name || '').toLowerCase() } catch { return '' } }
    function props (b) { try { return (typeof b?.getProperties === 'function') ? (b.getProperties() || {}) : {} } catch { return {} } }
    function isFarmland (b) { const n = blockName(b); return n === 'farmland' }
    function isSoulSand (b) { const n = blockName(b); return n === 'soul_sand' }
    const CROPS = [
      { block: 'wheat', item: 'wheat_seeds', maxAge: 7, soil: 'farmland' },
      { block: 'carrots', item: 'carrot', maxAge: 7, soil: 'farmland' },
      { block: 'potatoes', item: 'potato', maxAge: 7, soil: 'farmland' },
      { block: 'beetroots', item: 'beetroot_seeds', maxAge: 3, soil: 'farmland' },
      { block: 'nether_wart', item: 'nether_wart', maxAge: 3, soil: 'soul_sand' }
    ]
    function cropByBlock (n) { n = String(n || '').toLowerCase(); return CROPS.find(c => c.block === n) || null }
    function cropByAlias (n) {
      if (!n) return null
      const s = String(n).toLowerCase()
      for (const c of CROPS) {
        if (c.block === s || c.item === s) return c
        if (s.includes('wheat') || s.includes('seed')) return CROPS[0]
        if (s.includes('carrot')) return CROPS[1]
        if (s.includes('potato') || s.includes('马铃薯') || s.includes('土豆')) return CROPS[2]
        if (s.includes('beet')) return CROPS[3]
        if (s.includes('wart') || s.includes('地狱疙瘩') || s.includes('下界疣')) return CROPS[4]
      }
      return null
    }

    const desired = onlyRaw ? cropByAlias(onlyRaw) : null

    function isMature (b) {
      const n = blockName(b)
      const c = cropByBlock(n)
      if (!c) return false
      const p = props(b)
      const age = (p && (typeof p.age === 'number')) ? p.age : null
      if (age == null) return false
      return age >= c.maxAge
    }

    function findTargets (onlyCrop = null) {
      try {
        const me = bot.entity?.position
        if (!me) return []
        const list = []
        const V = require('vec3').Vec3
        const base = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 3; dy++) {
              const p = base.offset(dx, dy, dz)
              const b = bot.blockAt(p)
              if (!b) continue
              const c = cropByBlock(blockName(b))
              if (!c) continue
              if (onlyCrop && c.block !== onlyCrop.block) continue
              if (!isMature(b)) continue
              list.push({ pos: p, crop: c, mature: true })
            }
          }
        }
        return list
      } catch { return [] }
    }

    async function plantAt (pos, crop) {
      const okEquip = await ensureHandItem(crop.item)
      if (!okEquip) return false
      try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch {}
      const soilBlock = bot.blockAt(pos.offset(0, -1, 0))
      if (!soilBlock) return false
      if (crop.soil === 'farmland' && !isFarmland(soilBlock)) return false
      if (crop.soil === 'soul_sand' && !isSoulSand(soilBlock)) return false
      try { await bot.activateBlock(soilBlock) } catch {}
      await wait(200)
      return true
    }

    const targets = findTargets(desired)
    if (!targets.length && !sowOnly) return fail('附近没有成熟的作物')

    let harvested = 0
    for (const target of targets) {
      try {
        const block = bot.blockAt(target.pos)
        if (!block) continue
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
        await bot.dig(block)
        harvested++
        await wait(80)
        if (replant) await plantAt(target.pos, target.crop)
      } catch {}
    }

    if (sowOnly && desired) {
      const farmland = findTargets({ block: desired.block, sowOnly: true })
      for (const spot of farmland) {
        if (await plantAt(spot.pos, desired)) harvested++
      }
      return harvested > 0 ? ok(`已播种${harvested}`) : fail('没有可播种的位置')
    }

    return harvested > 0 ? ok(`已收获${harvested}`) : fail('未收获任何作物')
  }

  register('feed_animals', feed_animals)
  register('harvest', harvest)
}
