const Ajv = require('ajv')
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const position = object(Object.fromEntries(['x','y','z'].map(k => [k,{type:'number',minimum:-30000000,maximum:30000000}])), ['x','y','z'])
const schemas = {
  start: object({ count: {type:'integer',minimum:1,maximum:64}, home:position, radius:{type:'integer',minimum:8,maximum:128} }),
  resume: object({radius:{type:'integer',minimum:8,maximum:128}}), cancel: object({})
}
const checks = Object.fromEntries(Object.entries(schemas).map(([k,v])=>[k,new Ajv().compile(v)]))
function validate(op,args={}) { const check=checks[op]; return check?.(args)?{ok:true}:{ok:false,error:'invalid_fishing_arguments',errors:check?.errors || []} }
module.exports = {schemas,validate,envelope:object({op:{enum:Object.keys(schemas)},args:{type:'object'}},['op'])}
