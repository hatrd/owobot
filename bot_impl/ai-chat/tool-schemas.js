const { ACTION_TOOL_DEFINITIONS, listActionToolDefinitions, getActionToolSchemaReport, isActionToolAllowed } = require('../action-tool-schemas')
const cloneObject = value => value == null ? value : JSON.parse(JSON.stringify(value))

const SPECIAL_TOOLS = [
  {
    name: 'forget_memory',
    description: 'Disable memories owned by the current player that match an explicit query. Use when that player asks to forget or revoke a remembered fact.',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }
  },
  {
    name: 'feedback',
    description: 'When a requested feature cannot be executed with available tools/commands, record a one-sentence requirement and the full current chat context into a plaintext backlog for later review. Optionally also tell the player what happened, and (in plan mode) terminate the current plan.',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'One-sentence requirement to record.' },
        publicMessage: { type: 'string', description: 'Optional short explanation to send to the player.' },
        terminatePlan: { type: 'boolean', description: 'If true, stop current plan mode. In plan mode, this defaults to true when omitted.' }
      },
      required: ['need'],
      additionalProperties: false
    }
  },
  {
    name: 'write_memory',
    description: 'Persist or reinforce a long-term memory entry for the bot. Should *only* be used if the player ask for memorizing, don\'t use it casually',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Memory content to store.' },
        importance: { type: 'number', description: 'Relative importance weight (>=1).' },
        author: { type: 'string', description: 'Author/player attribution.' },
        source: { type: 'string', description: 'Subsystem name such as ai/chat.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'add_commitment',
    description: 'Record a promise/commitment the bot should keep. Use only when the player asks for a promise or you explicitly agree to do something later.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Commitment content to record.' },
        player: { type: 'string', description: 'Player name for the commitment (defaults to current user).' },
        deadlineMs: { type: 'number', description: 'Optional deadline as a Unix timestamp in milliseconds.' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'plan_mode',
    description: 'For complex tasks, output an ordered plan list (short, executable steps). The system will execute the steps one by one automatically.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Player goal or summary of the request.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered, concise steps for execution.' },
        note: { type: 'string', description: 'Optional caveats or prerequisites.' }
      },
      required: ['steps'],
      additionalProperties: true
    }
  },
  {
    name: 'stop_listen',
    description: 'Exit active listening mode for chat follow-ups. Optionally send one public message before going quiet.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Optional public message to send before stopping listening.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'skip',
    description: 'Do nothing and end the current tool loop immediately. Use when waiting, or when the task is already completed and no further action/reply is needed.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why we skip and end this round.' }
      },
      additionalProperties: true
    }
  }
]

function assertUniqueToolDefinitions (defs) {
  const seen = new Set()
  for (const def of defs) {
    const name = String(def?.name || '').trim()
    if (!name) throw new Error('Invalid AI tool schema: empty tool name')
    if (seen.has(name)) throw new Error('Duplicate AI tool schema: ' + name)
    seen.add(name)
  }
}

function stripParameterDescriptions (value) {
  if (!value || typeof value !== 'object') return cloneObject(value)
  if (Array.isArray(value)) return value.map(stripParameterDescriptions)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'description') continue
    out[key] = stripParameterDescriptions(item)
  }
  return out
}

function buildToolFunctionList () {
  const defs = ACTION_TOOL_DEFINITIONS.concat(SPECIAL_TOOLS)
  assertUniqueToolDefinitions(defs)
  return defs.map(def => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters || { type: 'object', properties: {}, additionalProperties: true }
    }
  }))
}

function buildProviderToolFunctionList () {
  const defs = ACTION_TOOL_DEFINITIONS.concat(SPECIAL_TOOLS)
  assertUniqueToolDefinitions(defs)
  return defs.map(def => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: stripParameterDescriptions(def.parameters || { type: 'object', properties: {}, additionalProperties: true })
    }
  }))
}

module.exports = {
  ACTION_TOOL_DEFINITIONS,
  listActionToolDefinitions,
  getActionToolSchemaReport,
  buildToolFunctionList,
  buildProviderToolFunctionList,
  isActionToolAllowed
}
