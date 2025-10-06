// Listen for in-game chat command "#bot here" and send "/tpa <username>"

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  const S = state.tpaHere = state.tpaHere || {}
  const cfg = S.cfg = Object.assign({ enabled: true, cooldownMs: 6000 }, S.cfg || {})

  const lastByUser = S.lastByUser = S.lastByUser || new Map()

  function now () { return Date.now() }

  function canTrigger (user) {
    const t = now()
    const last = lastByUser.get(user) || 0
    if (t - last < cfg.cooldownMs) return false
    lastByUser.set(user, t)
    return true
  }

  function onChat (username, message) {
    try {
      if (!cfg.enabled) return
      if (!username || username === bot.username) return
      const text = String(message || '').trim()
      if (!/^#bot\s+here$/i.test(text)) return
      if (!canTrigger(username)) return
      const cmd = `/tpa ${username}`
      dlog && dlog('[tpa] ->', cmd)
      try { bot.chat(cmd) } catch {}
    } catch {}
  }

  on('chat', onChat)
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChat) } catch {} })

  // CLI: .tpa on|off|status|cooldown ms
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'tpa') return
    const sub = String(args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[TPA] enabled'); break
      case 'off': cfg.enabled = false; console.log('[TPA] disabled'); break
      case 'status': console.log('[TPA] enabled=', cfg.enabled, 'cooldownMs=', cfg.cooldownMs); break
      case 'cooldown': cfg.cooldownMs = Math.max(0, parseInt(val || '6000', 10)); console.log('[TPA] cooldownMs=', cfg.cooldownMs); break
      default: console.log('[TPA] usage: .tpa on|off|status|cooldown ms')
    }
  })
}

module.exports = { install }
