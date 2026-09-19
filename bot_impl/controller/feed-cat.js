const { distance } = require('../exploration/terrain')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
// One bounded interaction with a re-identified live cat. Never follows or retries.
async function feedCat (bot, state, args, cancellation) {
  const target = () => Object.values(bot.entities || {}).find(e => e.uuid === args.uuid && e.name === 'cat')
  const valid = () => {
    const cat = target()
    return !cancellation.canceled && cat?.position && bot.entity?.position && distance(cat.position, bot.entity.position) <= 3
  }
  if (!valid()) return { ok: false, error: 'cat_unavailable_or_out_of_reach' }
  if (state.holdItemLock || state.autoEat?.eating) return { ok: false, error: 'hand_busy' }
  const item = bot.inventory.items().find(i => ['cod', 'salmon'].includes(i.name) && i.count > 0)
  if (!item) return { ok: false, error: 'raw_fish_required' }
  const token = {}
  state.lifeFeeding = token
  state.holdItemLock = item.name
  const count = () => bot.inventory.items().filter(i => i.name === item.name).reduce((n, i) => n + i.count, 0)
  try {
    await bot.equip(item, 'hand')
    if (!valid()) return { ok: false, error: 'cat_interaction_canceled' }
    await bot.lookAt(target().position.offset(0, 0.4, 0), true)
    if (!valid() || bot.heldItem?.name !== item.name) return { ok: false, error: 'cat_interaction_canceled' }
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
    const direction = target().position.offset(0, 0.4, 0).minus(eye)
    const range = direction.norm()
    if (!bot.world?.raycast || bot.world.raycast(eye, direction.normalize(), range)) return { ok: false, error: 'cat_not_visible' }
    const before = count()
    bot.useOn(target())
    for (let i = 0; i < 30; i++) {
      await pause(50)
      if (count() < before) return { ok: true, uuid: args.uuid, item: item.name, consumed: before - count() }
      if (cancellation.canceled) return { ok: false, error: 'feed_confirmation_interrupted', interactionSent: true }
    }
    return { ok: false, error: 'feed_not_confirmed', interactionSent: true }
  } finally {
    if (state.lifeFeeding === token) { state.lifeFeeding = null; if (state.holdItemLock === item.name) state.holdItemLock = null }
  }
}
module.exports = { feedCat }
