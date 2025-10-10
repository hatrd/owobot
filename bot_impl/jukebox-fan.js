// Fun: Follow jukebox and bob head when music plays.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log
  let activeUntil = 0
  let lastPos = null
  let iv = null
  let phase = 0
  let pausedUntil = 0

  function isMusicSound (name) {
    const s = String(name || '').toLowerCase()
    return s.includes('jukebox') || s.includes('music_disc')
  }

  on('soundEffectHeard', (name, pos) => {
    if (!isMusicSound(name)) return
    lastPos = pos
    activeUntil = Date.now() + 12000 // 12s since last sound
    if (L && L.debug) L.debug('jukebox sound near', pos)
  })

  async function tick () {
    if (Date.now() < pausedUntil) return
    if (state?.externalBusy) return
    if (!lastPos || Date.now() > activeUntil) return
    try { if (bot.pathfinder && bot.pathfinder.goal) return } catch {}
    const me = bot.entity?.position
    if (!me) return
    const d = me.distanceTo(lastPos)
    // Face jukebox and bob head a bit
    try { bot.lookAt(lastPos.offset(0.5, 0.5, 0.5), false) } catch {}
    phase += 0.2
    const yaw = bot.entity.yaw
    const pitch = Math.sin(phase) * 0.2
    try { bot.look(yaw, pitch, false) } catch {}
    // Optionally sidestep closer if near but not too near
    if (d > 3 && d < 12) {
      try { bot.setControlState('forward', true); setTimeout(() => { try { bot.setControlState('forward', false) } catch {} }, 200) } catch {}
    }
  }

  function start () { if (!iv) iv = setInterval(() => { tick().catch(()=>{}) }, 100) }
  function stop () { if (iv) { try { clearInterval(iv) } catch {} ; iv = null } }

  on('spawn', start)
  start()
  on('agent:stop_all', () => { pausedUntil = Date.now() + 3000 })
  registerCleanup && registerCleanup(stop)
}

module.exports = { install }

