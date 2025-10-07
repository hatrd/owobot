// Auto-plant saplings periodically when inventory has any *_sapling

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  const L = log || { info: (...a) => console.log('[PLANT]', ...a), debug: (...a) => dlog && dlog(...a), warn: (...a) => console.warn('[PLANT]', ...a) }

  const S = state.autoPlant = state.autoPlant || {}
  const cfg = S.cfg = Object.assign({ enabled: true, tickMs: 3000, radius: 6, maxPerTick: 4, spacing: 3 }, S.cfg || {})
  let running = false
  let timer = null

  function listSaplings () {
    try {
      const inv = bot.inventory?.items() || []
      const byName = new Map()
      for (const it of inv) {
        const n = String(it?.name || '').toLowerCase()
        if (!n.endsWith('_sapling')) continue
        byName.set(n, (byName.get(n) || 0) + (it.count || 0))
      }
      return Array.from(byName.entries()).map(([name, count]) => ({ name, count }))
    } catch { return [] }
  }

  function busy () {
    try { if (!bot.entity || !bot.entity.position) return true } catch { return true }
    try { if (bot.pathfinder && bot.pathfinder.goal) return true } catch {}
    try { if (bot.isSleeping) return true } catch {}
    try { if (state.externalBusy) return true } catch {}
    return false
  }

  async function tick () {
    if (!cfg.enabled || running) return
    if (busy()) return
    const saplings = listSaplings()
    if (!saplings.length) return
    running = true
    try {
      try { if (state) state.currentTask = { name: 'auto_plant', source: 'auto', startedAt: Date.now() } } catch {}
      const actions = require('./actions').install(bot, { log })
      let planted = 0
      const total = saplings.reduce((a, s) => a + (s.count || 0), 0)
      const burstMax = total >= 16 ? Math.max(cfg.maxPerTick, 6) : cfg.maxPerTick
      for (const s of saplings) {
        if (state.externalBusy) break
        if (planted >= burstMax) break
        try {
          const remain = Math.max(1, burstMax - planted)
          const r = await actions.run('place_blocks', { item: s.name, area: { radius: cfg.radius }, max: Math.min(remain, 3), spacing: cfg.spacing })
          if (r && r.ok) planted += 1
        } catch {}
      }
      if (planted > 0) L.info('auto planted', planted)
    } finally {
      try { if (state && state.currentTask && state.currentTask.name === 'auto_plant') state.currentTask = null } catch {}
      running = false
    }
  }

  function start () { if (!timer) timer = setInterval(() => { tick().catch(()=>{}) }, Math.max(1500, cfg.tickMs)) }
  function stop () { if (timer) { try { clearInterval(timer) } catch {} ; timer = null } }

  on('spawn', start)
  if (state?.hasSpawned) start()
  // Start immediately on install to handle hot-reload order
  start()
  on('end', stop)
  on('agent:stop_all', () => { /* keep enabled, just pause this cycle */ })

  // CLI: .autoplant on|off|status|interval ms|radius N|max N|spacing N
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'autoplant') return
    const sub = (args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[PLANT] enabled'); break
      case 'off': cfg.enabled = false; console.log('[PLANT] disabled'); break
      case 'status': console.log('[PLANT] enabled=', cfg.enabled, 'tickMs=', cfg.tickMs, 'radius=', cfg.radius, 'maxPerTick=', cfg.maxPerTick, 'spacing=', cfg.spacing); break
      case 'interval': cfg.tickMs = Math.max(1500, parseInt(val || '8000', 10)); console.log('[PLANT] tickMs=', cfg.tickMs); try { if (timer) clearInterval(timer) } catch {}; timer = null; start(); break
      case 'radius': cfg.radius = Math.max(2, parseInt(val || '6', 10)); console.log('[PLANT] radius=', cfg.radius); break
      case 'max': cfg.maxPerTick = Math.max(1, parseInt(val || '2', 10)); console.log('[PLANT] maxPerTick=', cfg.maxPerTick); break
      case 'spacing': cfg.spacing = Math.max(1, parseInt(val || '4', 10)); console.log('[PLANT] spacing=', cfg.spacing); break
      default: console.log('[PLANT] usage: .autoplant on|off|status|interval ms|radius N|max N|spacing N')
    }
  })

  registerCleanup && registerCleanup(() => { stop() })
}

module.exports = { install }
