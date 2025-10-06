// Choose and equip the best tool for a given block

function getMcData (bot) { try { if (!bot.mcData) bot.mcData = require('minecraft-data')(bot.version) } catch {} ; return bot.mcData }

function listInventoryWithHands (bot) {
  const inv = bot.inventory?.items() || []
  const extra = []
  if (bot.heldItem) extra.push(bot.heldItem)
  const off = bot.inventory?.slots?.[45]
  if (off) extra.push(off)
  return inv.concat(extra)
}

function nameOf (it) { return String(it?.name || '').toLowerCase() }

function materialOf (nm) {
  const n = String(nm || '').toLowerCase()
  if (!n) return null
  const p = n.split('_')
  if (p[0] === 'netherite' || p[0] === 'diamond' || p[0] === 'iron' || p[0] === 'stone' || p[0] === 'golden' || p[0] === 'wooden') return p[0]
  return null
}

function toolTypeOf (nm) {
  const n = String(nm || '').toLowerCase()
  if (n.endsWith('_pickaxe')) return 'pickaxe'
  if (n.endsWith('_shovel')) return 'shovel'
  if (n.endsWith('_axe')) return 'axe'
  if (n.endsWith('_hoe')) return 'hoe'
  if (n === 'shears') return 'shears'
  return null
}

function materialRank (mat) {
  const order = ['netherite','diamond','iron','stone','golden','wooden']
  const i = order.indexOf(String(mat || ''))
  return i >= 0 ? i : order.length
}

function chooseBestByMaterial (items) {
  const scored = items.map(it => ({ it, r: materialRank(materialOf(nameOf(it))) }))
  scored.sort((a, b) => a.r - b.r)
  return scored.length ? scored[0].it : null
}

function chooseByHarvestTable (bot, block) {
  try {
    const mc = getMcData(bot)
    const b = mc.blocks[block.type]
    const ht = b?.harvestTools
    if (!ht || typeof ht !== 'object') return null
    const inv = listInventoryWithHands(bot)
    const valid = inv.filter(it => ht[it.type])
    if (valid.length === 0) return null
    return chooseBestByMaterial(valid)
  } catch { return null }
}

function heuristicToolTypeForBlock (block) {
  const n = String(block?.name || '').toLowerCase()
  if (!n) return null
  // frequent categories
  if (n.includes('ore') || n.includes('deepslate') || n.includes('stone') || n.includes('netherrack') || n.includes('obsidian')) return 'pickaxe'
  if (n.includes('log') || n.includes('planks') || n.includes('wood') || n.includes('bookshelf') || n.includes('barrel') || n.includes('hyphae') || n.includes('stem')) return 'axe'
  if (n.includes('dirt') || n.includes('sand') || n.includes('gravel') || n.includes('clay') || n.includes('snow') || n.includes('soul_sand') || n.includes('soul_soil') || n.includes('farmland') || n.includes('grass_block')) return 'shovel'
  if (n.includes('leaves') || n.includes('cobweb') || n === 'web') return 'shears'
  if (n.includes('wool')) return 'shears'
  return null
}

function chooseByHeuristic (bot, block) {
  const inv = listInventoryWithHands(bot)
  const t = heuristicToolTypeForBlock(block)
  if (!t) return null
  const candidates = inv.filter(it => toolTypeOf(nameOf(it)) === t || (t === 'shears' && nameOf(it) === 'shears'))
  if (candidates.length === 0) return null
  if (t === 'shears') return candidates[0]
  return chooseBestByMaterial(candidates)
}

function selectBestToolForBlock (bot, block) {
  if (!block) return null
  // priority 1: harvest table from mcData
  const byHv = chooseByHarvestTable(bot, block)
  if (byHv) return byHv
  // priority 2: heuristic by name category
  const byHeu = chooseByHeuristic(bot, block)
  if (byHeu) return byHeu
  return null
}

async function ensureBestToolForBlock (bot, block) {
  try {
    const best = selectBestToolForBlock(bot, block)
    if (!best) return false
    const cur = bot.heldItem
    if (cur && cur.type === best.type) return true
    await bot.equip(best, 'hand')
    return true
  } catch { return false }
}

module.exports = { selectBestToolForBlock, ensureBestToolForBlock }

