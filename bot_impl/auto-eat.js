// Auto-eat: keep hunger up by consuming edible items in inventory.
// No external deps; uses minecraft-data to detect foods.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  let timer = null
  let mcData = null
  state.autoEat = state.autoEat || { enabled: true, eating: false }

  const THRESHOLD = Number(process.env.AUTO_EAT_START_AT || 18) // start eating if food < threshold
  const COOLDOWN_MS = 1500
  let lastAttemptAt = 0
  let pauseUntil = 0

  function ensureMcData () {
    if (!mcData) {
      try { mcData = bot.mcData || require('minecraft-data')(bot.version); bot.mcData = mcData } catch {}
    }
    return mcData
  }

  function isEdibleItem (item) {
    if (!ensureMcData()) return false
    if (!item) return false
    const banned = ['golden_apple', 'enchanted_golden_apple']
    const it = mcData.items[item.type] || mcData.itemsByName?.[item.name]
    if (!it) return false
    if (banned.includes(it.name)) return false
    const food = mcData.foods?.[item.type] || mcData.foodsByName?.[it.name]
    return Boolean(food)
  }

  function edibleScore (item) {
    // Prefer more food points, then higher count stack
    if (!ensureMcData()) return 0
    const it = mcData.items[item.type] || mcData.itemsByName?.[item.name]
    const food = mcData.foods?.[item.type] || mcData.foodsByName?.[it?.name]
    const fp = food?.foodPoints ?? 0
    return fp * 100 + (item.count || 0)
  }

  function pickEdibleItem () {
    const items = bot.inventory.items() || []
    const foods = items.filter(isEdibleItem)
    foods.sort((a, b) => edibleScore(b) - edibleScore(a))
    return foods[0] || null
  }

  async function ensureOnHotbar (slot) {
    // If item is already in hotbar (36..44), select it. Otherwise move to 36 and select 0.
    if (slot >= 36 && slot <= 44) {
      bot.setQuickBarSlot(slot - 36)
      return
    }
    // Move to first hotbar slot (36). If occupied, moveSlotItem will swap as needed.
    await bot.moveSlotItem(slot, 36)
    bot.setQuickBarSlot(0)
  }

  async function tryEatOnce () {
    const now = Date.now()
    if (!state.autoEat.enabled) return
    if (now < pauseUntil) return
    if (state.autoEat.eating) return
    if (!bot.food && bot.food !== 0) return
    dlog && dlog('eat: tick food=', bot.food, 'health=', bot.health)
    if (bot.food >= THRESHOLD) return
    if (now - lastAttemptAt < COOLDOWN_MS) return
    lastAttemptAt = now

    const item = pickEdibleItem()
    if (!item) { dlog && dlog('eat: no edible items available') ; return }
    dlog && dlog('eat: preparing item', { name: item.name, count: item.count, slot: item.slot })
    state.autoEat.eating = true
    try {
      await ensureOnHotbar(item.slot)
      await bot.consume()
      dlog && dlog('eat: consumed', item.name)
    } catch (err) {
      dlog && dlog('eat: failed', err?.message || String(err))
    } finally {
      state.autoEat.eating = false
    }
  }

  function startWatcher () {
    ensureMcData()
    if (timer) clearInterval(timer)
    timer = setInterval(tryEatOnce, 800)
    dlog && dlog('eat: watcher started; threshold=', THRESHOLD)
  }

  on('spawn', () => {
    startWatcher()
  })

  on('end', () => {
    try { if (timer) clearInterval(timer) } catch {}
    timer = null
    dlog && dlog('eat: watcher stopped')
  })

  // Pause auto-eat briefly on global stop to avoid contention
  on('agent:stop_all', () => { pauseUntil = Date.now() + 5000; state.autoEat.eating = false })

  // If plugin loaded after spawn, start immediately
  if (state?.hasSpawned) startWatcher()

  // Ensure interval cleared on plugin deactivate
  registerCleanup && registerCleanup(() => { try { if (timer) clearInterval(timer) } catch {} ; timer = null })
}

module.exports = { install }
