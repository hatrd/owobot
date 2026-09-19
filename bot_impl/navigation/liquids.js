// Minecraft mechanics from registry IDs and block properties, shared by planning and recovery.
const WATER = ['water', 'flowing_water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']
function fluid (bot, block) {
  if (!block) return { kind: 'unknown', flowing: false, bubble: false }
  const ids = bot.registry?.blocksByName || {}
  const is = name => ids[name] && block.type === ids[name].id
  const properties = block.getProperties?.() || {}
  if (is('lava') || is('flowing_lava')) return { kind: 'lava', flowing: true, bubble: false }
  const water = block.isWaterlogged === true || properties.waterlogged === true || WATER.some(is)
  return { kind: water ? 'water' : 'dry', flowing: water && Number(properties.level || 0) !== 0, bubble: Boolean(is('bubble_column')) }
}
function fullSupport (block) {
  return block?.boundingBox === 'block' && (block.shapes || []).some(s => s[0] <= 0 && s[2] <= 0 && s[3] >= 1 && s[5] >= 1 && s[4] >= 1)
}
function cell (bot, position, mode = 'wade') {
  const p = position.floored()
  const feet = bot.blockAt(p, false)
  const head = bot.blockAt(p.offset(0, 1, 0), false)
  const floor = bot.blockAt(p.offset(0, -1, 0), false)
  const f = fluid(bot, feet); const h = fluid(bot, head); const b = fluid(bot, floor)
  if ([f, h, b].some(v => v.kind === 'unknown')) return { allowed: false, reason: 'unloaded' }
  if ([f, h, b].some(v => v.kind === 'lava')) return { allowed: false, reason: 'lava' }
  if (h.kind === 'water') return { allowed: false, reason: 'submerged_head' }
  if (f.kind === 'water') {
    if (f.bubble || f.flowing) return { allowed: false, reason: 'water_current' }
    if (mode === 'dry') return { allowed: false, reason: 'water_disallowed' }
    if (!fullSupport(floor) || b.kind !== 'dry') return { allowed: false, reason: 'deep_water' }
    return { allowed: true, reason: 'wading' }
  }
  if (b.kind === 'water' && !fullSupport(floor)) return { allowed: false, reason: 'unsupported_water_surface' }
  return { allowed: true, reason: 'dry' }
}
function body (bot) {
  const p = bot.entity?.position
  if (!p) return { feet: 'unknown', head: 'unknown', inWater: false }
  const feet = fluid(bot, bot.blockAt(p.floored(), false))
  const head = fluid(bot, bot.blockAt(p.offset(0, bot.entity.eyeHeight || 1.62, 0).floored(), false))
  return { feet: feet.kind, head: head.kind, inWater: feet.kind === 'water' || head.kind === 'water', oxygenLevel: bot.oxygenLevel ?? null }
}
module.exports = { fluid, fullSupport, cell, body }
