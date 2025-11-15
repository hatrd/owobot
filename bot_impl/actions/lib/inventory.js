const ITEM_ALIASES = new Map([
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

const GROUP_NAME_MATCHERS = new Map([
  ['log', (value) => {
    const n = String(value || '').toLowerCase()
    if (!n) return false
    if (n.endsWith('_log')) return true
    if (n.endsWith('_stem')) return true
    return false
  }]
])

function normalizeItemName (value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ITEM_ALIASES.get(normalized) || normalized
}

function collectInventoryStacks (bot, opts = {}) {
  try {
    const includeArmor = opts.includeArmor !== false
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
  } catch {
    return []
  }
}

function findItemByName (bot, name, opts = {}) {
  const normalized = normalizeItemName(name)
  if (!normalized) return null
  const source = Array.isArray(opts.source) ? opts.source : collectInventoryStacks(bot, opts)
  for (const it of source) {
    if (!it || !it.name) continue
    if (normalizeItemName(it.name) !== normalized) continue
    return it
  }
  return null
}

function countItemByName (bot, name, opts = {}) {
  const normalized = normalizeItemName(name)
  if (!normalized) return 0
  const source = Array.isArray(opts.source) ? opts.source : collectInventoryStacks(bot, opts)
  let total = 0
  for (const it of source) {
    if (!it || !it.name) continue
    if (normalizeItemName(it.name) !== normalized) continue
    total += it.count || 0
  }
  return total
}

function itemsMatchingName (bot, name, opts = {}) {
  try {
    const normalized = normalizeItemName(name)
    const source = Array.isArray(opts.source)
      ? opts.source
      : (bot ? collectInventoryStacks(bot, {
          includeArmor: opts.includeArmor === true,
          includeOffhand: opts.includeOffhand !== false,
          includeHeld: opts.includeHeld !== false,
          includeMain: opts.includeMain !== false,
          includeHotbar: opts.includeHotbar !== false
        }) : [])
    const allowPartial = opts.allowPartial !== false
    const matchers = []
    const loweredNormalized = String(normalized || '').toLowerCase()
    if (loweredNormalized) matchers.push(value => value === loweredNormalized)
    const groupMatcher = GROUP_NAME_MATCHERS.get(loweredNormalized)
    if (groupMatcher) matchers.push(groupMatcher)
    const results = []
    const seen = new Set()
    const addResult = (item) => {
      if (!item || seen.has(item)) return
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
  } catch {
    return []
  }
}

async function ensureItemEquipped (bot, name, opts = {}) {
  const normalized = normalizeItemName(name)
  if (!normalized) return false
  const item = findItemByName(bot, normalized, {
    includeArmor: opts.includeArmor !== false,
    includeOffhand: opts.includeOffhand !== false,
    includeHeld: true,
    includeMain: opts.includeMain !== false,
    includeHotbar: opts.includeHotbar !== false
  })
  if (!item) return false
  const heldName = normalizeItemName(bot.heldItem?.name)
  if (heldName === normalized) return true
  try {
    if (typeof opts.assertCanEquipHand === 'function') opts.assertCanEquipHand(bot, item.name)
    await bot.equip(item, 'hand')
    return true
  } catch (e) {
    if (e?.code === 'MAIN_HAND_LOCKED') return false
    throw e
  }
}

module.exports = {
  normalizeItemName,
  collectInventoryStacks,
  findItemByName,
  countItemByName,
  itemsMatchingName,
  ensureItemEquipped
}
