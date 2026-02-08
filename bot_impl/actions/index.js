const { assertCanEquipHand, isMainHandLocked } = require('../hand-lock')
const { Vec3 } = require('vec3')
const pvp = require('../pvp')
const observer = require('../agent/observer')
const skillRunnerMod = require('../agent/runner')
const { TOOL_SPECS } = require('../action-tool-specs')

const TOOL_METADATA = TOOL_SPECS.map((spec) => {
  const name = String(spec?.name || '').trim()
  const dryCapability = spec?.dryCapability === 'read_only' ? 'read_only' : 'validate_only'
  return { name, dryCapability }
})

const TOOL_META_BY_NAME = new Map()
for (const meta of TOOL_METADATA) {
  if (!meta.name) throw new Error('Invalid tool metadata: empty name')
  if (TOOL_META_BY_NAME.has(meta.name)) throw new Error(`Duplicate tool metadata: ${meta.name}`)
  TOOL_META_BY_NAME.set(meta.name, meta)
}

const TOOL_NAMES = TOOL_METADATA.map(meta => meta.name)

function listToolMetadata () {
  return TOOL_METADATA.map(meta => ({ ...meta }))
}

function getToolMetadata (name) {
  return TOOL_META_BY_NAME.get(String(name || '')) || null
}

function isToolAllowlisted (name) {
  return TOOL_META_BY_NAME.has(String(name || ''))
}

function buildToolRegistryReport (registeredNames = []) {
  const registered = Array.isArray(registeredNames)
    ? registeredNames.map(name => String(name || '')).filter(Boolean)
    : []
  const regSet = new Set(registered)
  return {
    allowlist: TOOL_NAMES.slice(),
    registered,
    missing: TOOL_NAMES.filter(name => !regSet.has(name)),
    extra: registered.filter(name => !TOOL_META_BY_NAME.has(name))
  }
}

const MODULES = [
  require('./modules/movement'),
  require('./modules/voice'),
  require('./modules/skills'),
  require('./modules/farming'),
  require('./modules/observation'),
  require('./modules/inventory'),
  require('./modules/combat'),
  require('./modules/stats'),
  require('./modules/people')
]

function prepareActionsRuntime (existing) {
  const shared = (existing && typeof existing === 'object') ? existing : {}
  if (!('huntInterval' in shared)) shared.huntInterval = null
  if (!('huntTarget' in shared)) shared.huntTarget = null
  if (!('guardInterval' in shared)) shared.guardInterval = null
  if (!('guardTarget' in shared)) shared.guardTarget = null
  if (!('cullInterval' in shared)) shared.cullInterval = null
  if (!('miningAbort' in shared)) shared.miningAbort = false
  if (!('armorStandInterval' in shared)) shared.armorStandInterval = null
  if (!shared.armorStandDebug || typeof shared.armorStandDebug !== 'object') {
    shared.armorStandDebug = { enabled: false, lastTick: null, _lastTickLog: { reason: null, targetId: null } }
  } else {
    if (!('enabled' in shared.armorStandDebug)) shared.armorStandDebug.enabled = false
    if (!('lastTick' in shared.armorStandDebug)) shared.armorStandDebug.lastTick = null
    if (!shared.armorStandDebug._lastTickLog || typeof shared.armorStandDebug._lastTickLog !== 'object') {
      shared.armorStandDebug._lastTickLog = { reason: null, targetId: null }
    } else {
      if (!('reason' in shared.armorStandDebug._lastTickLog)) shared.armorStandDebug._lastTickLog.reason = null
      if (!('targetId' in shared.armorStandDebug._lastTickLog)) shared.armorStandDebug._lastTickLog.targetId = null
    }
  }
  return shared
}

