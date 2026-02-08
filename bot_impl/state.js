function ensureMap (value) {
  return value instanceof Map ? value : new Map()
}

function ensureSet (value) {
  return value instanceof Set ? value : new Set()
}

function ensureArray (value) {
  return Array.isArray(value) ? value : []
}

function ensureObject (value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function prepareSharedState (existing, { greetEnabled, loginPassword, voiceEnabled } = {}) {
  const state = existing || {}
  state.pendingGreets = ensureMap(state.pendingGreets)
  state.greetedPlayers = ensureSet(state.greetedPlayers)
  state.greetHistory = ensureMap(state.greetHistory)
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
  state.voiceChat = ensureObject(state.voiceChat)
  state.voiceChat.enabled = typeof state.voiceChat.enabled === 'boolean'
    ? state.voiceChat.enabled
    : (typeof voiceEnabled === 'boolean' ? voiceEnabled : true)
  state.voiceChat.available = Boolean(state.voiceChat.available)
  state.voiceChat.pluginLoaded = Boolean(state.voiceChat.pluginLoaded)
  state.voiceChat.connected = Boolean(state.voiceChat.connected)
  if (!('lastError' in state.voiceChat)) state.voiceChat.lastError = null
  if (!('lastAudioPath' in state.voiceChat)) state.voiceChat.lastAudioPath = null
  if (!('lastAudioAt' in state.voiceChat)) state.voiceChat.lastAudioAt = null
  if (!('lastSpeaker' in state.voiceChat)) state.voiceChat.lastSpeaker = null
  if (!('lastSpeakerAt' in state.voiceChat)) state.voiceChat.lastSpeakerAt = null
  if (!('lastConnectAt' in state.voiceChat)) state.voiceChat.lastConnectAt = null
  if (!('lastDisconnectAt' in state.voiceChat)) state.voiceChat.lastDisconnectAt = null
  // Player stats module state
  if (!state.playerStats) state.playerStats = {}
  state.playerStats.activeSessions = ensureMap(state.playerStats.activeSessions)
  // Shared runtime for actions/tools (interval handles, abort flags, debug toggles, etc.)
  if (!state.actionsRuntime || typeof state.actionsRuntime !== 'object') state.actionsRuntime = {}
  return state
}

module.exports = { prepareSharedState }
