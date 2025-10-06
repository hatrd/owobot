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

  function canCallAI () {
    try {
      const ai = state.ai || {}
      if (!ai.enabled) return false
      if (!ai.key) return false
      return true
    } catch { return false }
  }

  function toolLineFrom (text) {
    const m = /TOOL\s+(\{[\s\S]*\})/i.exec(String(text || ''))
    if (!m) return null
    try { return JSON.parse(m[1]) } catch { return null }
  }

  async function askAiAndAct (report) {
    if (!canCallAI()) return
    const ai = state.ai
    const base = (ai.baseUrl || (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')).replace(/\/$/, '')
    const path = (ai.path || '/chat/completions')
    const url = base + path
    const sys = [
      '你是Minecraft的隐形副手, 接收“环境感知报告”, 用中文简短决定应对。',
      '如果需要执行操作, 只输出一行: TOOL {"tool":"<名字>","args":{...}}。否则输出简短建议。',
      '工具: stop{mode?="soft"|"hard"}, goto{x,y,z,range?}, follow_player{name,range?}, guard{name,radius?}, hunt_player{name,range?,durationMs?}, break_blocks{match?|names?,area:{shape:"sphere"|"down",radius?,height?,steps?,origin?},max?,collect?}, collect{what?="drops",radius?,max?,timeoutMs?}, mount_near{radius?,prefer?}, dismount{}, say{text}'
    ].join('\n')
    const msg = [{ role: 'system', content: sys }, { role: 'user', content: `环境感知报告: ${report}` }]
    const body = { model: ai.model || 'deepseek-chat', messages: msg, temperature: 0.2, max_tokens: 60, stream: false }
    let out = null
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ai.key}` }, body: JSON.stringify(body) })
      const json = await res.json()
      out = json?.choices?.[0]?.message?.content || ''
    } catch (e) {
      L.warn('ai call failed:', e?.message || e)
      return
    }
    const tool = toolLineFrom(out)
    if (!tool) return
    try {
      try { (state || (state = {})).externalBusy = true; bot.emit('external:begin', { source: 'sense', tool: tool.tool }) } catch {}
      const actions = require('./actions').install(bot, { log })
      const r = await actions.run(tool.tool, tool.args || {})
      L.info('AI tool ->', tool.tool, tool.args, 'result=', r && (r.ok ? 'ok' : 'fail'))
    } catch (e) { L.warn('tool exec failed:', e?.message || e) }
    finally { try { (state || (state = {})).externalBusy = false; bot.emit('external:end', { source: 'sense', tool: tool.tool }) } catch {} }
  }

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
    // otherwise, occasionally ask AI if interesting
    const cutoff = now() - 4000
    const b = recentBlocks.filter(r => r.t >= cutoff).length
    const a = recentActs.filter(r => r.t >= cutoff).length
    if (b + a < 2) return
    const report = buildReportText()
    askAiAndAct(report).catch(() => {})
    pauseUntil = now() + 6000
  }

  on('blockUpdate', onBlockUpdate)
  on('entitySwingArm', onSwing)

  iv = setInterval(() => { tick().catch(() => {}) }, 1200)
  registerCleanup && registerCleanup(() => { try { if (iv) clearInterval(iv) } catch {} ; iv = null })
  on('agent:stop_all', () => { pauseUntil = now() + 5000 })
}

module.exports = { install }
