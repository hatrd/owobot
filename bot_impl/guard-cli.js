// CLI: .guard <playerName|here|stop> [radius=N] [followRange=N] [tickMs=ms]
// Examples:
//   .guard Ameyaku radius=8          -> follow & protect player
//   .guard here radius=6             -> guard current position
//   .guard stop                      -> stop guarding / reset

function install (bot, { on, dlog, state, registerCleanup, log }) {
  function parseArgs (args) {
    const out = { }
    for (const a of args) {
      const s = String(a || '').trim()
      if (!s) continue
      const kv = s.split('=')
      if (kv.length === 2) {
        const k = kv[0].toLowerCase()
        const v = kv[1]
        if (k === 'radius') out.radius = Math.max(1, parseInt(v || '8', 10))
        else if (k === 'followrange') out.followRange = Math.max(1, parseInt(v || '3', 10))
        else if (k === 'tickms') out.tickMs = Math.max(100, parseInt(v || '250', 10))
        continue
      }
      if (!out._first) { out._first = s; continue }
    }
    return out
  }

  async function onCli (payload) {
    try {
      if (!payload || payload.cmd !== 'guard') return
      const parsed = parseArgs(payload.args || [])
      const first = String(parsed._first || '').toLowerCase()
      if (first === 'stop' || first === 'end' || first === 'off') {
        const actions = require('./actions').install(bot, { log })
        try { bot.emit('external:begin', { source: 'cli', tool: 'stop' }) } catch {}
        const r = await actions.run('stop', { mode: 'hard' })
        try { bot.emit('external:end', { source: 'cli', tool: 'stop' }) } catch {}
        console.log('[GUARD]', r.ok ? 'stopped' : ('fail: ' + r.msg))
        return
      }
      if (first === 'debug') {
        const enable = String(parsed.args2 || parsed._second || 'on').toLowerCase() !== 'off'
        const actions = require('./actions').install(bot, { log })
        try { bot.emit('external:begin', { source: 'cli', tool: 'guard_debug' }) } catch {}
        const r = await actions.run('guard_debug', { enabled: enable })
        try { bot.emit('external:end', { source: 'cli', tool: 'guard_debug' }) } catch {}
        console.log('[GUARD]', r.msg)
        return
      }
      const args = { radius: parsed.radius, followRange: parsed.followRange, tickMs: parsed.tickMs }
      if (first && first !== 'here') args.name = parsed._first
      const actions = require('./actions').install(bot, { log })
      try { bot.emit('external:begin', { source: 'cli', tool: 'guard' }) } catch {}
      const r = await actions.run('guard', args)
      try { bot.emit('external:end', { source: 'cli', tool: 'guard' }) } catch {}
      console.log('[GUARD]', r.ok ? r.msg : ('fail: ' + r.msg))
    } catch (e) {
      console.log('[GUARD] error:', e?.message || e)
    }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
