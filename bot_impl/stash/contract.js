const Ajv=require('ajv')
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const position=object(Object.fromEntries(['x','y','z'].map(k=>[k,{type:'integer',minimum:-30000000,maximum:30000000}])),['x','y','z'])
const radius={type:'integer',minimum:4,maximum:64}
const config=object({radius,keep:{type:'object',maxProperties:128,additionalProperties:{type:'integer',minimum:0,maximum:2304}},foodReserve:{type:'integer',minimum:16,maximum:256},routes:{type:'array',maxItems:128,items:object({item:{type:'string',minLength:1,maxLength:80},position},['item','position'])},overflow:{anyOf:[position,{type:'null'}]}})
const schemas={start:object({radius,requestId:{type:'string',minLength:1,maxLength:100}}),resume:object({}),cancel:object({}),configure:config}
const checks=Object.fromEntries(Object.entries(schemas).map(([k,v])=>[k,new Ajv().compile(v)]))
function validate(op,args={}){const check=checks[op];return check?.(args)?{ok:true}:{ok:false,error:'invalid_stash_arguments',errors:check?.errors||[]}}
module.exports={schemas,validate,envelope:object({op:{enum:Object.keys(schemas)},args:{type:'object'}},['op'])}
