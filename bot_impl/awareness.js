// Situational awareness + optional AI-driven reactions

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  const L = log || { debug: (...a) => dlog && dlog(...a), info: (...a) => console.log('[AWARE]', ...a), warn: (...a) => console.warn('[AWARE]', ...a) }

  const recentBlocks = [] // {t,name,pos,kind}
  const recentActs = []   // {t,player,kind,pos}
  const MAX_KEEP = 80
  let iv = null
  let pauseUntil = 0

  function now () { return Date.now() }
  function pushLimited (arr, item) { arr.push(item); if (arr.length > MAX_KEEP) arr.splice(0, arr.length - MAX_KEEP) }

  function isSolid (block) {
    const n = String(block?.name || '').toLowerCase()
    if (!n || n === 'air' || n.includes('water') || n.includes('lava')) return false
    const bb = block?.boundingBox
    return bb === 'block' || (!n.includes('flower') && !n.includes('torch') && !n.includes('carpet') && !n.includes('button'))
  }

  function within (pos, radius) {
    try { return bot.entity && bot.entity.position && bot.entity.position.distanceTo(pos) <= radius } catch { return false }
  }

  function onBlockUpdate (oldB, newB) {
    try {
      const b = newB || oldB
      if (!b || !b.position) return
      if (!within(b.position, 6)) return
      const oldN = String(oldB?.name || '').toLowerCase()
      const newN = String(newB?.name || '').toLowerCase()
      if (oldN === newN) return
      const placed = (!isSolid(oldB) && isSolid(newB))
      const removed = (isSolid(oldB) && !isSolid(newB))
      const kind = placed ? 'placed' : removed ? 'removed' : 'changed'
      pushLimited(recentBlocks, { t: now(), name: newN || oldN, pos: b.position.clone(), kind })
    } catch {}
  }

  function onSwing (ent) {
    try {
      if (!ent || ent === bot.entity) return
      if (ent.type !== 'player') return
      if (!within(ent.position, 6)) return
      pushLimited(recentActs, { t: now(), player: ent.username || ent.name || ent.id, kind: 'swing', pos: ent.position.clone() })
    } catch {}
  }

  function hasRecentPlayerNear (pos, t, range = 4, winMs = 1500) {
    try {
      const from = t - Math.max(200, winMs)
      for (const a of recentActs) {
        if ((a.t || 0) < from) continue
        if (!a.pos) continue
        const d = a.pos.distanceTo(pos)
        if (Number.isFinite(d) && d <= range) return true
      }
      return false
    } catch { return false }
  }

  function trapSuspicionScore () {
    try {
      if (!bot.entity || !bot.entity.position) return 0
      const p = bot.entity.position.floored()
      const checks = [
        p.offset( 1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0,  1), p.offset(0, 0, -1),
        p.offset( 1, 1, 0), p.offset(-1, 1, 0), p.offset(0, 1,  1), p.offset(0, 1, -1)
      ]
      let solidNear = 0
      for (const cp of checks) { const b = bot.blockAt(cp); if (isSolid(b)) solidNear++ }
      // Recent placements around us also increase suspicion
      const cutoff = now() - 3000
      const recentNear = recentBlocks.filter(r => r.t >= cutoff && r.kind === 'placed' && within(r.pos, 3) && hasRecentPlayerNear(r.pos, r.t, 4, 1500)).length
      return solidNear + recentNear
    } catch { return 0 }
  }

  function buildReportText () {
    try {
      const cutoff = now() - 5000
      const b = recentBlocks.filter(r => r.t >= cutoff)
      const a = recentActs.filter(r => r.t >= cutoff)
      const blocks = b.slice(-8).map(r => `${r.kind}:${r.name}@${r.pos.x},${r.pos.y},${r.pos.z}`).join(' | ')
      const acts = a.slice(-6).map(r => `${r.kind}:${r.player}`).join(' | ')
      const players = Object.entries(bot.players || {}).filter(([n, rec]) => rec?.entity && rec.entity !== bot.entity && within(rec.entity.position, 12)).map(([n]) => n)
      const me = bot.entity?.position?.floored?.() || bot.entity?.position
      return [
        `位置=${me ? `${me.x},${me.y},${me.z}` : '未知'}`,
        `附近玩家=${players.join(',') || '无'}`,
        `近期方块=${blocks || '无'}`,
        `近期动作=${acts || '无'}`,
        `陷阱可疑=${trapSuspicionScore()}`
      ].join(' | ')
    } catch (e) { return `报告构建失败:${e?.message || e}` }
  }

  // no AI usage here; this module only provides heuristics

  function maybeAutoEscape () {
    try {
      const score = trapSuspicionScore()
      if (score < 6) return false
      if (!bot.entity || !bot.entity.position) return false
      // pick a simple escape vector away from nearest player
      let away = { x: 0, z: 0 }
      let nearest = null; let bestD = Infinity
      for (const [name, rec] of Object.entries(bot.players || {})) {
        const e = rec?.entity; if (!e || e === bot.entity) continue
        const d = e.position.distanceTo(bot.entity.position)
        if (d < bestD) { bestD = d; nearest = e }
      }
      if (nearest) {
        away = { x: bot.entity.position.x - nearest.position.x, z: bot.entity.position.z - nearest.position.z }
      } else {
        away = { x: (Math.random() - 0.5), z: (Math.random() - 0.5) }
      }
      const len = Math.hypot(away.x, away.z) || 1
      const step = { x: away.x / len, z: away.z / len }
      const dist = 8 + Math.floor(Math.random() * 4)
      const goal = { x: Math.round(bot.entity.position.x + step.x * dist), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z + step.z * dist) }
      try {
        const pathfinderPkg = require('mineflayer-pathfinder')
        if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder)
        const { Movements, goals } = pathfinderPkg
        const mcData = bot.mcData || require('minecraft-data')(bot.version)
        const m = new Movements(bot, mcData)
        m.canDig = true; m.allowSprinting = true
        bot.pathfinder.setMovements(m)
        bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, 1), true)
        L.info('auto-escape ->', goal)
        return true
      } catch (e) { L.warn('auto-escape failed:', e?.message || e) ; return false }
    } catch { return false }
  }

  async function tick () {
    if (now() < pauseUntil) return
    // quick heuristic escape if strong suspicion
    const escaped = maybeAutoEscape()
    if (escaped) { pauseUntil = now() + 5000; return }
    // could extend with non-AI reactions here in future
  }

  on('blockUpdate', onBlockUpdate)
  on('entitySwingArm', onSwing)

  iv = setInterval(() => { tick().catch(() => {}) }, 1200)
  registerCleanup && registerCleanup(() => { try { if (iv) clearInterval(iv) } catch {} ; iv = null })
  on('agent:stop_all', () => { pauseUntil = now() + 5000 })
}

module.exports = { install }
