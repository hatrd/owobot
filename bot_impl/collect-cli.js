// CLI command: .collect [key=value ...] [radius?]
// Examples:
//   .collect                -> default sweep
//   .collect radius=12      -> set radius only
//   .collect radius=16 max=40 timeout=15000 match=log
//   .collect 12 log         -> radius=12, match='log'

function install (bot, { on, dlog, state, registerCleanup, log }) {
  function parseArgs (args) {
    const out = { what: 'drops' }
    for (const a of args) {
      const s = String(a || '').trim()
      if (!s) continue
      const kv = s.split('=')
      if (kv.length === 2) {
        const k = kv[0].toLowerCase()
        const v = kv[1]
        switch (k) {
          case 'radius': out.radius = Math.max(1, parseInt(v || '16', 10)); break
          case 'max': out.max = Math.max(1, parseInt(v || '80', 10)); break
          case 'timeout':
          case 'timeoutms': out.timeoutMs = Math.max(500, parseInt(v || '12000', 10)); break
          case 'until': out.until = String(v || 'exhaust').toLowerCase(); break
          case 'match': out.match = String(v || '').toLowerCase(); break
          case 'names': out.names = String(v || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean); break
        }
        continue
      }
      // positional helpers: number -> radius, text -> match
      if (/^\d+$/.test(s)) { out.radius = Math.max(1, parseInt(s, 10)); continue }
      if (!out.match) out.match = s.toLowerCase()
    }
    return out
  }

  async function onCli (payload) {
    try {
      if (!payload || payload.cmd !== 'collect') return
      const args = parseArgs(payload.args || [])
      const actions = require('./actions').install(bot, { log })
      try { bot.emit('external:begin', { source: 'cli', tool: 'collect' }) } catch {}
      let r
      try {
        r = await actions.run('collect', args)
      } finally {
        try { bot.emit('external:end', { source: 'cli', tool: 'collect' }) } catch {}
      }
      console.log('[COLLECT]', r.ok ? 'ok' : 'fail', r.msg)
    } catch (e) {
      console.log('[COLLECT] error:', e?.message || e)
    }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
