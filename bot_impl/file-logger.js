const fs = require('fs')
const path = require('path')
const util = require('util')
const { formatDateTz, formatDateTimeTz } = require('./time-utils')

const state = {
  installed: false,
  path: null,
  stream: null,
  original: null
}

function toAbsolute (input, cwd) {
  if (!input) return null
  return path.isAbsolute(input) ? input : path.join(cwd, input)
}

function resolvePath (options = {}) {
  const cwd = process.cwd()
  const rawFile = options.file || process.env.MC_LOG_FILE
  if (rawFile && rawFile.toLowerCase() === 'off') return null
  if (rawFile) return toAbsolute(rawFile, cwd)

  const rawDir = options.dir || process.env.MC_LOG_DIR
  const dir = toAbsolute(rawDir, cwd) || path.join(cwd, 'logs')
  const stamp = formatDateTz()
  return path.join(dir, `bot-${stamp}.log`)
}

function ensureStream (targetPath) {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const stream = fs.createWriteStream(targetPath, { flags: 'a' })
  stream.on('error', (err) => {
    try {
      const msg = err?.stack || err?.message || String(err)
      if (state.original && typeof state.original.error === 'function') {
        state.original.error('File logger stream error:', msg)
      } else {
        process.stderr.write(`File logger stream error: ${msg}\n`)
      }
    } catch {}
  })
  return stream
}

function formatLine (level, args) {
  const prefix = `[${formatDateTimeTz()}][${level}]`
  if (!args || args.length === 0) return prefix
  try {
    return `${prefix} ${util.format(...args)}`
  } catch {
    try { return `${prefix} ${args.map(a => String(a)).join(' ')}` } catch { return prefix }
  }
}

function overrideConsole () {
  const levelMap = new Map([
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG'],
    ['trace', 'TRACE']
  ])

  for (const [method, level] of levelMap.entries()) {
    if (typeof console[method] !== 'function') continue
    const original = state.original[method] || state.original.log
    console[method] = (...args) => {
      try {
        if (state.stream) state.stream.write(formatLine(level, args) + '\n')
      } catch {}
      try {
        if (typeof original === 'function') original.apply(console, args)
      } catch {}
    }
  }
}

function attachFinalizers () {
  const finalize = () => {
    try { if (state.stream) state.stream.end() } catch {}
  }
  process.once('exit', finalize)
  process.once('SIGINT', finalize)
}

function install (options = {}) {
  if (state.installed) return { enabled: Boolean(state.stream), path: state.path }

  const target = resolvePath(options)
  if (!target) {
    state.installed = true
    state.path = null
    return { enabled: false, path: null }
  }

  try {
    state.original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      trace: console.trace
    }
    state.stream = ensureStream(target)
    state.path = target
    overrideConsole()
    attachFinalizers()
    state.installed = true
    if (state.stream) state.stream.write(`[${formatDateTimeTz()}][INFO] File logger attached\n`)
    return { enabled: true, path: state.path }
  } catch (err) {
    const msg = err?.stack || err?.message || String(err)
    try {
      if (state.original && typeof state.original.error === 'function') {
        state.original.error('Failed to install file logger:', msg)
      } else {
        process.stderr.write(`Failed to install file logger: ${msg}\n`)
      }
    } catch {}
    state.installed = true
    state.stream = null
    state.path = null
    return { enabled: false, path: null, error: err }
  }
}

function currentPath () {
  return state.path
}

module.exports = { install, currentPath }
