const Ajv = require('ajv/dist/ajv')
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string', minLength: 1, maxLength: 240 }
const position = object(Object.fromEntries(['x', 'y', 'z'].map(k => [k, { type: 'number', minimum: -30000000, maximum: 30000000 }])))
const record = object({
  id: text, kind: { enum: ['home', 'protected', 'mining', 'hazard', 'route', 'resource', 'player', 'task'] },
  subject: text, dimension: text, position, radius: { type: 'number', minimum: 0, maximum: 2048 },
  minY: { type: 'integer', minimum: -30000000, maximum: 30000000 }, maxY: { type: 'integer', minimum: -30000000, maximum: 30000000 },
  fact: { type: 'string', minLength: 1, maxLength: 4000 }, source: text,
  confidence: { enum: ['observed', 'reported', 'inferred'] },
  inventoryHold: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 120 } },
  expiresAt: { type: 'integer', minimum: 0 }
}, ['id', 'kind', 'subject', 'fact', 'source', 'confidence'])
const query = object({ kind: record.properties.kind, subject: text, dimension: text, max: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 }, id: text }, [])
const schemas = { 'knowledge.query': query, 'knowledge.put': record, 'knowledge.remove': object({ id: text }) }
const validator = new Ajv().compile(record)
function validRecord (r) {
  const { updatedAt, createdAt, ...input } = r || {}
  return validator(input) && (input.minY === undefined || input.maxY === undefined || input.minY <= input.maxY) && (!['home', 'protected', 'mining', 'hazard', 'resource', 'route'].includes(input.kind) || (input.position && input.dimension && Number.isFinite(input.radius)))
}
module.exports = { schemas, record, validRecord }
