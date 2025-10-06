// Periodically sense nearby world changes and react heuristically (no AI).

const H = require('./ai-chat-helpers')
const actionsMod = require('./actions')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const S = state.sense = state.sense || {}
  const cfg = S.cfg = Object.assign({
    enabled: true,
    radius: 6,
    tickMs: 1200,
    maxEvents: 200,
    burstCount: 12,
    burstWindowMs: 3000,
    immediateFlee: true,
    // sustained piston/redstone spam reaction
    sustainWindowMs: 12000,
    sustainCount: 30,
    allowPlea: true,
    pleaCooldownMs: 15000,
    escalate: true
  }, S.cfg || {})

  const events = S.events = Array.isArray(S.events) ? S.events : []
  let timer = null
  // no AI flush bookkeeping
  let fleeCooldownUntil = 0
  let lastPleaAt = S.lastPleaAt || 0
  let sustainHitCount = S.sustainHitCount || 0

  function nearMe (pos) {
    try { return bot.entity && bot.entity.position && bot.entity.position.distanceTo(pos) <= cfg.radius } catch { return false }
  }

  function rec (type, payload) {
    try {
      const e = { t: Date.now(), type, ...payload }
      events.push(e)
      if (events.length > cfg.maxEvents) events.splice(0, events.length - cfg.maxEvents)
    } catch {}
  }

  // Block changes near the bot
  on('blockUpdate', (oldBlock, newBlock) => {
    try {
      const b = newBlock || oldBlock
      if (!b || !b.position) return
      if (!nearMe(b.position)) return
      const name = String(newBlock?.name || 'air')
      const from = String(oldBlock?.name || 'air')
      if (name === from) return
      rec('block', { x: b.position.x, y: b.position.y, z: b.position.z, name, from })
    } catch {}
  })

  // Nearby player arm swings and hurt events
  on('entitySwingArm', (entity) => { try { if (entity?.type === 'player' && nearMe(entity.position)) rec('swing', { id: entity.id, name: entity.username || entity.name }) } catch {} })
  on('entityHurt', (entity) => { try { if (entity?.type === 'player' && nearMe(entity.position)) rec('hurt', { id: entity.id, name: entity.username || entity.name }) } catch {} })

  // Joins/leaves (global), just record light
  on('playerJoined', (p) => { try { rec('join', { name: p?.username || p?.name }) } catch {} })
  on('playerLeft', (p) => { try { rec('left', { name: p?.username || p?.name }) } catch {} })

  async function maybeFlush () {
    if (!cfg.enabled) return
    const now = Date.now()
    // Immediate flee on burst block changes
    if (cfg.immediateFlee && now >= fleeCooldownUntil) {
      const from = now - cfg.burstWindowMs
      const cnt = events.filter(e => e.type === 'block' && (e.t || 0) >= from).length
      if (cnt >= cfg.burstCount) {
        try {
          const tools = actionsMod.install(bot, { log })
          if (log?.info) log.info('[sense] burst=', cnt, '-> flee_trap')
          await tools.run('flee_trap', { radius: Math.min(8, Math.max(4, cfg.radius)), strike: false })
        } catch {}
        events.splice(0)
        fleeCooldownUntil = now + 5000
        return
      }
    }

    // Sustained piston/redstone activity handling (non-AI): cute plea + optional flee escalation
    const winFrom = now - cfg.sustainWindowMs
    const recentBlocks = events.filter(e => e.type === 'block' && (e.t || 0) >= winFrom)
    const isPistonish = (n) => {
      const s = String(n || '').toLowerCase()
      return s.includes('piston') || s.includes('sticky') || s.includes('redstone') || s.includes('observer')
    }
    const pistonCnt = recentBlocks.filter(e => isPistonish(e.name) || isPistonish(e.from)).length
    if (pistonCnt >= cfg.sustainCount) {
      // Step 1: say a cute plea (rate-limited)
      if (cfg.allowPlea && (now - lastPleaAt) >= cfg.pleaCooldownMs) {
        lastPleaAt = now; S.lastPleaAt = lastPleaAt
        try {
          const msgs = ['不要夹我啦QAQ', '好吵好可怕…放过我嘛(>_<)', '呜哇…活塞一直动…我害怕', '别这样啦…我会躲开的(；д；)']
          bot.chat(msgs[Math.floor(Math.random() * msgs.length)])
        } catch {}
      }
      // Step 2: escalate fleeing occasionally
      if (cfg.escalate && now >= fleeCooldownUntil) {
        sustainHitCount = (sustainHitCount || 0) + 1; S.sustainHitCount = sustainHitCount
        if (sustainHitCount % 2 === 0) {
          try {
            const tools = actionsMod.install(bot, { log })
            if (log?.info) log.info('[sense] sustained piston -> flee_trap')
            await tools.run('flee_trap', { radius: Math.min(8, Math.max(4, cfg.radius)), strike: false })
          } catch {}
          fleeCooldownUntil = now + 5000
        }
      }
    }
  }

  function start () { if (!timer) timer = setInterval(maybeFlush, Math.max(600, cfg.tickMs)) }
  function stop () { if (timer) { try { clearInterval(timer) } catch {} ; timer = null } }

  on('spawn', start)
  if (state?.hasSpawned) start()
  on('end', stop)
  on('agent:stop_all', () => { try { events.splice(0) } catch {} })

  // CLI controls: .sense ...
  on('cli', ({ cmd, args }) => {
    if (String(cmd || '').toLowerCase() !== 'sense') return
    const sub = (args[0] || '').toLowerCase()
    const val = args[1]
    switch (sub) {
      case 'on': cfg.enabled = true; console.log('[SENSE] enabled'); break
      case 'off': cfg.enabled = false; console.log('[SENSE] disabled'); break
      case 'status': console.log('[SENSE] enabled=', cfg.enabled, 'radius=', cfg.radius, 'tickMs=', cfg.tickMs); break
      case 'radius': cfg.radius = Math.max(2, parseInt(val || '6', 10)); console.log('[SENSE] radius=', cfg.radius); break
      case 'interval': cfg.tickMs = Math.max(600, parseInt(val || '1200', 10)); console.log('[SENSE] tickMs=', cfg.tickMs); try { if (timer) clearInterval(timer) } catch {}; timer = null; start(); break
      case 'burst': cfg.burstCount = Math.max(1, parseInt(val || '12', 10)); console.log('[SENSE] burstCount=', cfg.burstCount); break
      case 'burstwin': cfg.burstWindowMs = Math.max(200, parseInt(val || '3000', 10)); console.log('[SENSE] burstWindowMs=', cfg.burstWindowMs); break
      case 'imm': cfg.immediateFlee = (String(val || 'on').toLowerCase() !== 'off'); console.log('[SENSE] immediateFlee=', cfg.immediateFlee); break
      case 'sustain': cfg.sustainCount = Math.max(1, parseInt(val || '30', 10)); console.log('[SENSE] sustainCount=', cfg.sustainCount); break
      case 'sustainwin': cfg.sustainWindowMs = Math.max(1000, parseInt(val || '12000', 10)); console.log('[SENSE] sustainWindowMs=', cfg.sustainWindowMs); break
      case 'plea': cfg.allowPlea = (String(val || 'on').toLowerCase() !== 'off'); console.log('[SENSE] allowPlea=', cfg.allowPlea); break
      case 'pleacd': cfg.pleaCooldownMs = Math.max(1000, parseInt(val || '15000', 10)); console.log('[SENSE] pleaCooldownMs=', cfg.pleaCooldownMs); break
      case 'escalate': cfg.escalate = (String(val || 'on').toLowerCase() !== 'off'); console.log('[SENSE] escalate=', cfg.escalate); break
      default: console.log('[SENSE] usage: .sense on|off|status|radius N|interval ms|burst N|burstwin ms|imm on|off|sustain N|sustainwin ms|plea on|off|pleacd ms|escalate on|off')
    }
  })

  registerCleanup && registerCleanup(() => { stop() })
}

module.exports = { install }
