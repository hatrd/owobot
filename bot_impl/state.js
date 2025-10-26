function ensureMap (value) {
  return value instanceof Map ? value : new Map()
}

function ensureSet (value) {
  return value instanceof Set ? value : new Set()
}

function ensureArray (value) {
  return Array.isArray(value) ? value : []
}

function prepareSharedState (existing, { greetEnabled, loginPassword } = {}) {
  const state = existing || {}
  state.pendingGreets = ensureMap(state.pendingGreets)
  state.greetedPlayers = ensureSet(state.greetedPlayers)
  state.cleanups = ensureArray(state.cleanups)
  state.greetZones = ensureArray(state.greetZones)
  state.worldMemoryZones = ensureArray(state.worldMemoryZones)
  state.readyForGreeting = Boolean(state.readyForGreeting)
  state.extinguishing = Boolean(state.extinguishing)
  state.hasSpawned = Boolean(state.hasSpawned)
  state.autoLookSuspended = Boolean(state.autoLookSuspended)
  state.greetingEnabled = typeof state.greetingEnabled === 'boolean' ? state.greetingEnabled : Boolean(greetEnabled)
  state.greetZonesSeeded = Boolean(state.greetZonesSeeded)
  state.greetLogEnabled = Boolean(state.greetLogEnabled)
  state.externalBusyCount = Number.isFinite(state.externalBusyCount) && state.externalBusyCount > 0 ? state.externalBusyCount : 0
  state.externalBusy = Boolean(state.externalBusy)
  if (!state.currentTask) state.currentTask = null
  if (loginPassword) state.loginPassword = loginPassword
  return state
}

module.exports = { prepareSharedState }
