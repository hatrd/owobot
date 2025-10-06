// Auto counter-attack when the bot is hurt, with a cute chat line.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  let lastHealth = null
  const swings = new Map() // entityId -> timestamp
  let counterIv = null
  let counterCtx = {}
  let counterUntil = 0
  let targetId = null
  let lastCuteAt = 0

  function now () { return Date.now() }

  function stopCounter () {
    if (counterIv) { try { clearInterval(counterIv) } catch {} ; counterIv = null }
    targetId = null
    try { require('./pvp').stopMoveOverrides(bot) } catch {}
  }

  function entityDistance (a, b) { try { return a.position.distanceTo(b.position) } catch { return Infinity } }

  function findLikelyAttacker () {
    const me = bot.entity
    if (!me) return null
    const nowTs = now()
    let best = null; let bestD = Infinity
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === me || !e.position) continue
      if (!(e.type === 'player' || e.type === 'mob')) continue
      const d = entityDistance(me, e)
      if (d > 6.0) continue
      const swingTs = swings.get(e.id) || 0
      const recentSwing = (nowTs - swingTs) <= 700
      if (recentSwing && d < bestD) { best = e; bestD = d }
    }
    if (best) return best
    // fallback: nearest within 3.5 blocks
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === me || !e.position) continue
      if (!(e.type === 'player' || e.type === 'mob')) continue
      const d = entityDistance(me, e)
      if (d <= 3.5 && d < bestD) { best = e; bestD = d }
    }
    return best
  }

  function cuteLine () {
    const options = [
      '不要打我嘛(>_<)~',
      '你坏坏！反击啦！',
      '哼(｀・ω・´)ノ 还手！',
      '诶诶…好痛！',
      '别欺负我喔 QAQ'
    ]
    return options[Math.floor(Math.random() * options.length)]
  }

  function maybeCuteChat () {
    const COOL = 8000
    if (now() - lastCuteAt < COOL) return
    lastCuteAt = now()
    try { bot.chat(cuteLine()) } catch {}
  }

  function triggerCounter () {
    const pvp = require('./pvp')
    const first = findLikelyAttacker()
    if (!first) return
    maybeCuteChat()

    // If attacker is a player, do a single quick counter hit and stop.
    if (first.type === 'player') {
      ;(async () => {
        try { await pvp.ensureBestWeapon(bot) } catch {}
        try { await pvp.ensureShieldEquipped(bot) } catch {}
        const start = now()
        let attacked = false
        const iv = setInterval(() => {
          try {
            const t = bot.entities?.[first.id]
            if (!t) { clearInterval(iv); return }
            const d = entityDistance(bot.entity, t)
            if (!Number.isFinite(d) || d > 6.0) { clearInterval(iv); return }
            try { bot.lookAt(t.position.offset(0, 1.4, 0), true) } catch {}
            // Do not hold up shield here to avoid blocking our swing
            if (!attacked && d <= 2.5) {
              try { bot.attack(t); attacked = true } catch {}
              setTimeout(() => { try { pvp.stopMoveOverrides(bot) } catch {} }, 120)
              clearInterval(iv)
              return
            }
            if ((now() - start) > 1500) { clearInterval(iv); try { pvp.stopMoveOverrides(bot) } catch {} }
          } catch { clearInterval(iv) }
        }, 120)
      })()
      return
    }

    // For mobs or unknown, short auto-counter window with smart blocking
    targetId = first.id
    counterCtx = counterCtx || {}
    counterUntil = now() + 3500
    if (counterIv) return // already running; timers refreshed
    counterIv = setInterval(() => {
      try {
        const me = bot.entity
        if (!me) { stopCounter(); return }
        let t = bot.entities?.[targetId]
        if (!t) { t = findLikelyAttacker() ; if (t) targetId = t.id }
        if (!t) { stopCounter(); return }
        const d = entityDistance(me, t)
        if (!Number.isFinite(d) || d > 8.0) { stopCounter(); return }
        try { pvp.pvpTick(bot, t, counterCtx) } catch {}
        if (now() > counterUntil) { stopCounter(); return }
      } catch { /* ignore */ }
    }, 140)
  }

  function onSwing (entity) {
    try { if (entity?.id != null) swings.set(entity.id, now()) } catch {}
  }

  function onHurt (entity) {
    try { if (entity === bot.entity) triggerCounter() } catch {}
  }

  function onHealth () {
    try {
      const h = bot.health
      if (lastHealth == null) { lastHealth = h; return }
      if (h < lastHealth - 0.1) triggerCounter()
      lastHealth = h
    } catch {}
  }

  on('entitySwingArm', onSwing)
  on('entityHurt', onHurt)
  on('health', onHealth)
  on('agent:stop_all', () => { try { stopCounter() } catch {} })

  registerCleanup && registerCleanup(() => { stopCounter() })
}

module.exports = { install }