function createContext (bot, { log, on, registerCleanup, runtime } = {}) {
  const registry = new Map()
  // Runtime must be shared across all action entrypoints (AI, CLI, etc.),
  // otherwise stop/reset can only affect the instance that created the interval/flag.
  const shared = prepareActionsRuntime(runtime || bot?.state?.actionsRuntime)
  let pathfinderPkg = null
  let guardDebug = false

  const ctx = {
    bot,
    log,
    on,
    registerCleanup,
    observer,
    skillRunnerMod,
    pvp,
    Vec3,
    assertCanEquipHand,
    isMainHandLocked,
    shared,
    wait (ms) { return new Promise(resolve => setTimeout(resolve, ms)) },
    ok (msg, extra) { return { ok: true, msg, ...(extra || {}) } },
    fail (msg, extra) { return { ok: false, msg, ...(extra || {}) } },
    register (name, fn) {
      if (!name || typeof fn !== 'function') throw new Error('Invalid action registration')
      if (registry.has(name)) throw new Error(`Action already registered: ${name}`)
      registry.set(name, fn)
    },
    ensurePathfinder () {
      try {
        if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder')
        if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder)
        return true
      } catch (err) {
        if (log?.warn) log.warn('pathfinder missing', err?.message || err)
        return false
      }
    },
    get pathfinder () {
      return pathfinderPkg
    },
    withCleanup (fn) {
      if (typeof registerCleanup === 'function') registerCleanup(fn)
    },
    get guardDebug () { return guardDebug },
    set guardDebug (value) { guardDebug = Boolean(value) },
    get registry () { return registry }
  }

  return ctx
}

function install (bot, options = {}) {
  const ctx = createContext(bot, options)
  for (const load of MODULES) {
    if (typeof load === 'function') load(ctx)
  }

  function dry (tool, args) {
    return Promise.resolve().then(async () => {
      const name = String(tool || '')
      if (!name) return { ok: false, msg: '缺少工具名', blocks: ['missing_tool'] }
      const toolMeta = getToolMetadata(name)
      if (!toolMeta) return { ok: false, msg: '工具不在白名单', blocks: ['not_allowlisted'] }
      const fn = ctx.registry.get(name)
      if (!fn) return { ok: false, msg: '未知工具', blocks: ['unknown_tool'] }
      const safeArgs = (args && typeof args === 'object') ? args : {}

      if (toolMeta.dryCapability === 'read_only') {
        try {
          const r = await Promise.resolve(fn(safeArgs))
          if (r && typeof r === 'object') {
            return { ...r, capability: { level: 'read_only' }, dryRun: true }
          }
          return { ok: true, msg: String(r || ''), capability: { level: 'read_only' }, dryRun: true }
        } catch (e) {
          const errMsg = String(e?.message || e)
          return { ok: false, msg: 'dry-run failed', error: errMsg, blocks: ['internal_error'], capability: { level: 'read_only' }, dryRun: true }
        }
      }

      return {
        ok: true,
        msg: 'dry-run: validate-only (no world probe)',
        preview: {
          title: `Would run tool: ${name}`,
          steps: [{ op: 'run', tool: name, args: safeArgs }]
        },
        warnings: ['dry-run currently validates tool/args only; runtime world state is not simulated'],
        blocks: [],
        uncertainty: 'high',
        capability: { level: 'validate_only' }
      }
    }).catch((e) => {
      const errMsg = String(e?.message || e)
      return { ok: false, msg: 'dry-run failed', error: errMsg, blocks: ['internal_error'] }
    })
  }

  function run (tool, args) {
    const fn = ctx.registry.get(tool)
    if (!fn) return { ok: false, msg: '未知工具' }
    return Promise
      .resolve()
      .then(() => fn(args || {}))
      .catch((e) => {
        const errMsg = String(e?.message || e)
        try { ctx.log?.error && ctx.log.error('action error', { tool, err: errMsg }) } catch {}
        return { ok: false, msg: '执行失败，请稍后再试~', error: errMsg }
      })
  }

  function list () { return Array.from(ctx.registry.keys()) }

  if (process.env.MC_DEBUG === '1' || process.env.MC_DEBUG === 'true') {
    const names = list()
    const report = buildToolRegistryReport(names)
    if (report.missing.length || report.extra.length) ctx.log?.warn && ctx.log.warn('tool registry mismatch', { missing: report.missing, extra: report.extra })
  }

  return { run, list, dry }
}

module.exports = {
  install,
  TOOL_NAMES,
  TOOL_SPECS,
  listToolMetadata,
  getToolMetadata,
  isToolAllowlisted,
  buildToolRegistryReport
}
