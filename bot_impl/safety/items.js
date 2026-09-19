// Component-backed enchantments are absent from prismarine-item's legacy NBT getter.
function enchantments (bot, item) {
  const data = item.componentMap?.get('enchantments')?.data || item.componentMap?.get('minecraft:enchantments')?.data
  if (data?.enchantments) return data.enchantments.map(e=>({id:e.id,name:bot.registry.enchantments?.[e.id]?.name || null,level:e.level}))
  return (item.enchants || []).map(e=>({name:e.name,level:e.lvl}))
}
module.exports={enchantments}
