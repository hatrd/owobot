function normalizeItemName (value) {
  return String(value || '').trim().toLowerCase()
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
  ensureItemEquipped
}
