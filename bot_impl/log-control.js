// Runtime log control via terminal (bot.js readline).
// Enter lines starting with a dot, e.g.:
//  .log show
//  .log <ns> <level>          (levels: off|error|warn|info|debug)
//  .log all <level>
//  .log spec <specString>     (e.g., "all:warn,follow:debug")

const logging = require('./logging')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  if (log && typeof log.debug === 'function') dlog = (...a) => log.debug(...a)
  logging.init(state)

  function print (...args) { console.log('[LOGCTL]', ...args) }

  function handleArgs (args) {
    if (args.length === 0 || args[0] === 'show') {
      const spec = logging.getSpec() || '(default)'
      print('log =', spec)
      return
    }
    if (args[0] === 'spec') {
      const spec = args.slice(1).join(' ')
      logging.setSpec(spec)
      print('set spec ->', spec || '(default)')
      return
    }
    if (args.length === 2) {
      const ns = args[0]
      const lvl = args[1]
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
