const CTL_OPS = Object.freeze({
  HELLO: 'hello',
  PROC_RESTART: 'proc.restart',
  AI_CHAT_DRY: 'ai.chat.dry',
  OBSERVE_SNAPSHOT: 'observe.snapshot',
  OBSERVE_PROMPT: 'observe.prompt',
  OBSERVE_DETAIL: 'observe.detail',
  OBSERVE_SCHEMA: 'observe.schema',
  TOOL_LIST: 'tool.list',
  TOOL_DRY: 'tool.dry',
  TOOL_RUN: 'tool.run',
  TOOL_SCHEMA: 'tool.schema',
  CTL_SCHEMA: 'ctl.schema'
})

const CTL_SCHEMA_TARGETS = Object.freeze({
  ctl: CTL_OPS.CTL_SCHEMA,
  observe: CTL_OPS.OBSERVE_SCHEMA,
  tool: CTL_OPS.TOOL_SCHEMA
})

const OBSERVE_MODE_TO_OP = Object.freeze({
  snapshot: CTL_OPS.OBSERVE_SNAPSHOT,
  prompt: CTL_OPS.OBSERVE_PROMPT,
  detail: CTL_OPS.OBSERVE_DETAIL
})

const CTL_OPERATION_SPECS = Object.freeze([
  { op: CTL_OPS.HELLO, requiresBot: false, description: 'Control-plane heartbeat and process status.' },
  {
    op: CTL_OPS.PROC_RESTART,
    aliases: ['process.restart'],
    requiresBot: false,
    description: 'Restart current bot process.',
    args: {
      mode: { type: 'string', enum: ['detached', 'inherit'], default: 'detached' },
      delayMs: { type: 'string', description: 'Duration (supports ms/s/m/h suffix).' }
    }
  },
  {
    op: CTL_OPS.AI_CHAT_DRY,
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
    op: CTL_OPS.OBSERVE_SNAPSHOT,
    requiresBot: true,
    description: 'Structured runtime snapshot for AI/game context.',
    args: { '*': { type: 'object', description: 'Snapshot options.' } }
  },
  {
    op: CTL_OPS.OBSERVE_PROMPT,
    requiresBot: true,
    description: 'Prompt text plus snapshot, as used by AI context assembly.',
    args: { '*': { type: 'object', description: 'Prompt/snapshot options.' } }
  },
  {
    op: CTL_OPS.OBSERVE_DETAIL,
    requiresBot: true,
    description: 'Focused read-only observation details.',
    args: { '*': { type: 'object', description: 'Detail options (see observe.schema).' } }
  },
  { op: CTL_OPS.OBSERVE_SCHEMA, requiresBot: false, description: 'Observer detail schema and aliases.' },
  { op: CTL_OPS.TOOL_LIST, requiresBot: true, description: 'Tool allowlist and registration report.' },
  {
    op: CTL_OPS.TOOL_DRY,
    requiresBot: true,
    description: 'Dry-run one tool call.',
    args: {
      tool: { type: 'string', required: true },
      args: { type: 'object', description: 'Tool arguments.' }
    }
  },
  {
    op: CTL_OPS.TOOL_RUN,
    requiresBot: true,
    description: 'Execute one tool call.',
    args: {
      tool: { type: 'string', required: true },
      args: { type: 'object', description: 'Tool arguments.' }
    }
  },
  { op: CTL_OPS.TOOL_SCHEMA, requiresBot: false, description: 'Tool metadata + parameter schemas.' },
  { op: CTL_OPS.CTL_SCHEMA, requiresBot: false, description: 'Control-plane operation schema.' }
])

function cloneObject (value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneObject)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = cloneObject(item)
  return out
}

const CTL_OP_CANONICAL = new Map()
for (const spec of CTL_OPERATION_SPECS) {
  const op = String(spec?.op || '').trim().toLowerCase()
  if (!op) continue
  CTL_OP_CANONICAL.set(op, op)
  const aliases = Array.isArray(spec?.aliases) ? spec.aliases : []
  for (const aliasRaw of aliases) {
    const alias = String(aliasRaw || '').trim().toLowerCase()
    if (!alias) continue
    CTL_OP_CANONICAL.set(alias, op)
  }
}

function normalizeCtlOp (value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  return CTL_OP_CANONICAL.get(raw) || ''
}

function listCtlOperationSpecs () {
  return CTL_OPERATION_SPECS.map(spec => cloneObject(spec))
}

function listCtlSchemaTargets () {
  return Object.keys(CTL_SCHEMA_TARGETS)
}

function resolveCtlSchemaOp (target) {
  const key = String(target || '').trim().toLowerCase()
  if (!key) return ''
  return CTL_SCHEMA_TARGETS[key] || ''
}

function listObserveModes () {
  return Object.keys(OBSERVE_MODE_TO_OP)
}

function resolveObserveOp (mode) {
  const key = String(mode || '').trim().toLowerCase()
  if (!key) return ''
  return OBSERVE_MODE_TO_OP[key] || ''
}

module.exports = {
  CTL_OPS,
  listCtlOperationSpecs,
  normalizeCtlOp,
  listCtlSchemaTargets,
  resolveCtlSchemaOp,
  listObserveModes,
  resolveObserveOp
}
