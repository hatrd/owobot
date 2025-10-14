// Auto-back: when the server prompts "使用/back命令回到死亡地点" (or English equivalent),
// immediately send /back and attempt to collect nearby drops for a short period.

function install (bot, { on, state, log, dlog, registerCleanup }) {
  const L = log

  if (typeof state.autoBackCooldownUntil !== 'number') state.autoBackCooldownUntil = 0
  if (typeof state.backInProgress !== 'boolean') state.backInProgress = false
  if (typeof state.backLastCmdAt !== 'number') state.backLastCmdAt = 0
  let attemptId = 0

  function normalizeMessage (message) {
    try {
      const text = typeof message.getText === 'function' ? message.getText() : (typeof message.toString === 'function' ? message.toString() : String(message))
      return (text || '').replace(/\u00a7./g, '')
    } catch { return '' }
  }

  function shouldTriggerBack (s) {
    const t = String(s || '')
    if (!t) return false
    // Common CN variants
    if (/使用\s*\/back.*死亡地点/i.test(t)) return true
    if (/(回到|返回).*死亡地点/i.test(t) && /\/back/i.test(t)) return true
    // EN variants
    if (/use\s*\/back.*death/i.test(t)) return true
    if (/return\s+to\s+(your\s+)?death(\s+(point|location|spot))?/i.test(t)) return true
    return false
  }

  async function runPickupRoutine (id) {
    let actions = null
    try { actions = require('./actions').install(bot, { log: L }) } catch {}
    if (!actions) return
    try { bot.emit('external:begin', { source: 'auto', tool: 'back_collect' }) } catch {}
    try { if (bot.state) bot.state.externalBusy = true } catch {}
    try {
      // Allow teleport settle (debounce 1.5s before collecting)
      await new Promise(r => setTimeout(r, 1500))
      // If a newer attempt superseded this one, abort silently
      if (id !== attemptId || !state.backInProgress) return
      await actions.run('collect', { radius: 16, max: 200, timeoutMs: 12000, until: 'timeout' })
    } catch {} finally {
      try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      try { bot.emit('external:end', { source: 'auto', tool: 'back_collect' }) } catch {}
      try { if (bot.state) bot.state.externalBusy = false } catch {}
      // Clear back-in-progress after routine finishes (or is skipped)
      state.backInProgress = false
    }
  }

  async function onMessage (message) {
    try {
      const s = normalizeMessage(message)
      const now = Date.now()
      if (shouldTriggerBack(s)) {
        if (now < (state.autoBackCooldownUntil || 0)) return
        state.autoBackCooldownUntil = now + 15000 // 15s debounce
        state.backInProgress = true
        try { if (bot.state) bot.state.externalBusy = true } catch {}
        state.backLastCmdAt = now
        attemptId++
        try { bot.chat('/back') } catch {}
        // Run pickup routine but do not block the main thread
        runPickupRoutine(attemptId).catch(() => {})
        return
      }
      // Retry if teleport request got canceled
      if (/待处理的传送请求已被取消/i.test(s)) {
        if (!state.backInProgress) return
        // Re-issue /back shortly after (avoid immediate spam)
        if (now - (state.backLastCmdAt || 0) < 800) return
        setTimeout(() => {
          try {
            state.backLastCmdAt = Date.now()
            attemptId++
            bot.chat('/back')
            runPickupRoutine(attemptId).catch(() => {})
          } catch {}
        }, 800)
        return
      }
    } catch {}
  }

  // If we respawn while in back flow, try /back again after a short delay
  on('respawn', () => {
    try {
      if (!state.backInProgress) return
      const now = Date.now()
      if (now - (state.backLastCmdAt || 0) < 800) return
      setTimeout(() => {
        try {
          state.backLastCmdAt = Date.now()
          attemptId++
          bot.chat('/back')
          runPickupRoutine(attemptId).catch(() => {})
        } catch {}
      }, 800)
    } catch {}
  })

  on('message', onMessage)
  registerCleanup && registerCleanup(() => { try { bot.off('message', onMessage) } catch {} })
}

module.exports = { install }
