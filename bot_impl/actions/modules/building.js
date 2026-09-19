// Explicit crafting and one-block sign placement. No coordinate/name inference.
module.exports = function registerBuilding (ctx) {
  const { bot, register, ok, fail, Vec3, shared } = ctx
  const position = a => new Vec3(a.x, a.y, a.z)
  const near = p => bot.entity?.position && bot.entity.position.distanceTo(p) <= 4.5
  const count = type => (bot.inventory?.items() || []).filter(i => i.type === type).reduce((n, i) => n + i.count, 0)
  function plan (args) {
    const item = bot.registry?.itemsByName[args.item]
    if (!item) return fail('Unknown item', { error: 'unknown_item' })
    const recipes = bot.recipesAll(item.id, null, true)
    return ok('Crafting recipes', { data: { item: args.item, owned: count(item.id), recipes: recipes.map((r, index) => {
      const times = Math.ceil((args.count || 1) / r.result.count)
      const ingredients = r.delta.filter(d => d.count < 0).map(d => ({ item: bot.registry.items[d.id]?.name, needed: -d.count * times, available: count(d.id) }))
      return { index, times, output: times * r.result.count, requiresTable: r.requiresTable, ingredients, materialsReady: ingredients.every(i => i.available >= i.needed) }
    }) } })
  }
  async function locked (item, fn) {
    ctx.assertCanEquipHand(bot, item)
    if (shared.buildingBusy) return fail('Building operation active', { error: 'building_busy' })
    shared.buildingBusy = true
    const oldLock = bot.state?.holdItemLock
    const held = bot.heldItem
    if (bot.state) bot.state.holdItemLock = item
    try { return await fn() }
    finally {
      try { if (held && (bot.inventory?.items() || []).some(i => i.type === held.type)) await bot.equip(held, 'hand') } catch {}
      if (bot.state) bot.state.holdItemLock = oldLock
      shared.buildingBusy = false
    }
  }
  async function craft (args) {
    const preview = plan(args)
    if (!preview.ok) return preview
    const selected = preview.data.recipes[args.recipeIndex || 0]
    if (!selected) return fail('Recipe unavailable', { error: 'recipe_unavailable', data: preview.data })
    if (!selected.materialsReady) return fail('Missing ingredients', { error: 'missing_ingredients', data: selected })
    let table = null
    if (selected.requiresTable) {
      if (!args.table) return fail('Explicit crafting table position required', { error: 'table_required' })
      table = bot.blockAt(position(args.table))
      if (!table || table.name !== 'crafting_table' || !near(table.position)) return fail('Crafting table unavailable or out of reach', { error: 'invalid_table' })
    }
    return locked(args.item, async () => {
      const type = bot.registry.itemsByName[args.item].id
      const before = count(type)
      const recipe = bot.recipesAll(type, null, true)[selected.index]
      await bot.craft(recipe, selected.times, table)
      const deadline = Date.now() + 2000
      while (count(type) - before < selected.output && Date.now() < deadline) await ctx.wait(50)
      const produced = count(type) - before
      return produced >= selected.output ? ok('Craft confirmed', { data: { item: args.item, produced } }) : fail('Craft not confirmed', { error: 'craft_unconfirmed', data: { produced, expected: selected.output } })
    })
  }
  async function placeSign (args) {
    const target = position(args.position)
    const before = bot.blockAt(target)
    const reference = bot.blockAt(target.offset(0, -1, 0))
    if (!near(target)) return fail('Target out of reach', { error: 'out_of_reach' })
    if (!before || !['air', 'cave_air', 'void_air'].includes(before.name)) return fail('Target must be empty', { error: 'occupied_target' })
    if (!reference || reference.boundingBox !== 'block') return fail('Solid support required', { error: 'missing_support' })
    const item = (bot.inventory?.items() || []).find(i => i.name === args.item)
    if (!item || !item.name.endsWith('_sign') || item.name.endsWith('_hanging_sign')) return fail('Standing sign item required', { error: 'missing_sign_item' })
    return locked(args.item, async () => {
      const receipt = { position: args.position, lines: args.lines.slice(), at: Date.now(), stage: 'preparing' }
      shared.signPlacements ||= []
      shared.signPlacements.push(receipt)
      if (shared.signPlacements.length > 20) shared.signPlacements.shift()
      let editing = false
      const onEditor = packet => { if (packet.location && position(packet.location).equals(target)) editing = true }
      bot._client.on('open_sign_entity', onEditor)
      try {
        await bot.equip(item, 'hand')
        await bot.placeBlock(reference, new Vec3(0, 1, 0))
        receipt.stage = 'placed'
        const until = Date.now() + 1500
        while (!editing && Date.now() < until) await ctx.wait(50)
        if (!editing) return fail('Sign placed but editor permission not confirmed', { error: 'sign_editor_unavailable', data: receipt })
        const sign = bot.blockAt(target)
        bot.updateSign(sign, args.lines.join('\n'))
        receipt.stage = 'write_sent'
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
          await ctx.wait(100)
          const observed = await ctx.observer.detail(bot, { what: 'signs', radius: 6, max: 100 })
          const row = observed.data?.find(r => r.x === target.x && r.y === target.y && r.z === target.z)
          if (row && args.lines.every((line, i) => row.front[i] === line)) {
            receipt.stage = 'confirmed'; receipt.confirmedAt = Date.now()
            return ok('Sign placed and text read back', { data: { ...receipt, observed: row } })
          }
        }
        return fail('Sign placed; text not confirmed by server', { error: 'sign_write_unconfirmed', data: receipt })
      } catch (error) {
        return fail('Sign operation failed', { error: error.message, data: receipt })
      } finally { bot._client.off('open_sign_entity', onEditor) }
    })
  }
  register('craft_preview', args => plan(args))
  register('place_block', async args => {
    const target = position(args.position)
    const before = bot.blockAt(target)
    const reference = bot.blockAt(target.offset(0, -1, 0))
    if (!near(target)) return fail('Target out of reach', { error: 'out_of_reach' })
    if (!before || !['air', 'cave_air', 'void_air'].includes(before.name)) return fail('Target must be empty', { error: 'occupied_target' })
    if (reference?.boundingBox !== 'block') return fail('Solid support required', { error: 'missing_support' })
    if (!bot.registry?.blocksByName[args.item]) return fail('Block item required', { error: 'invalid_block_item' })
    const item = (bot.inventory?.items() || []).find(i => i.name === args.item)
    if (!item) return fail('Item unavailable', { error: 'missing_item' })
    return locked(args.item, async () => {
      await bot.equip(item, 'hand')
      await bot.placeBlock(reference, new Vec3(0, 1, 0))
      const actual = bot.blockAt(target)?.name || null
      return actual === args.item ? ok('Block placed', { data: { position: args.position, actual } }) : fail('Placement unconfirmed; inspect target before retrying', { error: 'place_unconfirmed', data: { position: args.position, actual } })
    })
  })
  register('dig_block', async args => {
    const target = position(args.position)
    const block = bot.blockAt(target)
    if (!near(target)) return fail('Target out of reach', { error: 'out_of_reach' })
    if (!block || block.name !== args.expected) return fail('Target changed', { error: 'block_mismatch', data: { actual: block?.name || null } })
    if (!bot.canDigBlock(block)) return fail('Target not diggable', { error: 'not_diggable' })
    const item = (bot.inventory?.items() || []).find(i => i.name === args.tool)
    if (!item) return fail('Tool unavailable', { error: 'missing_tool' })
    return locked(args.tool, async () => {
      await bot.equip(item, 'hand')
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
      const visible = bot.blockAtCursor(4.5)
      if (!visible?.position.equals(target)) return fail('Target obstructed', { error: 'obstructed', data: { actual: visible?.name || null } })
      await bot.dig(block, 'raycast')
      const actual = bot.blockAt(target)?.name || null
      return actual && actual !== args.expected ? ok('Block removed', { data: { position: args.position, removed: args.expected, actual } }) : fail('Removal unconfirmed', { error: 'dig_unconfirmed', data: { actual } })
    })
  })
  register('craft_item', craft)
  register('place_sign', placeSign)
}
