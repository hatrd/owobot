const Ajv = require('ajv/dist/ajv')
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const position = object(Object.fromEntries(['x', 'y', 'z'].map(k => [k, { type: 'number', minimum: -30000000, maximum: 30000000 }])), ['x', 'y', 'z'])
const schemas = {
  enable: object({ home: position, maxRadius: { type: 'integer', minimum: 8, maximum: 128 }, wanderIntervalMs: { type: 'integer', minimum: 5000, maximum: 300000 }, feedCooldownMs: { type: 'integer', minimum: 300000, maximum: 86400000 } }),
  disable: object({}),
  set_home: object({ home: position }),
  status: object({})
}
const validators = Object.fromEntries(Object.entries(schemas).map(([op, schema]) => [op, new Ajv().compile(schema)]))
function validate (op, args = {}) {
  const check = validators[op]
  return check?.(args) ? { ok: true } : { ok: false, error: 'invalid_life_arguments', errors: check?.errors || [{ message: 'unknown operation' }] }
}
const writeOps = ['enable', 'disable', 'set_home']
const envelope = { type: 'object', properties: { op: { enum: writeOps }, args: { type: 'object' } }, required: ['op'], additionalProperties: false }
module.exports = { schemas, validate, envelope }
