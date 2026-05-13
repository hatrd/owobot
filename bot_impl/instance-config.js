const fs = require('fs')
const path = require('path')

function safeSlug (value) {
  const raw = String(value || '').trim()
  if (!raw) return 'default'
  const slug = raw
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'default'
}

function parsePort (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function parseConfigFile ({ cwd, file, readFile }) {
  if (!file) return {}
  const abs = path.isAbsolute(file) ? file : path.join(cwd, file)
  const body = readFile(abs)
  if (!body) return {}
  const parsed = JSON.parse(body)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function resolvePath (cwd, value, fallback) {
  const raw = value || fallback
  return path.isAbsolute(raw) ? raw : path.join(cwd, raw)
}

function resolveInstanceConfig ({ cwd = process.cwd(), argv = { args: {} }, env = process.env, readFile = fs.readFileSync } = {}) {
  const args = argv && argv.args && typeof argv.args === 'object' ? argv.args : {}
  const fileConfig = parseConfigFile({ cwd, file: args.config || args['config-file'] || env.MCBOT_CONFIG, readFile })
  const profile = safeSlug(args.profile || args.instance || env.MCBOT_PROFILE || env.MCBOT_INSTANCE || fileConfig.profile || fileConfig.instance)
  const hasExplicitProfile = Boolean(args.profile || args.instance || env.MCBOT_PROFILE || env.MCBOT_INSTANCE || fileConfig.profile || fileConfig.instance)

  const legacyDataDir = path.join(cwd, 'data')
  const legacyLogDir = path.join(cwd, 'logs')
  const profileBase = path.join(cwd, '.mcbot', 'instances', profile)
  const runtimeDefault = hasExplicitProfile ? path.join(profileBase, 'runtime') : cwd
  const dataDefault = hasExplicitProfile ? path.join(cwd, 'data', 'instances', profile) : legacyDataDir
  const logsDefault = hasExplicitProfile ? path.join(cwd, 'logs', 'instances', profile) : legacyLogDir

  const dirs = {
    runtime: resolvePath(cwd, args['runtime-dir'] || env.MCBOT_RUNTIME_DIR || fileConfig.runtimeDir, runtimeDefault),
    data: resolvePath(cwd, args['data-dir'] || env.MCBOT_DATA_DIR || fileConfig.dataDir, dataDefault),
    logs: resolvePath(cwd, args['log-dir'] || env.MC_LOG_DIR || fileConfig.logDir, logsDefault)
  }

  const connection = {
    host: args.host || fileConfig.host || env.MC_HOST,
    port: parsePort(args.port || fileConfig.port || env.MC_PORT),
    username: args.username || args.user || fileConfig.username || fileConfig.user || env.MC_USERNAME,
    auth: args.auth || fileConfig.auth || env.MC_AUTH || 'offline'
  }
  const password = args.password || fileConfig.password || env.MC_PASSWORD
  if (password) connection.password = password
  const version = args.version || fileConfig.version || env.MC_VERSION
  if (version) connection.version = version

  return {
    profile,
    connection,
    dirs,
    control: {
      pidPath: resolvePath(cwd, args['pid-path'] || env.MCBOT_PID_PATH || fileConfig.pidPath, hasExplicitProfile ? path.join(dirs.runtime, 'mcbot.pid') : path.join(cwd, '.mcbot.pid')),
      sockPath: resolvePath(cwd, args['sock-path'] || env.MCBOT_SOCK_PATH || fileConfig.sockPath, hasExplicitProfile ? path.join(dirs.runtime, 'mcbot.sock') : path.join(cwd, '.mcbot.sock'))
    },
    files: {
      memory: resolvePath(cwd, fileConfig.memoryFile || env.MCBOT_MEMORY_FILE, path.join(dirs.data, 'ai-memory.json')),
      evolution: resolvePath(cwd, fileConfig.evolutionFile || env.MCBOT_EVOLUTION_FILE, path.join(dirs.data, 'ai-evolution.json')),
      people: resolvePath(cwd, fileConfig.peopleFile || env.MCBOT_PEOPLE_FILE, path.join(dirs.data, 'ai-people.json')),
      greetZones: resolvePath(cwd, fileConfig.greetZonesFile || env.GREET_ZONES_FILE, path.join(dirs.data, 'greet-zones.json'))
    }
  }
}

module.exports = {
  resolveInstanceConfig
}
