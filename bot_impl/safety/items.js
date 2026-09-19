// Component-backed enchantments are absent from prismarine-item's legacy NBT getter.
function enchantments (bot, item) {
  const data = item.componentMap?.get('enchantments')?.data || item.componentMap?.get('minecraft:enchantments')?.data
  if (data?.enchantments) return data.enchantments.map(e=>({id:e.id,name:bot.registry.enchantments?.[e.id]?.name || null,level:e.level}))
  return (item.enchants || []).map(e=>({name:e.name,level:e.lvl}))
}
function digTime(bot,block,item=bot.heldItem){
  const helmet=bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('head') ?? 5]
  const ench=[...(item?enchantments(bot,item):[]),...(helmet?enchantments(bot,helmet):[])].map(e=>({name:e.name,lvl:e.level}))
  return block.digTime(item?.type ?? null,bot.game?.gameMode==='creative',!!bot.entity?.isInWater,!bot.entity?.onGround,ench,bot.entity?.effects || {})
}
module.exports={enchantments,digTime}
