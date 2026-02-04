// CLI command: .tool ...
// Human-friendly action runner with light argument parsing.
//
// Routing:
// - .tool list
// - .tool dry <toolOrAlias> [args...]
// - .tool run <toolOrAlias> [args...]    (alias; optional)
// - .tool <toolOrAlias> [args...]        (default: run)
//
// Args:
// - key=value pairs are always supported
// - selected tools support positional sugar (e.g. `.tool pick 20` -> { radius: 20 })

const actionsMod = require('./actions')

const ALIASES = {
  pick: 'pickup',
  pickup: 'pickup',
  collect: 'collect',
  go: 'goto',
  goto: 'goto',
  say: 'say'
}

function isNum (s) {
  return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s.trim())
}

function normalizeKey (key) {
  const k = String(key || '').trim()
  if (!k) return ''
  // If user already passed camelCase, keep it as-is (tools often expect it).
  if (/[A-Z]/.test(k)) return k
  const lower = k.toLowerCase()
  const map = {
    timeout: 'timeoutMs',
    timeoutms: 'timeoutMs',
    includenew: 'includeNew',
    softabort: 'softAbort',
    revisitcooldownms: 'revisitCooldownMs',
    retrydelayms: 'retryDelayMs'
  }
  return map[lower] || lower
}

function parseKeyValueArgs (tokens) {
  const out = { args: {}, positionals: [] }
  for (const raw of tokens) {
    const s = String(raw || '').trim()
    if (!s) continue
    const eq = s.indexOf('=')
    if (eq > 0) {
      const k = normalizeKey(s.slice(0, eq))
      const v = s.slice(eq + 1)
      if (k) out.args[k] = v
      continue
    }
    out.positionals.push(s)
  }
  return out
}

function normalizeToolName (toolOrAlias) {
  const key = String(toolOrAlias || '').trim().toLowerCase()
  if (!key) return null
  return ALIASES[key] || key
}

function parseArgsForTool (tool, tokens) {
  const { args, positionals } = parseKeyValueArgs(tokens)
  const t = String(tool || '').toLowerCase()

  // Positional sugar for common tools
  if (t === 'pickup' || t === 'collect') {
    // `.tool pick 20` -> radius=20
    // `.tool pick 20 log` -> radius=20 match=log
    // `.tool pick 20 50` -> radius=20 max=50 (optional sugar)
    for (const p of positionals) {
      if (isNum(p)) {
        if (args.radius == null) { args.radius = p; continue }
        if (args.max == null) { args.max = p; continue }
        continue
      }
      if (args.match == null) args.match = p
    }
    return args
  }

  if (t === 'goto') {
    // `.tool goto x y z [range]`
    const nums = positionals.filter(isNum)
    if (nums.length >= 3) {
      if (args.x == null) args.x = nums[0]
      if (args.y == null) args.y = nums[1]
      if (args.z == null) args.z = nums[2]
      if (nums.length >= 4 && args.range == null) args.range = nums[3]
    }
    return args
  }

  if (t === 'say') {
    // `.tool say hello world` -> text="hello world"
    if (args.text == null && positionals.length) args.text = positionals.join(' ')
    return args
  }

  // Default: only key=value pairs are meaningful
  return args
}

function coerceToolArgs (tool, args) {
  // Tools already parse most numeric values internally; keep coercion minimal.
  // Only coerce common numeric fields from our sugar.
  const out = { ...(args || {}) }
  for (const k of ['radius','max','timeoutMs','revisitCooldownMs','retryDelayMs','x','y','z','range']) {
    if (out[k] == null) continue
    const v = out[k]
    if (typeof v === 'number') continue
    if (!isNum(String(v))) continue
    const n = Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

function install (bot, { on, registerCleanup, log } = {}) {
  const print = (...a) => console.log('[TOOL]', ...a)

  function listTools () {
    try {
      const actions = actionsMod.install(bot, { log })
      const registered = new Set(actions.list())
      const allowed = Array.isArray(actionsMod.TOOL_NAMES) ? actionsMod.TOOL_NAMES : []
      const list = allowed.filter(n => registered.has(n))
      return { list, missing: allowed.filter(n => !registered.has(n)), extra: Array.from(registered).filter(n => !allowed.includes(n)) }
    } catch {
      return { list: [], missing: [], extra: [] }
    }
  }

  async function handleTool (payload) {
    try {
      if (!payload || String(payload.cmd || '').toLowerCase() !== 'tool') return
      const argv = Array.isArray(payload.args) ? payload.args : []
      const head = String(argv[0] || '').toLowerCase()

      // subcmd routing: list/dry/run; otherwise treat as tool name (default run)
      if (!head) {
        print('usage: .tool [list|dry|run] <tool> [args...]  |  .tool <tool> [args...]')
        return
      }

      if (head === 'list') {
        const { list, missing, extra } = listTools()
        print('list', list.join(' '))
        if (missing.length) print('warn missing-registered:', missing.join(' '))
        if (extra.length) print('warn extra-registered:', extra.join(' '))
        return
      }

      const isDry = head === 'dry'
      const isRunWord = head === 'run'
      const toolToken = isDry || isRunWord ? argv[1] : argv[0]
      const rawArgs = isDry || isRunWord ? argv.slice(2) : argv.slice(1)

      const tool = normalizeToolName(toolToken)
      if (!tool) {
        print('usage: .tool [list|dry|run] <tool> [args...]  |  .tool <tool> [args...]')
        return
      }

      const allowed = Array.isArray(actionsMod.TOOL_NAMES) ? actionsMod.TOOL_NAMES : []
      if (!allowed.includes(tool)) {
        print('fail', `tool not allowlisted: ${tool}`)
        return
      }

      const parsed = parseArgsForTool(tool, rawArgs)
      const args = coerceToolArgs(tool, parsed)

      if (isDry) {
        // MVP dry-run: validate-only, no world probe.
        const actions = actionsMod.install(bot, { log })
        const res = actions.dry ? actions.dry(tool, args) : { ok: false, msg: 'dry-run unsupported', blocks: ['no_dry'] }
        print('dry', JSON.stringify(res))
        return
      }

      const actions = actionsMod.install(bot, { log })
      try { bot.emit('external:begin', { source: 'cli', tool }) } catch {}
      let res
      try {
        res = await actions.run(tool, args)
      } finally {
        try { bot.emit('external:end', { source: 'cli', tool }) } catch {}
      }
      const ok = res && res.ok
      const msg = res && typeof res === 'object' ? (res.msg || '') : ''
      print(ok ? 'ok' : 'fail', tool, msg || '')
    } catch (e) {
      print('error:', e?.message || e)
    }
  }

  on('cli', handleTool)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', handleTool) } catch {} })
}

module.exports = {
  install,
  _internal: { normalizeToolName, parseArgsForTool, parseKeyValueArgs, coerceToolArgs }
}
