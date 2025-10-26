// Auto-plant saplings periodically when inventory has any *_sapling
const { Vec3 } = require('vec3')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  const L = log || { info: (...a) => console.log('[PLANT]', ...a), debug: (...a) => dlog && dlog(...a), warn: (...a) => console.warn('[PLANT]', ...a) }

  const S = state.autoPlant = state.autoPlant || {}
  const cfg = S.cfg = Object.assign({ enabled: true, tickMs: 3000, radius: 6, maxPerTick: 4, spacing: 3 }, S.cfg || {})
  const MIN_SPACING = new Map([
    ['oak_sapling', 2],
    ['birch_sapling', 2],
    ['spruce_sapling', 2],
    ['jungle_sapling', 2],
    ['cherry_sapling', 2],
    ['acacia_sapling', 3],
    ['dark_oak_sapling', 3],
    ['mangrove_propagule', 3]
  ])

  const MIN_SPACING_FALLBACK = 2

  function spacingFor (name) {
    if (!name) return Math.max(cfg.spacing, MIN_SPACING_FALLBACK)
    const key = String(name).toLowerCase()
    if (MIN_SPACING.has(key)) return Math.max(cfg.spacing, MIN_SPACING.get(key))
    return Math.max(cfg.spacing, MIN_SPACING_FALLBACK)
  }
  let running = false
  let timer = null
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  let pathfinderPkg = null

  function ensurePathfinder () {
    try {
      if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder)
      return true
    } catch { return false }
  }

  function getMcData () {
    if (bot.mcData) return bot.mcData
    try { return require('minecraft-data')(bot.version) } catch { return null }
  }

  function isSolidSupport (block) {
    try {
      if (!block) return false
      const name = String(block.name || '').toLowerCase()
      if (!name || name === 'air') return false
      if (name.includes('water') || name.includes('lava') || name.includes('bubble_column') || name.includes('fire')) return false
      if (block.boundingBox && block.boundingBox !== 'block') return false
      const mcData = getMcData()
      const info = mcData?.blocks?.[block.type]
      if (info && info.boundingBox && info.boundingBox !== 'block') return false
      return true
    } catch { return false }
  }

  function isPassable (block) {
    try {
      if (!block) return true
      const name = String(block.name || '').toLowerCase()
      if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return true
      if (block.boundingBox && block.boundingBox === 'empty') return true
      if (['tall_grass','short_grass','grass','fern','large_fern','dead_bush','seagrass','snow'].includes(name)) return true
      return false
    } catch { return false }
  }

  async function manualBackstep () {
    if (!bot.entity || !bot.entity.position) return
    const origin = bot.entity.position.clone()
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    const strafe = Math.random() < 0.5 ? 'left' : 'right'
    try {
      bot.setControlState('back', true)
      bot.setControlState(strafe, true)
      const until = Date.now() + 500
      while (Date.now() < until) {
        await sleep(60)
        const pos = bot.entity?.position
        if (!pos) break
        if (pos.distanceTo(origin) >= 0.8) break
      }
    } finally {
      try { bot.clearControlStates() } catch {}
    }
  }

  async function vacateSaplings (placements) {
    if (!bot.entity || !bot.entity.position) return
    if (state.externalBusy) return
    const last = Array.isArray(placements) && placements.length ? placements[placements.length - 1] : null
    const block = last?.block
    const targetPos = block ? new Vec3(block.x, block.y, block.z) : null
    if (!targetPos) { await manualBackstep(); return }
    const me = bot.entity.position
    const saplingCenter = targetPos.offset(0.5, 0, 0.5)
    if (me.distanceTo(saplingCenter) >= 1.6) return
    if (!ensurePathfinder()) { await manualBackstep(); return }
    const { Movements, goals } = pathfinderPkg
    const mcData = getMcData()
    const moveProfile = new Movements(bot, mcData)
    moveProfile.canDig = false
    moveProfile.allowSprinting = false
    try { moveProfile.allowParkour = false } catch {}
    try { moveProfile.allowParkourPlace = false } catch {}
    try { moveProfile.allow1by1towers = false } catch {}
    bot.pathfinder.setMovements(moveProfile)
    const offsets = [[2, 0], [0, 2], [-2, 0], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 1], [-2, 1], [1, 2], [-1, 2], [2, -1], [-2, -1], [1, -2], [-1, -2]]
    for (const [dx, dz] of offsets) {
      const foot = targetPos.offset(dx, 0, dz)
      const support = bot.blockAt(foot.offset(0, -1, 0))
      if (!isSolidSupport(support)) continue
      const footBlock = bot.blockAt(foot)
      if (!isPassable(footBlock)) continue
      const headBlock = bot.blockAt(foot.offset(0, 1, 0))
      if (!isPassable(headBlock)) continue
      const center = foot.offset(0.5, 0, 0.5)
      try { bot.pathfinder.setGoal(new goals.GoalNear(center.x, center.y, center.z, 0.4), true) } catch { continue }
      const until = Date.now() + 2000
      let success = false
      while (Date.now() < until) {
        await sleep(100)
        const pos = bot.entity?.position
        if (!pos) break
        if (pos.distanceTo(center) <= 0.7) { success = true; break }
        if (pos.distanceTo(saplingCenter) >= 1.6) { success = true; break }
        if (!bot.pathfinder?.goal) {
          success = pos.distanceTo(center) <= 1.2 || pos.distanceTo(saplingCenter) >= 1.6
          break
        }
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      if (success) return
    }
    await manualBackstep()
    const after = bot.entity?.position
    if (after && after.distanceTo(saplingCenter) < 1.6) await manualBackstep()
  }

  function listSaplings () {
    try {
      const inv = bot.inventory?.items() || []
      const byName = new Map()
      for (const it of inv) {
        const n = String(it?.name || '').toLowerCase()
        if (!n.endsWith('_sapling') && n !== 'mangrove_propagule') continue
        byName.set(n, (byName.get(n) || 0) + (it.count || 0))
      }
      return Array.from(byName.entries()).map(([name, count]) => ({ name, count }))
    } catch { return [] }
  }

  function busy () {
    try { if (!bot.entity || !bot.entity.position) return true } catch { return true }
    try { if (bot.isSleeping) return true } catch {}
    try { if (state.externalBusy) return true } catch {}
    try { if (bot.pathfinder && bot.pathfinder.goal) return true } catch {}
    return false
  }

  async function tick () {
    if (!cfg.enabled || running) return
    if (busy()) { if (cfg.debug) L.debug('skip: busy') ; return }
    const saplings = listSaplings()
    if (!saplings.length) { if (cfg.debug) L.debug('skip: no saplings') ; return }
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
          // adaptive radius attempts: cfg.radius -> +6 -> +10
          const attempts = [cfg.radius, cfg.radius + 6, cfg.radius + 10]
          let ok = false
          let lastResult = null
          const spacing = spacingFor(s.name)
          for (const rad of attempts) {
            const r = await actions.run('place_blocks', { item: s.name, area: { radius: Math.max(2, rad) }, max: Math.min(remain, 3), spacing })
            if (r && r.ok) { ok = true; lastResult = r; break }
          }
          if (ok) {
            planted += 1
            try { await vacateSaplings(lastResult?.placed) } catch {}
          }
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
  // Try planting shortly after external actions end to avoid starvation
  on('external:end', () => { setTimeout(() => { tick().catch(()=>{}) }, 250) })

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
      case 'spacing': {
        const parsed = Math.max(1, parseInt(val || '4', 10))
        cfg.spacing = parsed
        console.log('[PLANT] spacing=', cfg.spacing, '(实际间距≥品种要求)')
        break
      }
      default: console.log('[PLANT] usage: .autoplant on|off|status|interval ms|radius N|max N|spacing N')
    }
  })

  registerCleanup && registerCleanup(() => { stop() })
}

module.exports = { install }
