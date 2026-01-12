module.exports = function registerMovement (ctx) {
  const { bot, register, ok, fail, ensurePathfinder, wait, shared, pvp, Vec3 } = ctx
  const { isSelfEntity, resolvePlayerEntityExact } = require('../lib/self')

  function getPathfinder () {
    if (!ensurePathfinder()) return null
    return ctx.pathfinder
  }

  async function goto (args = {}) {
    const { x, y, z, range = 1.5 } = args
    if ([x, y, z].some(v => typeof v !== 'number')) return fail('缺少坐标')
    const pkg = getPathfinder()
    if (!pkg) return fail('无寻路')
    const { Movements, goals } = pkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true)
    m.allowSprinting = true
    try { m.allow1by1towers = false } catch {}
    try { m.allowParkour = false } catch {}
    try { m.allowParkourPlace = false } catch {}
    try { m.scafoldingBlocks = [] } catch {}
    try { m.scaffoldingBlocks = [] } catch {}
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range))
    return ok(`前往 ${x},${y},${z}`)
  }

  async function goto_block (args = {}) {
    let names = Array.isArray(args.names)
      ? args.names.map(n => String(n).toLowerCase().trim()).filter(Boolean)
      : (args.name ? [String(args.name).toLowerCase().trim()] : null)
    if (names && !names.length) names = null
    const match = args.match ? String(args.match).toLowerCase().trim() : null
    const wantsBedByNames = Array.isArray(names) && names.some(n => n === 'bed' || n.includes('床'))
    const wantsBedByMatch = typeof match === 'string' && match.length > 0 && (match === 'bed' || match.includes('床'))
    const wantsBed = wantsBedByNames || wantsBedByMatch
    const matchIsBed = match === 'bed'
    const blockMatches = (blockName) => {
      if (!blockName || blockName === 'air') return false
      if (names && names.includes(blockName)) return true
      if (match && match.length && !matchIsBed && blockName.includes(match)) return true
      if (wantsBed && blockName.endsWith('_bed')) return true
      return false
    }
    const radius = Math.max(2, parseInt(args.radius || '64', 10))
    const range = Math.max(1, parseFloat(args.range || '1.5'))
    if (!names && !match) return fail('缺少目标名（name|names|match）')
    if (!bot.entity || !bot.entity.position) return fail('未就绪')
    const pkg = getPathfinder()
    if (!pkg) return fail('无寻路')
    const { Movements, goals } = pkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true)
    m.allowSprinting = true
    try { m.allow1by1towers = false } catch {}
    try { m.allowParkour = false } catch {}
    try { m.allowParkourPlace = false } catch {}
    try { m.scafodingBlocks = [] } catch {}
    try { m.scaffoldingBlocks = [] } catch {}
    bot.pathfinder.setMovements(m)

    const me = bot.entity.position
    let candidates = bot.findBlocks({
      point: me,
      maxDistance: Math.max(2, radius),
      count: 128,
      matching: (b) => {
        try {
          if (!b) return false
          const n = String(b.name || '').toLowerCase()
          return blockMatches(n)
        } catch { return false }
      }
    }) || []

    if (!candidates.length) {
      try {
        const c = me.floored ? me.floored() : new Vec3(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
              const p = new Vec3(c.x + dx, c.y + dy, c.z + dz)
              const b = bot.blockAt(p)
              if (!b) continue
              const n = String(b.name || '').toLowerCase()
              if (!blockMatches(n)) continue
              candidates.push(p)
              if (candidates.length >= 128) break
            }
            if (candidates.length >= 128) break
          }
          if (candidates.length >= 128) break
        }
      } catch {}
    }

    if (!candidates.length) return fail('附近没有匹配方块')
    candidates.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const consider = candidates.slice(0, Math.min(80, candidates.length))
    let best = null
    let bestCost = Infinity
    for (const c of consider) {
      try {
        const gx = Math.floor(c.x), gy = Math.floor(c.y), gz = Math.floor(c.z)
        const g = new goals.GoalNear(gx, gy, gz, range)
        const res = bot.pathfinder.getPathTo(m, g)
        if (res && res.status === 'success') {
          const cost = Number.isFinite(res.cost) ? res.cost : (res.path ? res.path.length : 999999)
          if (cost < bestCost) { best = { pos: c, g }; bestCost = cost }
        }
      } catch {}
    }
    if (!best) return fail('附近没有可到达的匹配方块')
    const bp = best.pos
    const px = Math.floor(bp.x), py = Math.floor(bp.y), pz = Math.floor(bp.z)
    bot.pathfinder.setGoal(best.g, true)
    const targetName = (() => {
      try { return (bot.blockAt(bp)?.name) || (match || (names && names[0]) || 'block') } catch { return match || (names && names[0]) || 'block' }
    })()
    return ok(`前往(可达) ${targetName} @ ${px},${py},${pz}`)
  }

  async function follow_player (args = {}) {
    const { name, range = 3 } = args
    if (!name) return fail('缺少玩家名')
    const wanted = String(name).trim()
    const safeName = (() => {
      const trimmed = wanted.trim()
      if (!trimmed) return ''
      const m = trimmed.match(/^[A-Za-z0-9_\\.]{1,32}$/)
      return m ? m[0] : ''
    })()
    if (!safeName) return fail('玩家名不合法')
    const ent = resolvePlayerEntityExact(bot, safeName)
    if (!ent) {
      const cmd = `/tpa ${safeName}`
      const now = Date.now()
      const lastAt = Number(bot?.state?.followPlayerTpaLastAt) || 0
      const lastName = String(bot?.state?.followPlayerTpaLastName || '')
      if (!bot.state || typeof bot.state !== 'object') bot.state = {}
      if (safeName !== lastName || now - lastAt >= 6000) {
        bot.state.followPlayerTpaLastAt = now
        bot.state.followPlayerTpaLastName = safeName
        try { bot.chat(cmd) } catch {}
        try {
          if (Array.isArray(bot.state.aiRecent)) {
            bot.state.aiRecent.push({ kind: 'bot', content: cmd, t: now })
          }
        } catch {}
      }
      return ok('')
    }
    if (isSelfEntity(bot, ent)) return fail('不能和自己交互')
    const pkg = getPathfinder()
    if (!pkg) return fail('无寻路')
    const { Movements, goals } = pkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true)
    m.allowSprinting = true
    try { m.allow1by1towers = false } catch {}
    try { m.allowParkour = false } catch {}
    try { m.allowParkourPlace = false } catch {}
    try { m.scafoldingBlocks = [] } catch {}
    try { m.scaffoldingBlocks = [] } catch {}
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalFollow(ent, range), true)
    return ok('')
  }

  async function stop () {
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { pvp.stopMoveOverrides(bot) } catch {}
    shared.miningAbort = true
    if (shared.huntInterval) { try { clearInterval(shared.huntInterval) } catch {}; shared.huntInterval = null; shared.huntTarget = null }
    if (shared.guardInterval) { try { clearInterval(shared.guardInterval) } catch {}; shared.guardInterval = null; shared.guardTarget = null }
    if (shared.cullInterval) { try { clearInterval(shared.cullInterval) } catch {}; shared.cullInterval = null }
    try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch {}
    try { if (bot.isSleeping) await bot.wake() } catch {}
    try { if (bot.vehicle) await bot.dismount() } catch {}
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
    try { if (bot.entity && bot.entity.position) bot.lookAt(bot.entity.position, true) } catch {}
    try { if (bot.state) bot.state.autoLookSuspended = false } catch {}
    try { bot.emit('agent:stop_all') } catch {}
    try { if (bot.state) bot.state.currentTask = null } catch {}
    return ok('已复位')
  }

  async function say (args = {}) {
    const { text } = args
    if (!text) return fail('缺少内容')
    try { bot.chat(String(text).slice(0, 120)) } catch {}
    return ok('已发送')
  }

  register('goto', goto)
  register('goto_block', goto_block)
  register('follow_player', follow_player)
  register('stop', stop)
  register('stop_all', () => stop({}))
  register('reset', args => stop(args || {}))
  register('say', say)
}
