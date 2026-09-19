// Read item components, never open/place a box. Hidden component data stays unknown.
function read (bot) {
  return (bot.inventory?.items() || []).filter(i => i.name === 'shulker_box' || i.name.endsWith('_shulker_box')).map(item => {
    const component = item.componentMap?.get('container') || item.componentMap?.get('minecraft:container') || item.components?.find(c => ['container', 'minecraft:container'].includes(c.type))
    let contents = component?.data?.contents
    if (Array.isArray(contents)) return { slot: item.slot, name: item.name, source: 'item_component', items: contents.map((s, slot) => ({ slot, name: bot.registry.items[s.itemId]?.name, count: s.itemCount || 0 })).filter(i => i.count > 0) }
    if (item.nbt) {
      try {
        contents = require('prismarine-nbt').simplify(item.nbt)?.BlockEntityTag?.Items
        if (Array.isArray(contents)) return { slot: item.slot, name: item.name, source: 'item_nbt', items: contents.map(s => ({ slot: s.Slot, name: String(s.id).replace('minecraft:', ''), count: s.Count })) }
      } catch {}
    }
    return { slot: item.slot, name: item.name, source: 'unavailable', items: null }
  })
}
module.exports = { read }
