module.exports = function registerInventory (ctx) {
  const { bot, register, ok, fail, assertCanEquipHand, isMainHandLocked } = ctx

  function normalizeName (name) {
    const n = String(name || '').toLowerCase().trim()
    const aliases = new Map([
      ['铁粒', 'iron_nugget'],
      ['火把', 'torch'],
      ['水桶', 'water_bucket'],
      ['钻石剑', 'diamond_sword'],
      ['钻石斧', 'diamond_axe'],
      ['钻石镐', 'diamond_pickaxe'],
      ['圆石', 'cobblestone'],
      ['石头', 'stone'],
      ['木棍', 'stick'],
      ['沙子', 'sand'],
      ['原木', 'log'],
      ['原木块', 'log'],
      ['木头', 'log'],
      ['木头块', 'log'],
      ['木材', 'log'],
      ['logs', 'log'],
      ['橡木原木', 'oak_log'],
      ['云杉原木', 'spruce_log'],
      ['白桦原木', 'birch_log'],
      ['丛林原木', 'jungle_log'],
      ['金合欢原木', 'acacia_log'],
      ['相思木原木', 'acacia_log'],
      ['深色橡木原木', 'dark_oak_log'],
      ['红树原木', 'mangrove_log'],
      ['樱花原木', 'cherry_log'],
      ['橡树苗', 'oak_sapling'],
      ['云杉树苗', 'spruce_sapling'],
      ['白桦树苗', 'birch_sapling'],
      ['丛林树苗', 'jungle_sapling'],
      ['金合欢树苗', 'acacia_sapling'],
      ['相思木树苗', 'acacia_sapling'],
      ['深色橡树苗', 'dark_oak_sapling'],
      ['樱花树苗', 'cherry_sapling']
    ])
    return aliases.get(n) || n
  }

  const GROUP_NAME_MATCHERS = new Map([
    ['log', (value) => {
      const n = String(value || '').toLowerCase()
      if (!n) return false
      if (n.endsWith('_log')) return true
      if (n.endsWith('_stem')) return true
      return false
    }]
  ])

  function wait (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

  function collectInventoryStacks (opts = {}) {
    const includeArmor = opts.includeArmor === true
    const includeOffhand = opts.includeOffhand !== false
    const includeHeld = opts.includeHeld !== false
    const includeMain = opts.includeMain !== false
    const includeHotbar = opts.includeHotbar !== false
    const slots = bot.inventory?.slots || []
    const out = []
    let heldSlotIndex = null
    if (!includeHeld) {
      try {
        const quick = (typeof bot.quickBarSlot === 'number') ? bot.quickBarSlot : null
        if (quick != null) heldSlotIndex = 36 + quick
      } catch {}
    }
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i]
      if (!it) continue
      if (!includeArmor && (i === 5 || i === 6 || i === 7 || i === 8)) continue
      if (!includeOffhand && i === 45) continue
      if (heldSlotIndex != null && i === heldSlotIndex) continue
      if (!includeMain && i >= 9 && i <= 35) continue
      if (!includeHotbar && i >= 36 && i <= 44) continue
      out.push(it)
    }
    return out
  }

  function itemsMatchingName (name, opts = {}) {
    const normalized = normalizeName(name)
    const source = Array.isArray(opts.source) ? opts.source : collectInventoryStacks({
      includeArmor: opts.includeArmor === true,
      includeOffhand: opts.includeOffhand !== false,
      includeHeld: opts.includeHeld !== false,
      includeMain: opts.includeMain !== false,
      includeHotbar: opts.includeHotbar !== false
    })
    const allowPartial = opts.allowPartial !== false
    const matchers = []
    const loweredNormalized = String(normalized || '').toLowerCase()
    if (loweredNormalized) matchers.push((value) => value === loweredNormalized)
    const groupMatcher = GROUP_NAME_MATCHERS.get(loweredNormalized)
    if (groupMatcher) matchers.push(groupMatcher)
    const results = []
    const seen = new Set()
    function addResult (item) {
      if (!item) return
      if (seen.has(item)) return
      seen.add(item)
      results.push(item)
    }
    for (const it of source) {
      const itemName = String(it?.name || '').toLowerCase()
      if (!itemName) continue
      if (matchers.some(fn => fn(itemName))) addResult(it)
    }
    if (results.length || !allowPartial) return results
    if (loweredNormalized && loweredNormalized.length >= 3) {
      for (const it of source) {
        const itemName = String(it?.name || '').toLowerCase()
        if (!itemName) continue
        if (itemName.includes(loweredNormalized)) addResult(it)
      }
    }
    return results
  }

  function resolveItemByName (name) {
    const matches = itemsMatchingName(name, { includeArmor: true, includeOffhand: true, includeHeld: true })
    if (!matches.length) return null
    matches.sort((a, b) => (b.count || 0) - (a.count || 0))
    return matches[0] || null
  }

  function findAllByName (name) {
    try {
      const normalized = normalizeName(name)
      return itemsMatchingName(normalized, { includeArmor: true, includeOffhand: true, includeHeld: true, allowPartial: false })
    } catch { return [] }
  }

  function isEquipSlot (slot) { return slot === 5 || slot === 6 || slot === 7 || slot === 8 || slot === 45 }

  async function dropItemObject (it, count) {
    try {
      const hasSlot = typeof it.slot === 'number'
      if (hasSlot && isEquipSlot(it.slot)) {
        await bot.tossStack(it)
        return it.count || 1
      }
      const n = Math.max(0, Number(count != null ? count : (it.count || 0)))
      if (n <= 0) return 0
      await bot.toss(it.type, null, n)
      return n
    } catch { return 0 }
  }

  function ensureMcData () {
    try {
      if (!bot.mcData) bot.mcData = require('minecraft-data')(bot.version)
      return bot.mcData
    } catch {
      return null
    }
  }

  function isEdible (item) {
    try {
      const mc = ensureMcData()
      if (!mc || !item) return false
      const def = mc.items[item.type] || mc.itemsByName?.[item.name]
      const food = mc.foods?.[item.type] || mc.foodsByName?.[def?.name]
      return Boolean(food)
    } catch { return false }
  }

  async function equip (args = {}) {
    const { name, dest = 'hand' } = args
    if (!name) return fail('缺少物品名')
    const item = resolveItemByName(name)
    if (!item) return fail('背包没有该物品')
    const map = {
      hand: 'hand', 'main': 'hand', 'mainhand': 'hand',
      offhand: 'off-hand', 'off_hand': 'off-hand', 'off-hand': 'off-hand',
      head: 'head', helmet: 'head',
      chest: 'torso', body: 'torso', torso: 'torso',
      legs: 'legs', pants: 'legs',
      feet: 'feet', boots: 'feet'
    }
    const destination = map[String(dest).toLowerCase()] || 'hand'
    try {
      if (destination === 'hand') assertCanEquipHand(bot, item.name)
      await bot.equip(item, destination)
    } catch (e) {
      if (e?.code === 'MAIN_HAND_LOCKED') return fail('主手被锁定，无法切换物品')
      throw e
    }
    return ok(`已装备 ${item.name} -> ${destination}`)
  }

  async function use_item (args = {}) {
    const rawName = args.name
    if (!rawName) return fail('缺少物品名')
    const handParam = String(args.hand || args.slot || '').toLowerCase()
    const destination = (handParam === 'offhand' || handParam === 'off-hand' || handParam === 'off_hand') ? 'off-hand' : 'hand'
    const offhand = destination === 'off-hand'
    const item = resolveItemByName(rawName)
    if (!item) return fail('背包没有该物品')

    try {
      if (offhand) {
        await bot.equip(item, 'off-hand')
      } else {
        if (isMainHandLocked(bot, item.name)) return fail('主手被锁定，无法切换物品')
        assertCanEquipHand(bot, item.name)
        await bot.equip(item, 'hand')
      }
    } catch (e) {
      if (e?.code === 'MAIN_HAND_LOCKED') return fail('主手被锁定，无法切换物品')
      return fail(e?.message || '装备失败')
    }

    try { bot.clearControlStates() } catch {}
    try { bot.pathfinder?.setGoal(null) } catch {}

    const edible = isEdible(item)
    try {
      if (edible) {
        await bot.consume()
        return ok(`已使用（食用）${item.name}`)
      }
      await bot.activateItem(offhand)
      const holdMs = Math.max(0, parseInt(args.holdMs || '120', 10) || 0)
      if (holdMs > 0) await wait(holdMs)
      try { bot.deactivateItem() } catch {}
      return ok(`已使用 ${item.name}`)
    } catch (e) {
      return fail(e?.message || '使用失败')
    }
  }

  async function toss (args = {}) {
    const arr = (() => {
      if (Array.isArray(args.items) && args.items.length) return args.items
      if (Array.isArray(args.names) && args.names.length) return args.names.map(n => ({ name: n }))
      if (args.name) return [{ name: args.name, count: args.count }]
      if (args.slot) return [{ slot: args.slot, count: args.count }]
      return null
    })()
    if ((!arr || !arr.length) && (args.all === true || String(args.all).toLowerCase() === 'true')) {
      const equipSlots = [45, 5, 6, 7, 8]
      const slots = bot.inventory?.slots || []
      for (const idx of equipSlots) {
        const it = slots[idx]
        if (it) {
          const count = it.count != null ? it.count : 1
          await dropItemObject(it, count)
        }
      }
      const inv = bot.inventory?.items() || []
      if (bot.heldItem) inv.push(bot.heldItem)
      const off = bot.inventory?.slots?.[45]
      if (off) inv.push(off)
      const uniq = new Map()
      for (const it of inv) { if (it && it.name) uniq.set(it.name, true) }
      const exclude = new Set((Array.isArray(args.exclude) ? args.exclude : []).map(n => String(n).toLowerCase()))
      const items = Array.from(uniq.keys()).filter(n => !exclude.has(String(n).toLowerCase()))
      if (items.length === 0) return ok('背包为空')
      for (const nm of items) {
        const stacks = findAllByName(nm)
        for (const it of stacks) { const c = it.count || 0; if (c > 0) await bot.toss(it.type, null, c) }
      }
      return ok('已丢出全部物品')
    }
    if (!arr || !arr.length) return fail('缺少物品参数')

    function itemFromSlot (slot) {
      const key = String(slot).toLowerCase()
      if (key === 'hand' || key === 'main' || key === 'mainhand') return bot.heldItem || null
      if (key === 'offhand' || key === 'off-hand' || key === 'off_hand') return bot.inventory?.slots?.[45] || null
      const equipAlias = {
        head: 5, helmet: 5,
        chest: 6, torso: 6, body: 6,
        legs: 7, pants: 7,
        feet: 8, boots: 8
      }
      if (equipAlias[key] != null) {
        return bot.inventory?.slots?.[equipAlias[key]] || null
      }
      const idx = parseInt(String(slot), 10)
      if (Number.isFinite(idx) && bot.inventory?.slots) return bot.inventory.slots[idx] || null
      return null
    }

    const entries = []
    for (const spec of arr) {
      if (!spec) continue
      const entry = { count: spec.count == null ? null : Math.max(0, Number(spec.count) || 0) }
      if (spec.slot != null) entry.item = itemFromSlot(spec.slot)
      if (!entry.item && spec.name) entry.item = resolveItemByName(spec.name)
      if (entry.item) entries.push(entry)
    }
    if (!entries.length) return fail('未找到要丢弃的物品')
    let dropped = 0
    const summary = []
    for (const entry of entries) {
      const it = entry.item
      if (!it) continue
      if (entry.count == null) {
        const c = it.count || 0
        if (c > 0) {
          await dropItemObject(it, c)
          dropped += c
          summary.push(`${it.name} x${c}`)
        }
        continue
      }
      const toDrop = Math.min(entry.count, it.count || 0)
      if (toDrop <= 0) continue
      await dropItemObject(it, toDrop)
      dropped += toDrop
      summary.push(`${it.name} x${toDrop}`)
    }
    return dropped > 0 ? ok(`已丢弃 ${summary.join(', ')}`) : fail('没有丢出任何物品')
  }

  register('equip', equip)
  register('use_item', use_item)
  register('toss', toss)
}
