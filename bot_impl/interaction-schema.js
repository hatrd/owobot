const crypto = require('crypto')
const path = require('path')

const actionsMod = require('./actions')
const observer = require('./agent/observer')
const toolSchemas = require('./ai-chat/tool-schemas')

const DEFAULT_PARAMETERS = { type: 'object', properties: {}, additionalProperties: true }

const CTL_OPERATION_SPECS = Object.freeze([
  { op: 'hello', requiresBot: false, description: 'Control-plane heartbeat and process status.' },
  {
    op: 'proc.restart',
    aliases: ['process.restart'],
    requiresBot: false,
    description: 'Restart current bot process.',
    args: {
      mode: { type: 'string', enum: ['detached', 'inherit'], default: 'detached' },
      delayMs: { type: 'string', description: 'Duration (supports ms/s/m/h suffix).' }
    }
  },
  {
    op: 'ai.chat.dry',
    aliases: ['chat.dry'],
    requiresBot: true,
    description: 'Dry-run one AI chat turn without real world side effects.',
    args: {
      username: { type: 'string' },
      content: { type: 'string' },
      withTools: { type: 'boolean', default: true },
      maxToolCalls: { type: 'number' }
    }
  },
  {
    op: 'observe.snapshot',
    requiresBot: true,
    description: 'Structured runtime snapshot for AI/game context.',
    args: { '*': { type: 'object', description: 'Snapshot options.' } }
  },
  {
    op: 'observe.prompt',
    requiresBot: true,
    description: 'Prompt text plus snapshot, as used by AI context assembly.',
    args: { '*': { type: 'object', description: 'Prompt/snapshot options.' } }
  },
  {
    op: 'observe.detail',
    requiresBot: true,
    description: 'Focused read-only observation details.',
    args: { '*': { type: 'object', description: 'Detail options (see observe.schema).' } }
  },
  { op: 'observe.schema', requiresBot: false, description: 'Observer detail schema and aliases.' },
  { op: 'tool.list', requiresBot: true, description: 'Tool allowlist and registration report.' },
  {
    op: 'tool.dry',
    requiresBot: true,
    description: 'Dry-run one tool call.',
    args: {
      tool: { type: 'string', required: true },
      args: { type: 'object', description: 'Tool arguments.' }
    }
  },
  {
    op: 'tool.run',
    requiresBot: true,
    description: 'Execute one tool call.',
    args: {
      tool: { type: 'string', required: true },
      args: { type: 'object', description: 'Tool arguments.' }
    }
  },
  { op: 'tool.schema', requiresBot: false, description: 'Tool metadata + parameter schemas.' },
  { op: 'ctl.schema', requiresBot: false, description: 'Control-plane operation schema.' }
])

function cloneObject (value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneObject)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = cloneObject(item)
  return out
}

function stableStringify (value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b))
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function hashObject (value) {
  try {
    const text = stableStringify(value)
    return crypto.createHash('sha256').update(text).digest('hex')
  } catch {
    return ''
  }
}

function shortHash (hash, size = 12) {
  const text = String(hash || '').trim()
  if (!text) return ''
  return text.slice(0, Math.max(4, size))
}

