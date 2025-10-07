// Auto-stash: periodically deposit inventory to nearest container when nearly full.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const L = log || { info: (...a) => console.log('[STASH]', ...a), debug: (...a) => dlog && dlog(...a), warn: (...a) => console.warn('[STASH]', ...a) }

  const S = state.autoStash = state.autoStash || {}
  const cfg = S.cfg = Object.assign({ enabled: true, intervalMs: 12000, minFree: 4, radius: 18, debug: false }, S.cfg || {})
  let timer = null
  let running = false

  function invEmptyCount () {
    try {
      const slots = bot.inventory?.slots || []
      let free = 0
      for (let i = 9; i <= 44; i++) { if (!slots[i]) free++ }
      return free
    } catch { return 0 }
  }

  function listByName () {
    try {
      const inv = bot.inventory?.items() || []
      const by = new Map()
      for (const it of inv) { const n = String(it?.name || '').toLowerCase(); if (!n) continue; by.set(n, (by.get(n) || 0) + (it.count || 0)) }
      return Array.from(by.keys())
    } catch { return [] }
  }

  function isProtected (name) {
    const n = String(name || '').toLowerCase()
    if (!n) return false
    if (n.endsWith('_sapling')) return true
    if (n.endsWith('_axe') || n.endsWith('_pickaxe') || n.endsWith('_shovel') || n.endsWith('_hoe') || n.endsWith('_sword')) return true
    if (['fishing_rod','shears','shield','bow','crossbow','flint_and_steel','bucket','water_bucket','lava_bucket','milk_bucket'].includes(n)) return true
    return false
  }

  async function tick () {
    if (!cfg.enabled || running) return
    // skip if busy or in window or not ready
    try { if (!bot.entity || !bot.entity.position) return } catch { return }
    try { if (state.externalBusy) return } catch {}
    try { if (bot.currentWindow) return } catch {}
    const free = invEmptyCount()
    if (free > Math.max(0, cfg.minFree || 0)) return
    running = true
    try {
      const names = listByName().filter(n => !isProtected(n))
      if (!names.length) return
      const actions = require('./actions').install(bot, { log })
      L.info('stash -> free=', free, 'items=', names.length)
      const r = await actions.run('deposit', { names, radius: Math.max(8, cfg.radius || 18), includeBarrel: true })
      if (!r || !r.ok) L.warn('stash fail:', r && r.msg)
    } catch (e) { L.warn('stash error:', e?.message || e) }
    finally { running = false }
  }

  function start () { if (!timer) timer = setInterval(() => { tick().catch(()=>{}) }, Math.max(3000, cfg.intervalMs)) }
  function stop () { if (timer) { try { clearInterval(timer) } catch {} ; timer = null } }

  on('spawn', start)
  if (state?.hasSpawned) start()
  start()
  on('end', stop)
  on('agent:stop_all', () => { /* no-op */ })
  registerCleanup && registerCleanup(() => { stop() })

  // CLI: .stash on|off|status|minfree N|interval ms|radius N|debug on|off
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'stash') return
    const sub = (args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[STASH] enabled'); break
      case 'off': cfg.enabled = false; console.log('[STASH] disabled'); break
      case 'status': console.log('[STASH] enabled=', cfg.enabled, 'intervalMs=', cfg.intervalMs, 'minFree=', cfg.minFree, 'radius=', cfg.radius, 'debug=', cfg.debug); break
      case 'interval': cfg.intervalMs = Math.max(3000, parseInt(val || '12000', 10)); console.log('[STASH] intervalMs=', cfg.intervalMs); break
      case 'minfree': cfg.minFree = Math.max(0, parseInt(val || '4', 10)); console.log('[STASH] minFree=', cfg.minFree); break
      case 'radius': cfg.radius = Math.max(6, parseInt(val || '18', 10)); console.log('[STASH] radius=', cfg.radius); break
      case 'debug': cfg.debug = (String(val || 'on').toLowerCase() !== 'off'); console.log('[STASH] debug=', cfg.debug); break
      default: console.log('[STASH] usage: .stash on|off|status|minfree N|interval ms|radius N|debug on|off')
    }
  })
}

module.exports = { install }

