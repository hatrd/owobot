const { Vec3 } = require('vec3')
const { isContainerNameMatch } = require('../actions/lib/containers')
async function transfer (bot, state, args, cancellation) {
  const p = new Vec3(args.x,args.y,args.z)
  const receipt = state.storageTransfer = { position: {x:args.x,y:args.y,z:args.z}, direction:args.direction, item:args.item, requested:args.count, phase:'checking',at:Date.now() }
  const fail = error => ({ok:false,error,data:{...receipt,error}})
  if (cancellation.canceled) return fail('canceled')
  const block = bot.blockAt(p,false)
  if (!block || !isContainerNameMatch(block.name,'storage')) return fail('not_storage_container')
  if (bot.entity.position.distanceTo(p.offset(0.5,0.5,0.5)) > 4.5) return fail('container_out_of_reach')
  if (bot.currentWindow) return fail('window_busy')
  const count = () => (bot.currentWindow ? bot.currentWindow.slots.slice(bot.currentWindow.inventoryStart, bot.currentWindow.inventoryEnd).filter(Boolean) : bot.inventory.items()).filter(i=>i.name===args.item).reduce((n,i)=>n+i.count,0)
  const before = count(); receipt.before = before
  let window
  try {
    receipt.phase='opening'
    window = await bot.openContainer(block)
    if (cancellation.canceled) return fail('canceled')
    const source = window.containerItems()
    // Deposit source must be the player's inventory, not the whole window.
    const items = args.direction === 'deposit' ? window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean) : source
    const item = items.find(i=>i.name===args.item)
    if (!item || items.filter(i=>i.name===args.item).reduce((n,i)=>n+i.count,0)<args.count) return fail('insufficient_items')
    receipt.phase='transferring'
    await window[args.direction](item.type,item.metadata,args.count)
    const after = count(); receipt.after=after;receipt.transferred=args.direction==='deposit'?before-after:after-before
    if (receipt.transferred !== args.count) return fail('transfer_unconfirmed')
    receipt.phase='confirmed'
    return {ok:true,data:{...receipt}}
  } catch(e) { return fail(e.message) }
  finally { if(window) {try{window.close()}catch{}} }
}
module.exports={transfer}
