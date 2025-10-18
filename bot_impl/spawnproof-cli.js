// CLI command: .spawnproof [item=<button>] [radius=N] [max=N] [spacing=N] [collect=true|false] [on=solid|block,...]

function install (bot, { on, registerCleanup, log }) {
  const logger = log

  function parsePositiveInt (value, fallback, min) {
    const n = parseInt(String(value), 10)
    if (Number.isFinite(n) && n >= min) return n
    return fallback
  }

  function ensureArea (out) {
    if (!out.area || typeof out.area !== 'object') out.area = {}
    if (typeof out.area.shape !== 'string') out.area.shape = 'sphere'
    if (!out.area.origin || typeof out.area.origin !== 'object') out.area.origin = {}
  }

  function parseArgs (args) {
    const out = {
      item: 'polished_blackstone_button',
      spacing: 1,
      max: 64,
      collect: false,
      area: { shape: 'sphere', radius: 8 },
      on: { solid: true }
    }
    let itemPositionalSet = false

    for (const raw of (args || [])) {
      const token = String(raw || '').trim()
      if (!token) continue
      const eq = token.indexOf('=')
      if (eq !== -1) {
        const key = token.slice(0, eq).trim().toLowerCase()
        const value = token.slice(eq + 1).trim()
        switch (key) {
          case 'item':
          case 'what':
            if (value) out.item = value.toLowerCase()
            break
          case 'radius': {
            const r = parsePositiveInt(value || '8', out.area.radius || 8, 1)
            ensureArea(out)
            out.area.radius = r
            break
          }
          case 'max': {
            const m = parsePositiveInt(value || '64', out.max || 64, 1)
            out.max = m
            break
          }
          case 'spacing': {
            const s = parsePositiveInt(value || '1', out.spacing || 1, 1)
            out.spacing = s
            break
          }
          case 'collect': {
            const v = value.toLowerCase()
            out.collect = (v === 'true' || v === '1' || v === 'yes' || v === 'on')
            break
          }
          case 'on': {
            const tokens = value.toLowerCase().split(',').map(x => x.trim()).filter(Boolean)
            if (tokens.length) {
              const opts = {}
              const bases = tokens.filter(t => t && t !== 'solid' && t !== '*' && t !== 'any')
              if (bases.length) opts.top_of = bases
              if (tokens.some(t => t === 'solid' || t === '*' || t === 'any')) opts.solid = true
              if (Object.keys(opts).length) out.on = opts
            }
            break
          }
          case 'solid': {
            const v = value.toLowerCase()
            if (!out.on || typeof out.on !== 'object') out.on = {}
            if (v === 'false' || v === '0' || v === 'no' || v === 'off') delete out.on.solid
            else out.on.solid = true
            break
          }
          case 'x':
          case 'y':
          case 'z': {
            const num = Number(value)
            if (Number.isFinite(num)) {
              ensureArea(out)
              out.area.origin[key] = num
            }
            break
          }
        }
        continue
      }

      if (!itemPositionalSet) {
        out.item = token.toLowerCase()
        itemPositionalSet = true
        continue
      }
    }

    ensureArea(out)
    if (!Number.isFinite(out.area.radius) || out.area.radius < 1) out.area.radius = 8
    if (out.collect !== true) out.collect = false

    return out
  }

  async function onCli (payload) {
    try {
      const cmd = String(payload?.cmd || '').toLowerCase()
      if (cmd !== 'spawnproof' && cmd !== 'spawn-proof') return
      const args = parseArgs(payload?.args || [])
      const actions = require('./actions').install(bot, { log: logger })
      try { bot.emit('external:begin', { source: 'cli', tool: 'place_blocks' }) } catch {}
      const result = await actions.run('place_blocks', args)
      try { bot.emit('external:end', { source: 'cli', tool: 'place_blocks' }) } catch {}
      console.log('[SPAWNPROOF]', result.ok ? 'ok' : 'fail', result.msg)
    } catch (e) {
      console.log('[SPAWNPROOF] error:', e?.message || e)
    }
  }

  on('cli', onCli)
  if (typeof registerCleanup === 'function') {
    registerCleanup(() => {
      try { bot.off('cli', onCli) } catch {}
    })
  }
}

module.exports = { install }
