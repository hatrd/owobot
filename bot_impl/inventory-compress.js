// Inventory compression: craft space-saving blocks/ingots when inventory is tight.
// - Respects externalBusy and currentWindow
// - Uses nearby crafting table for 3x3 recipes; 2x2/1x1 works without table

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log
  let iv = null
  let pausedUntil = 0

  function ensureMcData () { try { if (!bot.mcData) bot.mcData = require('minecraft-data')(bot.version) } catch {} ; return bot.mcData }

  function emptySlotsCount () {
    try { const s = bot.inventory?.slots || []; let c = 0; for (let i = 9; i < s.length; i++) if (!s[i]) c++; return c } catch { return 0 }
  }

  function countItem (name) {
    try { const inv = bot.inventory?.items() || []; const n = String(name).toLowerCase(); let c = 0; for (const it of inv) if (String(it?.name).toLowerCase() === n) c += (it.count || 0); return c } catch { return 0 }
  }

  function findCraftingTableNearby (radius = 6) {
    try { return bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: Math.max(2, radius) }) || null } catch { return null }
  }

  async function craftOne (outName, tableBlock) {
    const mcData = ensureMcData()
    const def = mcData?.itemsByName?.[outName]
    if (!def) return false
    const recipes = bot.recipesFor(def.id, null, 1, tableBlock) || []
    if (!recipes.length) return false
    try { await bot.craft(recipes[0], 1, tableBlock); return true } catch { return false }
  }

  // Compress pairs: from many small items to a compact result
  const COMPRESS = [
    // 1x1 or 2x2 (no table required)
    { need: 'quartz', out: 'quartz_block', table: false }, // 2x2
    // 3x3 requires table
    { need: 'iron_nugget', out: 'iron_ingot', table: true },
    { need: 'gold_nugget', out: 'gold_ingot', table: true },
    { need: 'iron_ingot', out: 'iron_block', table: true },
    { need: 'gold_ingot', out: 'gold_block', table: true },
    { need: 'copper_ingot', out: 'copper_block', table: true },
    { need: 'redstone', out: 'redstone_block', table: true },
    { need: 'coal', out: 'coal_block', table: true },
    { need: 'lapis_lazuli', out: 'lapis_block', table: true },
    { need: 'diamond', out: 'diamond_block', table: true },
    { need: 'emerald', out: 'emerald_block', table: true },
    { need: 'slime_ball', out: 'slime_block', table: true },
    { need: 'raw_iron', out: 'raw_iron_block', table: true },
    { need: 'raw_gold', out: 'raw_gold_block', table: true },
    { need: 'raw_copper', out: 'raw_copper_block', table: true },
    { need: 'netherite_ingot', out: 'netherite_block', table: true }
  ]

  async function tick () {
    if (Date.now() < pausedUntil) return
    try { if (state && state.externalBusy) return } catch {}
    if (bot.currentWindow) return
    const free = emptySlotsCount()
    if (free >= 6) return // only when space is a little tight

    const mcData = ensureMcData()
    const table = findCraftingTableNearby(6)
    for (const rule of COMPRESS) {
      // Skip 3x3 rules if no table
      if (rule.table && !table) continue
      // At least enough to craft once?
      const needCnt = countItem(rule.need)
      if (needCnt <= 8 && rule.table) continue
      if (needCnt <= 3 && !rule.table) continue
      const ok = await craftOne(rule.out, rule.table ? table : null)
      if (ok) { L && L.info && L.info('compressed ->', rule.out); await new Promise(r => setTimeout(r, 150)); break }
    }
  }

  function start () { if (!iv) iv = setInterval(() => { tick().catch(()=>{}) }, 2000) }
  function stop () { if (iv) { try { clearInterval(iv) } catch {} ; iv = null } }

  // reload-safe start
  on('spawn', start)
  start()
  on('agent:stop_all', () => { pausedUntil = Date.now() + 4000 })
  registerCleanup && registerCleanup(stop)
}

module.exports = { install }

