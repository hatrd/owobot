// Edit this file and save to trigger a one-time action.
// On every save, the bot hot-reloads and executes this function once.
//
// Exports can be either:
//   module.exports = async (bot, ctx) => { ... }
// or
//   module.exports.run = async (bot, ctx) => { ... }
//
// Context:
//   - bot: mineflayer bot instance
//   - ctx.state: shared state object
//   - ctx.dlog: debug logger (respects MC_DEBUG)
//   - ctx.actions: helpers { digAt({x,y,z}), digUnderfoot() }

module.exports = async function (bot, ctx) {
  const { dlog, actions } = ctx

  // EXAMPLES — pick one and edit as needed:

  // 1) Dig block under the bot's feet
  // await actions.digUnderfoot()

  // 2) Dig a specific coordinate
  // await actions.digAt({ x: 1841, y: 91, z: 2638 })

  // 3) Loot all items from a chest at coordinates
  // await actions.lootAllFromContainerAt({ x: 1841, y: 91, z: 2638 })

  // 4) Say something in chat
  // bot.chat('一次性操作：你好呀！')

  dlog('oneshot: no-op (edit bot_impl/oneshot.js to run an action)')
}
