// This is a conservative excavation policy, not a claim to infer block provenance.
const { fluid } = require('../navigation/liquids')
const NATURAL = new Set(['stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'dirt', 'grass_block', 'calcite', 'dripstone_block', 'diamond_ore', 'deepslate_diamond_ore', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'copper_ore', 'deepslate_copper_ore', 'emerald_ore', 'deepslate_emerald_ore'])
const OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
function regions (bot, p) {
  const s = bot.state?.knowledge
  if (!s?.document || s.error) return null
  return s.document.records.filter(r => r.dimension === bot.game?.dimension && r.position && Math.hypot(p.x - r.position.x, p.z - r.position.z) <= r.radius)
}
function checkDig (bot, block) {
  const p = block?.position
  if (!p) return { ok: false, error: 'unloaded_target' }
  const areas = regions(bot, p)
  if (!areas) return { ok: false, error: 'protection_memory_unavailable' }
  const protectedArea = areas.find(r => ['home', 'protected'].includes(r.kind))
  if (protectedArea) return { ok: false, error: 'protected_region', evidence: protectedArea.id }
  if (!areas.some(r => r.kind === 'mining' && (r.minY === undefined || p.y >= r.minY) && (r.maxY === undefined || p.y <= r.maxY) && r.confidence === 'observed' && (!r.expiresAt || r.expiresAt > Date.now()))) return { ok: false, error: 'outside_mining_region' }
  const route = bot.state.knowledge.document.records.find(r => r.kind === 'route' && r.confidence === 'observed' && r.dimension === bot.game?.dimension && r.position && p.x === Math.floor(r.position.x) && p.z === Math.floor(r.position.z) && p.y === Math.floor(r.position.y) - 1)
  if (route) return { ok: false, error: 'recorded_route_support', evidence: route.id }
  if (!NATURAL.has(block.name)) return { ok: false, error: 'block_not_in_excavation_policy', block: block.name }
  const feet = bot.entity?.position?.floored()
  if (!feet || (p.x === feet.x && p.z === feet.z && p.y < feet.y)) return { ok: false, error: 'underfoot_excavation' }
  if (fluid(bot, block).kind !== 'dry') return { ok: false, error: 'fluid_target' }
  for (const offset of OFFSETS) {
    const neighbor = bot.blockAt(p.offset(...offset), false)
    if (fluid(bot, neighbor).kind !== 'dry') return { ok: false, error: 'fluid_or_unknown_neighbor', position: p.offset(...offset) }
    if (offset[1] === 1 && !NATURAL.has(neighbor.name) && neighbor.boundingBox !== 'empty') return { ok: false, error: 'unsafe_ceiling', block: neighbor.name }
  }
  return { ok: true }
}
function install (bot, { state, registerCleanup }) {
  const original = bot.dig
  const originalTime = bot.digTime
  const accurateTime = block => require('./items').digTime(bot, block)
  if (originalTime) bot.digTime = accurateTime
  const guarded = async function (block, ...args) {
    const current = block?.position && bot.blockAt(block.position, false)
    const result = checkDig(bot, current)
    if (!result.ok) {
      state.excavationSafety = { ...result, at: Date.now(), position: block?.position }
      throw Object.assign(new Error(result.error), { code: result.error, detail: result })
    }
    if (current.type !== block.type) throw new Error('block_changed')
    return original.call(bot, current, ...args)
  }
  bot.dig = guarded
  registerCleanup(() => { if (bot.dig === guarded) bot.dig = original; if (bot.digTime === accurateTime) bot.digTime = originalTime })
}
module.exports = { install, checkDig, regions, NATURAL }
