// Listen for in-game chat command "#bot here" and send "/tpa <username>"

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)

  const S = state.tpaHere = state.tpaHere || {}
  const cfg = S.cfg = Object.assign({ enabled: true, cooldownMs: 6000, acceptEnabled: true, acceptCooldownMs: 1500 }, S.cfg || {})

  const lastByUser = S.lastByUser = S.lastByUser || new Map()
  let lastAcceptAt = S.lastAcceptAt || 0
  let lastReqAt = S.lastReqAt || 0
  let lastReqUser = S.lastReqUser || null

  function now () { return Date.now() }

  function getMinimalSelf () {
    try { return require('./minimal-self').getInstance() } catch { return null }
  }

  function recordTeleportAchievement (kind, player = null) {
    const ms = getMinimalSelf()
    if (!ms) return
    try { ms.getIdentity?.().recordSkillOutcome?.(kind, true, 0.95) } catch {}
    try { ms.getNarrative?.().recordDid?.(`传送:${kind}`, player || null, 'teleport') } catch {}
  }

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
      recordTeleportAchievement('tpa', username)
      try {
        if (Array.isArray(state.aiRecent)) {
          state.aiRecent.push({ kind: 'bot', content: cmd, t: now() })
        }
      } catch {}
    } catch {}
  }

  on('chat', onChat)
  function strip (s) { return String(s || '').replace(/\u00a7./g, '') }
  function onMessage (message) {
    try {
      if (!cfg.acceptEnabled) return
      const t = strip(typeof message.toAnsi === 'function' ? message.toAnsi() : (typeof message.toString === 'function' ? message.toString() : String(message)))
      if (!t) return
      // Detect common TPA prompts (Chinese & English variants)
      const hasTpacceptHint = /\b\/tpaccept\b/i.test(t) || /若想接受传送/.test(t)
      const isRequestToMe = /请求传送到你这里|has requested to teleport to you|请求传送到你|teleport to you/i.test(t)
      if (isRequestToMe) {
        lastReqAt = now(); S.lastReqAt = lastReqAt
        // Best-effort player extraction
        const m = t.match(/^([A-Za-z0-9_\\.]+)/)
        if (m && m[1]) { lastReqUser = m[1]; S.lastReqUser = lastReqUser }
      }
      const recentReq = (now() - lastReqAt) <= 5000
      if (hasTpacceptHint && recentReq) {
        if (now() - lastAcceptAt < Math.max(300, cfg.acceptCooldownMs || 0)) return
        lastAcceptAt = now(); S.lastAcceptAt = lastAcceptAt
        try { bot.chat('/tpaccept') } catch {}
        dlog && dlog('[tpa] auto /tpaccept')
        try {
          if (Array.isArray(state.aiRecent)) {
            state.aiRecent.push({ kind: 'bot', content: '/tpaccept', t: now() })
          }
        } catch {}
        recordTeleportAchievement('tpaccept', lastReqUser || null)
      }
    } catch {}
  }
  on('message', onMessage)
  registerCleanup && registerCleanup(() => { try { bot.off('chat', onChat) } catch {} })
  registerCleanup && registerCleanup(() => { try { bot.off('message', onMessage) } catch {} })

  // CLI: .tpa on|off|status|cooldown ms|accept on|off|acceptcd ms
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'tpa') return
    const sub = String(args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[TPA] enabled'); break
      case 'off': cfg.enabled = false; console.log('[TPA] disabled'); break
      case 'status': console.log('[TPA] enabled=', cfg.enabled, 'cooldownMs=', cfg.cooldownMs, 'acceptEnabled=', cfg.acceptEnabled, 'acceptCooldownMs=', cfg.acceptCooldownMs); break
      case 'cooldown': cfg.cooldownMs = Math.max(0, parseInt(val || '6000', 10)); console.log('[TPA] cooldownMs=', cfg.cooldownMs); break
      case 'accept': cfg.acceptEnabled = (String(val || 'on').toLowerCase() !== 'off'); console.log('[TPA] acceptEnabled=', cfg.acceptEnabled); break
      case 'acceptcd': cfg.acceptCooldownMs = Math.max(0, parseInt(val || '1500', 10)); console.log('[TPA] acceptCooldownMs=', cfg.acceptCooldownMs); break
      default: console.log('[TPA] usage: .tpa on|off|status|cooldown ms')
    }
  })
}

module.exports = { install }
