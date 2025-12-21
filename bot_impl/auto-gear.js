// Auto-equip best gear from inventory: armor, weapon, shield

function install (bot, { on, dlog, state, registerCleanup, log }) {
  let iv = null
  let running = false
  let pausedUntil = 0

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
    // include offhand/main
    const extra = []
    if (bot.heldItem) extra.push(bot.heldItem)
    const off = bot.inventory?.slots?.[45]
    if (off) extra.push(off)
    // include currently equipped armor pieces as candidates too to avoid swap thrash
    try {
      const s = bot.inventory?.slots || []
      for (const idx of [5, 6, 7, 8]) { if (s[idx]) extra.push(s[idx]) }
    } catch {}
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

  const getMS = () => { try { return require('./minimal-self').getInstance() } catch { return null } }
  const recordDid = (action, detail) => {
    const ms = getMS()
    if (!ms) return
    try { ms.getIdentity?.().recordSkillOutcome?.(action, true, 0.95) } catch {}
    try { ms.getNarrative?.().recordDid?.(action, null, detail || 'auto-gear') } catch {}
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
        recordDid('自动换装', `${spec.slot}:${best.name}`)
      } catch {}
    }
  }

  async function ensureBestHandsOnce () {
    try {
      const pvp = require('./pvp')
      // Respect temporary hand lock for main hand, but still allow off-hand shield equip
      if (!(state && state.holdItemLock)) {
        await pvp.ensureBestWeapon(bot)
      }
      await pvp.ensureShieldEquipped(bot)
      recordDid('自动持械', 'weapon/shield')
    } catch {}
  }

  async function tick () {
    if (running) return
    running = true
    try {
      if (Date.now() < pausedUntil) return
      try { if (state && state.externalBusy) return } catch {}
      if (bot.currentWindow) return // skip while interacting with a container
      await ensureBestArmorOnce()
      await ensureBestHandsOnce()
    } finally { running = false }
  }

  // Run soon after spawn, and periodically
  on('spawn', () => { setTimeout(() => tick().catch(() => {}), 300) })
  iv = setInterval(() => { tick().catch(() => {}) }, 2500)
  on('agent:stop_all', () => { pausedUntil = Date.now() + 5000 })

  registerCleanup && registerCleanup(() => { if (iv) { try { clearInterval(iv) } catch {} ; iv = null } })
}

module.exports = { install }
