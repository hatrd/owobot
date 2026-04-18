const { hasListedSelf } = require('./tablist-utils')

const DEFAULT_SPAWN_TIMEOUT_MS = 45_000
const DEFAULT_TAB_READY_TIMEOUT_MS = 12_000
const DEFAULT_TAB_POLL_INTERVAL_MS = 500

function terminateBot (bot, reason) {
  if (bot && typeof bot.quit === 'function') {
    bot.quit(reason)
    return true
  }
  if (bot && typeof bot.end === 'function') {
    bot.end(reason)
    return true
  }
  if (bot && bot._client && typeof bot._client.end === 'function') {
    bot._client.end(reason)
    return true
  }
  return false
}

function createReconnectReadinessGuard (bot, options = {}) {
  const spawnTimeoutMs = Number.isFinite(Number(options.spawnTimeoutMs)) ? Math.max(1, Math.floor(Number(options.spawnTimeoutMs))) : DEFAULT_SPAWN_TIMEOUT_MS
  const tabReadyTimeoutMs = Number.isFinite(Number(options.tabReadyTimeoutMs)) ? Math.max(1, Math.floor(Number(options.tabReadyTimeoutMs))) : DEFAULT_TAB_READY_TIMEOUT_MS
  const tabPollIntervalMs = Number.isFinite(Number(options.tabPollIntervalMs)) ? Math.max(1, Math.floor(Number(options.tabPollIntervalMs))) : DEFAULT_TAB_POLL_INTERVAL_MS
  const onReconnectReady = typeof options.onReconnectReady === 'function' ? options.onReconnectReady : null
  const onReady = typeof options.onReady === 'function' ? options.onReady : null
  const terminate = typeof options.terminate === 'function' ? options.terminate : terminateBot

  let finished = false
  let spawnTimer = null
  let tabReadyTimer = null
  let tabPoller = null

  function clearTimers () {
    if (spawnTimer) {
      clearTimeout(spawnTimer)
      spawnTimer = null
    }
    if (tabReadyTimer) {
      clearTimeout(tabReadyTimer)
      tabReadyTimer = null
    }
    if (tabPoller) {
      clearInterval(tabPoller)
      tabPoller = null
    }
  }

  function cleanup () {
    if (finished) return
    finished = true
    clearTimers()
    try { bot.off('spawn', handleSpawn) } catch {}
    try { bot.off('end', handleEnd) } catch {}
    try { bot.off('kicked', handleKicked) } catch {}
  }

  function succeed () {
    if (finished) return false
    cleanup()
    try { if (onReady) onReady() } catch {}
    return true
  }

  function fail (reason, terminateReason) {
    if (finished) return false
    cleanup()
    try { if (onReconnectReady) onReconnectReady(reason) } catch {}
    try { terminate(bot, terminateReason) } catch {}
    return true
  }

  function checkTabReady () {
    if (hasListedSelf(bot)) return succeed()
    return false
  }

  function startTabReadyWindow () {
    if (checkTabReady()) return
    tabReadyTimer = setTimeout(() => {
      fail('tab-not-ready', 'tab ready timeout')
    }, tabReadyTimeoutMs)
    tabPoller = setInterval(() => {
      checkTabReady()
    }, tabPollIntervalMs)
  }

  function handleSpawn () {
    if (finished) return
    if (spawnTimer) {
      clearTimeout(spawnTimer)
      spawnTimer = null
    }
    startTabReadyWindow()
  }

  function handleEnd () {
    cleanup()
  }

  function handleKicked () {
    cleanup()
  }

  try { bot.on('spawn', handleSpawn) } catch {}
  try { bot.on('end', handleEnd) } catch {}
  try { bot.on('kicked', handleKicked) } catch {}

  spawnTimer = setTimeout(() => {
    fail('spawn-timeout', 'spawn timeout')
  }, spawnTimeoutMs)

  return {
    cleanup,
    checkTabReady,
    status () {
      return { finished }
    }
  }
}

module.exports = {
  createReconnectReadinessGuard,
  _internal: {
    terminateBot,
    DEFAULT_SPAWN_TIMEOUT_MS,
    DEFAULT_TAB_READY_TIMEOUT_MS,
    DEFAULT_TAB_POLL_INTERVAL_MS
  }
}
