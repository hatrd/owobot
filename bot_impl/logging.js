const fs = require('fs')
const path = require('path')

const LEVELS = { off: -1, error: 0, warn: 1, info: 2, debug: 3 }

function parseSpec (spec) {
  const map = new Map()
  if (!spec || typeof spec !== 'string') return map
  for (const raw of spec.split(/[\s,]+/).filter(Boolean)) {
    const tok = raw.trim()
    const [nsRaw, lvlRaw] = tok.includes(':') ? tok.split(':', 2) : [tok, 'debug']
    const ns = nsRaw.toLowerCase()
    const lvl = (lvlRaw || '').toLowerCase()
    const level = LEVELS[lvl] != null ? LEVELS[lvl] : LEVELS.debug
    map.set(ns, level)
  }
  return map
}

function defaultLevelFromEnv () {
  const debugEnv = String(process.env.MC_DEBUG ?? '1').toLowerCase()
  const debugOn = !(debugEnv === '0' || debugEnv === 'false' || debugEnv === 'no' || debugEnv === 'off')
  return debugOn ? LEVELS.info : LEVELS.warn
}

// Active config lives in shared state when available, so runtime changes persist across reloads.
let active = { map: new Map(), defaultLevel: defaultLevelFromEnv(), spec: '' }

function loadInitialSpec () {
  let spec = process.env.LOG
  if (!spec) {
    try {
      const p = path.resolve(__dirname, '.log')
      if (fs.existsSync(p)) spec = String(fs.readFileSync(p)).trim()
    } catch {}
  }
  return spec || ''
}

function applySpec (spec) {
  const map = parseSpec(spec)
  const defaultLevel = map.has('all') ? map.get('all') : defaultLevelFromEnv()
  active.map = map
  active.defaultLevel = defaultLevel
  active.spec = spec
}

function init (state) {
  if (!state) return
  if (!state.logConfig) {
    state.logConfig = {
      spec: loadInitialSpec(),
      map: new Map(),
      defaultLevel: defaultLevelFromEnv()
    }
  }
  active = state.logConfig
  // Ensure map/default match spec
  applySpec(active.spec || '')
}

function setSpec (spec) {
  applySpec(spec || '')
}

function setLevel (ns, levelName) {
  const lvl = LEVELS[String(levelName).toLowerCase()]
  if (lvl == null) return false
  const key = String(ns).toLowerCase()
  if (key === 'all') active.defaultLevel = lvl
  else active.map.set(key, lvl)
  // Rebuild spec string from map + default
  const parts = []
  if (active.defaultLevel !== defaultLevelFromEnv()) parts.push(`all:${getLevelName(active.defaultLevel)}`)
  for (const [k, v] of active.map.entries()) parts.push(`${k}:${getLevelName(v)}`)
  active.spec = parts.join(',')
  return true
}

function getSpec () { return active.spec }

function getLevelName (n) {
  for (const [k, v] of Object.entries(LEVELS)) if (v === n) return k
  return 'unknown'
}

function levelForNs (ns) {
  const key = String(ns || 'core').toLowerCase()
  return active.map.has(key) ? active.map.get(key) : active.defaultLevel
}

function getLogger (ns) {
  const key = String(ns || 'core').toLowerCase()
  function should (want) { return LEVELS[want] <= levelForNs(key) }
  function fmt (lvl, args) { return [`[${lvl.toUpperCase()}][${key}]`, ...args] }
  return {
    debug: (...args) => { if (should('debug')) console.log(...fmt('debug', args)) },
    info: (...args) => { if (should('info')) console.log(...fmt('info', args)) },
    warn: (...args) => { if (should('warn')) console.warn(...fmt('warn', args)) },
    error: (...args) => { if (should('error')) console.error(...fmt('error', args)) }
  }
}

module.exports = { getLogger, LEVELS, init, setSpec, setLevel, getSpec, parseSpec }
