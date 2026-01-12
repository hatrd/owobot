// High-level craft skill: craft item with qty, minimal 2x2 recipes support

const { ensureMcData } = require('../lib/mcdata')

module.exports = function craftFactory ({ bot, args, log }) {
  const item = String(args.item || '').toLowerCase()
  const qty = Math.max(1, parseInt(args.qty || '1', 10))
  let inited = false
  let done = 0

  function needCount (name) {
    try { return (bot.inventory?.items() || []).filter(it => String(it.name || '').toLowerCase() === name).reduce((a, b) => a + (b.count || 0), 0) } catch { return 0 }
  }

  function start () { inited = true }

  async function tick () {
    if (!inited) start()
    // ready?
    if (!bot.recipesFor) return { status: 'failed', progress: 0, events: [{ type: 'error', error: '缺少配方接口' }] }
    const mcData = ensureMcData(bot)
    const itemDef = mcData?.itemsByName?.[item]
    if (!itemDef) return { status: 'failed', progress: 0, events: [{ type: 'error', error: '未知物品' }] }
    // find 2x2 recipes (without table) as minimal support
    const recipes = bot.recipesFor(itemDef.id, null, 1, null) || []
    if (!recipes.length) return { status: 'failed', progress: 0, events: [{ type: 'missing_material', need: item, offer: [], decision: 'awaiting' }] }
    const r = recipes[0]
    const left = Math.max(0, qty - done)
    try {
      await bot.craft(r, left, null)
      done = qty
    } catch (e) {
      // Try to detect missing material roughly by message
      const msg = String(e?.message || e)
      const ev = { type: 'missing_material', need: 'unknown', offer: [], decision: 'awaiting', error: msg }
      return { status: 'failed', progress: (done / qty), events: [ev] }
    }
    return { status: 'succeeded', progress: 1, events: [{ type: 'crafted', item, qty }] }
  }

  function cancel () {}

  return { start, tick, cancel }
}
