// Runtime log control via terminal (bot.js readline).
// Easier, unified ergonomics with namespaces and presets.
// Examples:
//  .log list                  -> show known namespaces
//  .log fish on               -> enable fishing logs (alias: fishing)
//  .log off fish plant        -> turn off multiple namespaces
//  .log debug ai defense      -> set level=debug for ai and defense
//  .log all warn              -> set default level
//  .log verbose               -> preset (all:info)
//  .log quiet                 -> preset (all:warn)
//  .log debug-all             -> preset (all:debug)
//  .log spec all:warn,fish:debug -> advanced

const logging = require('./logging')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  logging.init(state)

  function print (...args) { console.log('[LOGCTL]', ...args) }

  function nsAlias (name) {
    const n = String(name || '').toLowerCase()
    const map = new Map([
      ['fishing', 'fish'], ['autofish', 'fish'], ['fish', 'fish'],
      ['plant', 'plant'], ['autoplant', 'plant'],
      ['collect', 'collect'], ['pickup', 'collect'],
      ['place', 'place'], ['build', 'place'],
      ['defense', 'defense'], ['pvp', 'pvp'],
      ['eat', 'eat'], ['auto-eat', 'eat'],
      ['gear', 'gear'], ['auto-gear', 'gear'],
      ['sleep', 'sleep'], ['bed', 'sleep'],
      ['swim', 'swim'], ['autoswim', 'swim'],
      ['tpa', 'tpa'], ['tp', 'tpa'],
      ['ai', 'ai'], ['owk', 'ai'],
      ['drops', 'drops'],
      ['core', 'core'], ['all', 'all']
    ])
    return map.get(n) || n
  }

  function preset (name) {
    const n = String(name || '').toLowerCase()
    if (n === 'quiet') { logging.setSpec('all:warn'); return 'all:warn' }
    if (n === 'verbose') { logging.setSpec('all:info'); return 'all:info' }
    if (n === 'debug' || n === 'debug-all') { logging.setSpec('all:debug'); return 'all:debug' }
    if (n === 'default') { logging.setSpec(''); return '(default)' }
    return null
  }

  function handleArgs (args) {
    if (args.length === 0 || args[0] === 'show') {
      const spec = logging.getSpec() || '(default)'
      print('log =', spec)
      return
    }
    if (args[0] === 'help') {
      print('usage: .log list|show|help')
      print('       .log <ns> <level>            (levels: off|error|warn|info|debug)')
      print('       .log on|off|debug|info <ns...>')
      print('       .log all <level>             (set default)')
      print('       .log quiet|verbose|debug-all|default (preset)')
      print('       .log spec <specString>')
      return
    }
    if (args[0] === 'list') {
      const names = logging.knownNamespaces()
      print('namespaces:', names.length ? names.join(', ') : '(none)')
      return
    }
    if (args.length === 1) {
      // Single token: try preset first, else toggle ns to debug
      const p = preset(args[0])
      if (p != null) { print('preset ->', p); return }
      const ns = nsAlias(args[0])
      logging.setLevel(ns, 'debug')
      print(`set ${ns} = debug`)
      return
    }
    if (args[0] === 'spec') {
      const spec = args.slice(1).join(' ')
      logging.setSpec(spec)
      print('set spec ->', spec || '(default)')
      return
    }
    if (['on','off','debug','info','warn','error'].includes(args[0])) {
      const level = (args[0] === 'on') ? 'debug' : args[0]
      const targets = args.slice(1).map(nsAlias)
      for (const t of targets) logging.setLevel(t, level)
      print('set ->', targets.map(t => `${t}:${level}`).join(', '))
      return
    }
    if (args[0] === 'all' && args[1]) {
      const ok = logging.setLevel('all', args[1])
      print(ok ? `set all = ${args[1]}` : `invalid level: ${args[1]}`)
      return
    }
    if (args.length === 2) {
      const ns = nsAlias(args[0])
      const raw = String(args[1] || '').toLowerCase()
      const lvl = (raw === 'on') ? 'debug' : (raw === 'quiet' ? 'warn' : raw)
      const ok = logging.setLevel(ns, lvl)
      print(ok ? `set ${ns} = ${lvl}` : `invalid level: ${lvl}`)
      return
    }
    // Fallback: treat as spec string
    const spec = args.join(' ')
    logging.setSpec(spec)
    print('set spec ->', spec)
  }

  function onCli (payload) {
    try {
      if (!payload || payload.cmd !== 'log') return
      handleArgs(payload.args || [])
    } catch (e) {
      dlog && dlog('logctl error:', e?.message || e)
    }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
