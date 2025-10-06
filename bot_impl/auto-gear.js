// Auto-equip best gear from inventory: armor, weapon, shield

function install (bot, { on, dlog, state, registerCleanup, log }) {
  let iv = null
  let running = false

  const ARMOR_MATERIAL_ORDER = ['netherite','diamond','iron','chainmail','turtle','golden','leather']
  const ARMOR_SLOTS = [
    { slot: 'head',   idx: 5, kinds: ['helmet', 'turtle_helmet'] },
    { slot: 'torso',  idx: 6, kinds: ['chestplate'] },
    { slot: 'legs',   idx: 7, kinds: ['leggings'] },
    { slot: 'feet',   idx: 8, kinds: ['boots'] }
  ]

  function name (it) { return String(it?.name || '').toLowerCase() }

  function armorMaterial (n) {
    if (!n) return null
    if (n === 'turtle_helmet') return 'turtle'
    const parts = n.split('_')
    // e.g., diamond_helmet -> diamond
    return parts.length >= 2 ? parts[0] : null
  }

  function armorKind (n) {
    if (!n) return null
    if (n === 'turtle_helmet') return 'turtle_helmet'
    const parts = n.split('_')
    return parts.length >= 2 ? parts.slice(1).join('_') : null
  }

  function materialRank (mat) {
    const i = ARMOR_MATERIAL_ORDER.indexOf(mat)
    return i >= 0 ? i : ARMOR_MATERIAL_ORDER.length
  }

  function bestArmorFor (slotSpec) {
    const items = (bot.inventory?.items() || []).slice()
    // include any unequipped from offhand/main just in case
    const extra = []
    if (bot.heldItem) extra.push(bot.heldItem)
    const off = bot.inventory?.slots?.[45]
    if (off) extra.push(off)
    const all = items.concat(extra)
    const candidates = []
    for (const it of all) {
      const nm = name(it)
      if (!nm) continue
      const kind = armorKind(nm)
      if (!kind) continue
      if (slotSpec.kinds.includes(kind)) {
        const mat = armorMaterial(nm)
        candidates.push({ it, rank: materialRank(mat), mat, kind, nm })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => a.rank - b.rank)
    return candidates[0].it
  }

  function currentArmorName (idx) {
    try { return name(bot.inventory?.slots?.[idx]) } catch { return null }
  }

  async function ensureBestArmorOnce () {
    for (const spec of ARMOR_SLOTS) {
      try {
        const best = bestArmorFor(spec)
        if (!best) continue
        const cur = currentArmorName(spec.idx)
        if (name(best) === cur) continue
        await bot.equip(best, spec.slot)
        dlog && dlog('equip armor', spec.slot, '->', best.name)
      } catch {}
    }
  }

  async function ensureBestHandsOnce () {
    try { const pvp = require('./pvp'); await pvp.ensureBestWeapon(bot); await pvp.ensureShieldEquipped(bot) } catch {}
  }

  async function tick () {
    if (running) return
    running = true
    try {
      if (bot.currentWindow) return // skip while interacting with a container
      await ensureBestArmorOnce()
      await ensureBestHandsOnce()
    } finally { running = false }
  }

  // Run soon after spawn, and periodically
  on('spawn', () => { setTimeout(() => tick().catch(() => {}), 300) })
  iv = setInterval(() => { tick().catch(() => {}) }, 2500)
  on('agent:stop_all', () => { if (iv) { try { clearInterval(iv) } catch {} ; iv = null } })

  registerCleanup && registerCleanup(() => { if (iv) { try { clearInterval(iv) } catch {} ; iv = null } })
}

module.exports = { install }
