// CLI command: .place [item] [key=value ...]
// Examples:
//   .place oak_sapling              -> 在默认半径内寻找可种位置
//   .place sand on=dirt,stone       -> 指定基底
//   .place oak_sapling radius=6 max=8 spacing=3 collect=true

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
        switch (k) {
          case 'item': out.item = String(v || '').toLowerCase(); break
          case 'radius': out.area = out.area || {}; out.area.radius = Math.max(1, parseInt(v || '8', 10)); break
          case 'max': out.max = Math.max(1, parseInt(v || '8', 10)); break
          case 'spacing': out.spacing = Math.max(1, parseInt(v || '3', 10)); break
          case 'collect': out.collect = String(v || 'false').toLowerCase(); break
          case 'on': {
            const tokens = String(v || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean)
            if (tokens.length) {
              const opts = {}
              const bases = tokens.filter(t => t && t !== 'solid' && t !== '*' && t !== 'any')
              if (bases.length) opts.top_of = bases
              if (tokens.some(t => t === 'solid' || t === '*' || t === 'any')) opts.solid = true
              if (Object.keys(opts).length) out.on = opts
            }
            break
          }
          case 'x': out.area = out.area || {}; out.area.origin = out.area.origin || {}; out.area.origin.x = Number(v); break
          case 'y': out.area = out.area || {}; out.area.origin = out.area.origin || {}; out.area.origin.y = Number(v); break
          case 'z': out.area = out.area || {}; out.area.origin = out.area.origin || {}; out.area.origin.z = Number(v); break
        }
        continue
      }
      // positional first token -> item
      if (!out.item) { out.item = s.toLowerCase(); continue }
    }
    const itemName = out.item ? String(out.item).toLowerCase() : ''
    if (itemName && /_button$/.test(itemName)) {
      if (!out.on) out.on = { solid: true }
      else if (!out.on.top_of && !out.on.solid) out.on.solid = true
      if (out.spacing == null) out.spacing = 1
      if (out.max == null) out.max = 32
    }
    return out
  }

  async function onCli (payload) {
    try {
      if (!payload || (payload.cmd !== 'place' && payload.cmd !== 'plant')) return
      const args = parseArgs(payload.args || [])
      if (!args.item) { console.log('[PLACE] usage: .place <item> [on=a,b|solid] [radius=N] [max=N] [spacing=N] [collect=true|false]'); return }
      const actions = require('./actions').install(bot, { log })
      try { bot.emit('external:begin', { source: 'cli', tool: 'place_blocks' }) } catch {}
      let r
      try {
        r = await actions.run('place_blocks', args)
      } finally {
        try { bot.emit('external:end', { source: 'cli', tool: 'place_blocks' }) } catch {}
      }
      console.log('[PLACE]', r.ok ? 'ok' : 'fail', r.msg)
    } catch (e) {
      console.log('[PLACE] error:', e?.message || e)
    }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
