// Explicit persistent task holds prevent background inventory transformations.
function held (state, item, now = Date.now()) {
  if (state.knowledge?.error) return true
  return (state.knowledge?.document?.records || []).some(r => r.kind === 'task' && r.confidence === 'observed' && (!r.expiresAt || r.expiresAt > now) && r.inventoryHold?.includes(item))
}
module.exports = { held }
