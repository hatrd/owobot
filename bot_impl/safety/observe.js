const { checkDig } = require('./index')
function read (bot, args = {}) {
  const radius = Math.max(1,Math.min(48, Number(args.radius) || 16))
  const max = Math.max(1,Math.min(100,Number(args.max) || 20))
  const ids = ['diamond_ore','deepslate_diamond_ore'].map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  const ores = bot.findBlocks({matching:ids,maxDistance:radius,count:max}).map(p=>{const b=bot.blockAt(p); return {name:b.name,position:p,safety:checkDig(bot,b)} })
  const inventory = bot.inventory.items().map(i=>({slot:i.slot,name:i.name,count:i.count,durabilityRemaining:i.maxDurability ? i.maxDurability-(i.durabilityUsed||0) : null,enchantments:require('./items').enchantments(bot,i)}))
  return {ok:true,msg:'Excavation readiness and loaded diamond ore evidence',data:{dimension:bot.game.dimension,position:bot.entity.position,vitals:{health:bot.health,food:bot.food},freeSlots:bot.inventory.emptySlotCount(),inventory,ores,radius,loadedOnly:true,lastExcavation:bot.state.excavation || null,lastDenied:bot.state.excavationSafety || null,operations:{storage:bot.state.storageTransfer || null,smelting:bot.state.smelting || null,surface:bot.state.surfaceTravel || null}}}
}
module.exports = { read }
