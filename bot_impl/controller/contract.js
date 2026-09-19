// The controller protocol and behavior language are independent of model/provider APIs.
const Ajv = require('ajv/dist/ajv')
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string', minLength: 1, maxLength: 120 }
const duration = { type: 'integer', minimum: 100, maximum: 300000 }
const coordinate = { type: 'number', minimum: -30000000, maximum: 30000000 }
const next = text
const actionSchemas = {
  tunnel_step: object({ x: { ...coordinate, type: 'integer' }, y: { ...coordinate, type: 'integer' }, z: { ...coordinate, type: 'integer' } }),
  smelt: object({ x: { ...coordinate, type: 'integer' }, y: { ...coordinate, type: 'integer' }, z: { ...coordinate, type: 'integer' }, input: text, output: text, count: { type: 'integer', minimum: 1, maximum: 8 }, fuel: text, fuelCount: { type: 'integer', minimum: 1, maximum: 64 } }),
  surface_travel: object({ x: coordinate, y: { ...coordinate, type: 'integer' }, z: coordinate }),
  storage_transfer: object({ x: { ...coordinate, type: 'integer' }, y: { ...coordinate, type: 'integer' }, z: { ...coordinate, type: 'integer' }, direction: { enum: ['deposit', 'withdraw'] }, item: text, count: { type: 'integer', minimum: 1, maximum: 2304 } }),
  excavate: object({ x: { ...coordinate, type: 'integer' }, y: { ...coordinate, type: 'integer' }, z: { ...coordinate, type: 'integer' }, expected: text }),
  discard: object({ item: { enum: ['stone', 'deepslate', 'cobblestone', 'cobbled_deepslate', 'dirt', 'granite', 'diorite', 'andesite', 'tuff', 'netherrack'] }, keep: { type: 'integer', minimum: 0, maximum: 256 } }),
  feed_cat: object({ uuid: { type: 'string', minLength: 1, maxLength: 64 } }),
  goto: object({ x: coordinate, y: coordinate, z: coordinate, range: { type: 'number', minimum: 0.5, maximum: 8 } }, ['x', 'y', 'z']),
  look: object({ yaw: { type: 'number', minimum: -6.284, maximum: 6.284 }, pitch: { type: 'number', minimum: -1.571, maximum: 1.571 } }),
  say: object({ text: { ...text, pattern: '^[^\\s/]', description: 'Plain chat; no leading whitespace or server commands.' } }),
  observe: object({ what: { type: 'string', enum: ['entities', 'players', 'cats', 'signs', 'inventory', 'blocks'] }, radius: { type: 'integer', minimum: 1, maximum: 32 }, max: { type: 'integer', minimum: 1, maximum: 40 } }, ['what'])
}
const condition = object({ field: { enum: ['health', 'food', 'oxygenLevel'] }, operator: { enum: ['lt', 'lte', 'eq', 'gte', 'gt'] }, value: { type: 'number' } })
const nodeSchema = { oneOf: [
  ...Object.entries(actionSchemas).map(([action, args]) => object({ type: { const: 'action' }, action: { const: action }, args, next, timeoutMs: duration }, ['type', 'action', 'args', 'next', 'timeoutMs'])),
  object({ type: { const: 'wait' }, ms: duration, next }),
  object({ type: { const: 'wait_event' }, event: { enum: ['health', 'entityHurt', 'rain', 'day', 'night'] }, next, timeoutMs: duration }),
  object({ type: { const: 'branch' }, condition, yes: next, no: next }),
  object({ type: { const: 'end' } })
] }
const behaviorSchema = object({ id: text, revision: text, entry: text, nodes: { type: 'object', minProperties: 1, maxProperties: 64, propertyNames: text, additionalProperties: nodeSchema } })
const credentials = { leaseId: text, epoch: { type: 'integer', minimum: 1 } }
const knowledge = require('../memory/contract').schemas
const schemas = {
  ...Object.fromEntries(Object.entries(knowledge).map(([op, schema]) => [op, op === 'knowledge.query' ? schema : { ...schema, properties: { ...schema.properties, ...credentials }, required: [...schema.required, 'leaseId', 'epoch'] }])),
  'memory.recall': object({ radius: { type: 'integer', minimum: 1, maximum: 512 }, max: { type: 'integer', minimum: 1, maximum: 20 } }, []),
  'memory.begin': object({ ...credentials, objective: { type: 'string', minLength: 1, maxLength: 240 }, maxRadius: { type: 'integer', minimum: 8, maximum: 256 } }),
  'memory.resume': object({ ...credentials, missionId: text }),
  'memory.pause': object({ ...credentials, missionId: text, reason: text }),
  'memory.checkpoint': object({ ...credentials, missionId: text }),
  'schema': object({}),
  'status': object({ taskId: text }, []),
  'events.read': object({ cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, []),
  'behavior.validate': object({ behavior: behaviorSchema }),
  'session.acquire': object({ controllerId: text, ttlMs: { type: 'integer', minimum: 1000, maximum: 60000 } }),
  'session.renew': object({ ...credentials, ttlMs: { type: 'integer', minimum: 1000, maximum: 60000 } }),
  'session.release': object(credentials),
  'behavior.remove': object({ ...credentials, behaviorId: text, revision: text }),
  'behavior.install': object({ ...credentials, behavior: behaviorSchema }),
  'task.start': object({ ...credentials, requestId: text, behaviorId: text, revision: text, timeoutMs: duration, missionId: text }, ['leaseId', 'epoch', 'requestId', 'behaviorId', 'revision', 'timeoutMs']),
  'task.cancel': object({ ...credentials, taskId: text })
}
const readOps = ['knowledge.query', 'memory.recall', 'schema', 'status', 'events.read', 'behavior.validate']
const writeOps = Object.keys(schemas).filter(op => !readOps.includes(op))
const ajv = new Ajv({ allErrors: true, strict: false })
const validators = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]))
function validate (op, args) {
  const check = validators[op]
  if (!check) return { ok: false, error: 'unknown_operation' }
  if (!check(args)) return { ok: false, error: 'invalid_arguments', errors: JSON.parse(JSON.stringify(check.errors)) }
  if (args.behavior) {
    const b = args.behavior
    if (!Object.hasOwn(b.nodes, b.entry)) return { ok: false, error: 'missing_entry' }
    for (const [id, node] of Object.entries(b.nodes)) {
      for (const key of ['next', 'yes', 'no']) if (node[key] && !Object.hasOwn(b.nodes, node[key])) return { ok: false, error: 'invalid_transition', node: id, target: node[key] }
    }
  }
  return { ok: true }
}
const envelope = ops => object({ op: { enum: ops }, args: { type: 'object', default: {} } }, ['op'])
module.exports = { schemas, behaviorSchema, actionSchemas, readOps, writeOps, validate, envelope }
