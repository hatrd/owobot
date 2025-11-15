const { assertCanEquipHand, isMainHandLocked } = require('../hand-lock')
const { Vec3 } = require('vec3')
const pvp = require('../pvp')
const observer = require('../agent/observer')
const skillRunnerMod = require('../agent/runner')

const TOOL_NAMES = ['goto', 'goto_block', 'follow_player', 'reset', 'stop', 'stop_all', 'say', 'hunt_player', 'defend_area', 'defend_player', 'equip', 'toss', 'break_blocks', 'place_blocks', 'light_area', 'collect', 'pickup', 'gather', 'harvest', 'feed_animals', 'cull_hostiles', 'mount_near', 'mount_player', 'dismount', 'observe_detail', 'observe_players', 'deposit', 'deposit_all', 'withdraw', 'withdraw_all', 'autofish', 'mine_ore', 'write_text', 'range_attack', 'skill_start', 'skill_status', 'skill_cancel', 'sort_chests']

const MODULES = [
  require('./modules/movement'),
  require('./modules/utility'),
  require('./modules/combat')
]

function createContext (bot, { log, on, registerCleanup } = {}) {
  const registry = new Map()
  const shared = {
    huntInterval: null,
    huntTarget: null,
    guardInterval: null,
    guardTarget: null,
    cullInterval: null,
    miningAbort: false
  }
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

  function run (tool, args) {
    const fn = ctx.registry.get(tool)
    if (!fn) return { ok: false, msg: '未知工具' }
    return Promise.resolve().then(() => fn(args || {})).catch((e) => ({ ok: false, msg: String(e?.message || e) }))
  }

  function list () { return Array.from(ctx.registry.keys()) }

  if (process.env.MC_DEBUG === '1' || process.env.MC_DEBUG === 'true') {
    const names = list()
    const missing = TOOL_NAMES.filter(n => !names.includes(n))
    const extra = names.filter(n => !TOOL_NAMES.includes(n))
    if (missing.length || extra.length) ctx.log?.warn && ctx.log.warn('TOOL_NAMES mismatch', { missing, extra })
  }

  return { run, list }
}

module.exports = { install, TOOL_NAMES }
