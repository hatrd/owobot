const { Vec3 } = require('vec3')
const { checkDig } = require('../safety')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Single server-confirmed removal. Movement is a separate, observable action.
async function excavate (bot, state, args, cancellation) {
  const target = new Vec3(args.x, args.y, args.z)
  const receipt = state.excavation = { position: args, expected: args.expected, phase: 'checking', at: Date.now() }
  const fail = error => { receipt.phase = 'failed'; receipt.error = error; return { ok: false, error, data: { ...receipt } } }
  const check = () => {
    if (cancellation.canceled) return 'canceled'
    if (bot.health < 16 || bot.food < 10) return 'unsafe_vitals'
    const block = bot.blockAt(target, false)
    if (!block || block.name !== args.expected) return 'block_mismatch'
    const safety = checkDig(bot, block)
    if (!safety.ok) { receipt.safety = safety; return safety.error }
    return null
  }
  let error = check(); if (error) return fail(error)
  const block = bot.blockAt(target, false)
  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4.5 || !bot.canDigBlock(block)) return fail('out_of_reach')
  const pickaxes = new Set(['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])
  const tools = bot.inventory.items().filter(i => pickaxes.has(i.name) && (!i.maxDurability || i.maxDurability - (i.durabilityUsed || 0) > 32))
  const itemInfo = require('../safety/items')
  const candidates = ['diamond_ore','deepslate_diamond_ore'].includes(block.name) ? tools.filter(i=>!itemInfo.enchantments(bot,i).some(e=>e.name==='silk_touch')) : tools
  const tool = candidates.sort((a,b) => itemInfo.digTime(bot,block,a) - itemInfo.digTime(bot,block,b))[0]
  if (!tool) return fail(tools.length ? 'non_silk_pickaxe_required' : 'missing_durable_pickaxe')
  if (bot.inventory.emptySlotCount() < 2) return fail('inventory_reserve_required')
  await bot.equip(tool, 'hand')
  error = check(); if (error) return fail(error)
  await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
  error = check(); if (error) return fail(error)
  const visible = bot.blockAtCursor(5)
  if (!visible?.position.equals(target)) return fail('target_obstructed')
  receipt.phase = 'digging'; receipt.tool = tool.name
  try { await bot.dig(bot.blockAt(target, false), 'raycast') } catch (e) { return fail(e.code || e.message) }
  if (cancellation.canceled) return fail('canceled')
  const deadline = Date.now() + 1500
  while (!cancellation.canceled && Date.now() < deadline) {
    const actual = bot.blockAt(target, false)
    if (actual && actual.name !== args.expected) { receipt.phase = 'confirmed'; receipt.actual = actual.name; return { ok: true, data: { ...receipt } } }
    await wait(50)
  }
  return fail(cancellation.canceled ? 'canceled' : 'dig_unconfirmed')
}
// Discard only caller-selected bulk excavation material, retaining a building reserve.
async function discard (bot, args, cancellation) {
  const before = bot.inventory.items().filter(i => i.name === args.item).reduce((n,i)=>n+i.count,0)
  let remaining = Math.max(0, before - args.keep)
  for (const item of bot.inventory.items().filter(i => i.name === args.item)) {
    if (cancellation.canceled) return { ok:false,error:'canceled' }
    if (!remaining) break
    const amount = Math.min(remaining, item.count)
    await bot.toss(item.type, item.metadata, amount)
    remaining -= amount
  }
  const after = bot.inventory.items().filter(i => i.name === args.item).reduce((n,i)=>n+i.count,0)
  return {ok:after === Math.min(before,args.keep),data:{item:args.item,before,after},...(after !== Math.min(before,args.keep) ? {error:'discard_unconfirmed'} : {})}
}
module.exports = { excavate, discard }
