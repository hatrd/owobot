// Dig packet trace (and optional guard) for diagnosing anti-cheat issues
// Enable trace via env: MC_DIG_TRACE=1
// Optional floor/jitter for STOP timing (EXPERIMENTAL, default off): MC_DIG_FLOOR_MS, MC_DIG_JITTER_MS

function getEnvInt (key, def) { const v = process.env[key]; const n = v == null ? NaN : parseInt(String(v), 10); return Number.isFinite(n) ? n : def }

function install (bot, { log }) {
  const client = bot && bot._client
  if (!client || typeof client.write !== 'function') return { ok: false, msg: 'no client' }
  const TRACE = ['1','true','on','yes'].includes(String(process.env.MC_DIG_TRACE || '').toLowerCase())
  const FLOOR = getEnvInt('MC_DIG_FLOOR_MS', null)
  const JITTER = getEnvInt('MC_DIG_JITTER_MS', 0)
  const WANT_DELAY = Number.isFinite(FLOOR) && FLOOR > 0
  if (!TRACE && !WANT_DELAY) return { ok: true, msg: 'dig trace/throttle disabled' }

  const starts = new Map() // key -> t0
  function keyOf (p) {
    try {
      if (!p) return '0,0,0'
      if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') return `${p.x},${p.y},${p.z}`
      if (Array.isArray(p) && p.length >= 3) return `${p[0]},${p[1]},${p[2]}`
      if (typeof p === 'object' && 'position' in p) return keyOf(p.position)
    } catch {}
    return '0,0,0'
  }

  function now () { return Date.now() }
  function rnd (n) { return Math.floor(Math.random() * Math.max(0, n || 0)) }

  const origWrite = client.write.bind(client)
  client.write = function patchedWrite (name, params) {
    try {
      if (name === 'block_dig' || name === 'player_digging' || name === 'player_action') {
        const p = params || {}
        let kind = 'other'
        let pos = null
        // Heuristic decode for different protocol mappings
        if (name === 'block_dig' || name === 'player_digging') {
          // Prismarine protocol: status: 0=start, 1=cancel, 2=finish; position: {x,y,z}
          const st = typeof p.status === 'number' ? p.status : null
          pos = p.location || p.position || p.pos || p
          if (st === 0) kind = 'start'
          else if (st === 2) kind = 'stop'
          else if (st === 1) kind = 'cancel'
        } else if (name === 'player_action') {
          // actionId may be numeric or string depending on proto mapping
          const a = p.actionId != null ? p.actionId : p.action
          pos = p.location || p.position || p.pos || p
          const val = String(a)
          if (/(start.*dig|start.*destroy|start\_destroy|start\_dig)/i.test(val)) kind = 'start'
          else if (/(stop.*dig|stop.*destroy|finish|complete)/i.test(val)) kind = 'stop'
          else if (/(cancel)/i.test(val)) kind = 'cancel'
        }
        const k = keyOf(pos)
        if (TRACE) {
          try {
            if (kind === 'start') {
              starts.set(k, now())
              log && log.info && log.info('[dig] start', name, k)
            } else if (kind === 'stop') {
              const t0 = starts.get(k)
              const dt = t0 ? (now() - t0) : null
              log && log.info && log.info('[dig] stop', name, k, 'dt=', dt)
            } else if (kind === 'cancel') {
              log && log.info && log.info('[dig] cancel', name, k)
            }
          } catch {}
        }
        if (WANT_DELAY && kind === 'stop') {
          const t0 = starts.get(k)
          const elapsed = t0 ? (now() - t0) : null
          const need = Number.isFinite(elapsed) ? Math.max(0, FLOOR - elapsed) : 0
          const delayMs = Math.max(0, need) + rnd(JITTER)
          if (delayMs > 0) {
            // Defer STOP to enforce minimum timing window
            setTimeout(() => {
              try { origWrite(name, params) } catch {}
            }, delayMs)
            return // swallow immediate write
          }
        }
      }
    } catch {}
    return origWrite(name, params)
  }

  return { ok: true, msg: 'dig trace/throttle installed' }
}

module.exports = { install }

