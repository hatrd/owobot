// Mineflayer's shared oxygenLevel may be overwritten by other entities on metadata-key versions.
// Read only the current player's metadata with the registry's explicit field mapping.
function oxygen (bot) {
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys
  if (Array.isArray(keys)) {
    const index = keys.indexOf('air_supply')
    const ticks = index >= 0 ? bot.entity?.metadata?.[index] : undefined
    return { level: Number.isFinite(ticks) ? Math.round(ticks / 15) : null, airTicks: Number.isFinite(ticks) ? ticks : null, source: 'self_entity_metadata' }
  }
  // Legacy Mineflayer breath plugin filters packet.entityId to the bot before updating this field.
  return { level: Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : null, airTicks: null, source: 'legacy_self_breath' }
}
module.exports = { oxygen }