function readPackageVersion () {
  try {
    // eslint-disable-next-line import/no-dynamic-require
    const pkg = require(path.join(__dirname, '..', 'package.json'))
    return String(pkg?.version || '').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function listCtlOperationSpecs () {
  return CTL_OPERATION_SPECS.map(spec => cloneObject(spec))
}

function getCtlSchema () {
  return {
    version: 1,
    ops: listCtlOperationSpecs()
  }
}

function getObserveSchema () {
  if (typeof observer.getDetailSchema === 'function') return observer.getDetailSchema()
  return {
    version: 1,
    op: 'observe.detail',
    defaultWhat: 'entities',
    supported: Array.isArray(observer.DETAIL_WHAT_CANONICAL)
      ? observer.DETAIL_WHAT_CANONICAL.map(what => ({ what, description: '' }))
      : [],
    aliases: observer.DETAIL_WHAT_ALIASES
      ? Object.entries(observer.DETAIL_WHAT_ALIASES).map(([alias, canonical]) => ({ alias, canonical }))
      : []
  }
}

function listToolMetadata () {
  if (typeof actionsMod.listToolMetadata === 'function') return actionsMod.listToolMetadata()
  if (Array.isArray(actionsMod.TOOL_NAMES)) {
    return actionsMod.TOOL_NAMES.map(name => ({ name, dryCapability: 'validate_only' }))
  }
  return []
}

function listActionToolDefinitions () {
  if (typeof toolSchemas.listActionToolDefinitions === 'function') return toolSchemas.listActionToolDefinitions()
  if (Array.isArray(toolSchemas.ACTION_TOOL_DEFINITIONS)) return toolSchemas.ACTION_TOOL_DEFINITIONS.map(def => cloneObject(def))
  return []
}

function getToolSchema () {
  const metadata = listToolMetadata()
  const actionDefinitions = listActionToolDefinitions()
  const byName = new Map(actionDefinitions.map(def => [String(def?.name || ''), def]))
  const tools = metadata.map((meta) => {
    const name = String(meta?.name || '')
    const def = byName.get(name)
    return {
      name,
      dryCapability: meta?.dryCapability === 'read_only' ? 'read_only' : 'validate_only',
      description: String(def?.description || '').trim(),
      parameters: def?.parameters && typeof def.parameters === 'object' ? cloneObject(def.parameters) : cloneObject(DEFAULT_PARAMETERS)
    }
  })

  const report = typeof toolSchemas.getActionToolSchemaReport === 'function'
    ? toolSchemas.getActionToolSchemaReport()
    : {
        allowlistCount: tools.length,
        missingSchema: tools.filter(tool => !tool.description).map(tool => tool.name),
        staleSchema: actionDefinitions.map(def => String(def?.name || '')).filter(name => !metadata.find(meta => meta?.name === name))
      }

  return {
    version: 1,
    count: tools.length,
    tools,
    report
  }
}

function getSchemaDigestInfo (schemaBundle) {
  const ctlSchema = schemaBundle?.ctlSchema || getCtlSchema()
  const observeSchema = schemaBundle?.observeSchema || getObserveSchema()
  const toolSchema = schemaBundle?.toolSchema || getToolSchema()
  const payload = {
    ctl: ctlSchema,
    observe: observeSchema,
    tool: {
      version: toolSchema?.version,
      count: toolSchema?.count,
      tools: Array.isArray(toolSchema?.tools)
        ? toolSchema.tools.map(tool => ({
            name: String(tool?.name || ''),
            dryCapability: String(tool?.dryCapability || 'validate_only'),
            description: String(tool?.description || '')
          }))
        : [],
      report: toolSchema?.report || {}
    }
  }
  const hash = hashObject(payload)
  return {
    version: 1,
    hash,
    hashShort: shortHash(hash),
    components: {
      ctl: Number(ctlSchema?.version || 1),
      observe: Number(observeSchema?.version || 1),
      tool: Number(toolSchema?.version || 1)
    }
  }
}

function getRuntimeCapabilities () {
  const ctlSchema = getCtlSchema()
  const observeSchema = getObserveSchema()
  const toolSchema = getToolSchema()
  const digest = getSchemaDigestInfo({ ctlSchema, observeSchema, toolSchema })
  const supportedOps = Array.isArray(ctlSchema?.ops)
    ? ctlSchema.ops.map(item => String(item?.op || '').trim()).filter(Boolean)
    : []
  const packageVersion = readPackageVersion()
  const configuredBuildHash = String(process.env.MCBOT_BUILD_HASH || '').trim()
  const derivedBuildHash = shortHash(hashObject({
    packageVersion,
    schemaHash: digest.hash,
    opCount: supportedOps.length
  }))

  return {
    protocolVersion: 1,
    schema: digest,
    controlPlane: {
      supportedOps,
      opCount: supportedOps.length
    },
    observe: {
      supportedWhatCount: Array.isArray(observeSchema?.supported) ? observeSchema.supported.length : 0,
      aliasCount: Array.isArray(observeSchema?.aliases) ? observeSchema.aliases.length : 0
    },
    tool: {
      allowlistCount: Number(toolSchema?.count || 0),
      missingSchemaCount: Array.isArray(toolSchema?.report?.missingSchema) ? toolSchema.report.missingSchema.length : 0
    },
    build: {
      packageVersion,
      nodeVersion: process.version,
      hash: configuredBuildHash || derivedBuildHash,
      hashSource: configuredBuildHash ? 'env:MCBOT_BUILD_HASH' : 'derived'
    }
  }
}

module.exports = {
  listCtlOperationSpecs,
  getCtlSchema,
  getObserveSchema,
  getToolSchema,
  getRuntimeCapabilities,
  getSchemaDigestInfo
}
