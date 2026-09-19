#!/usr/bin/env node
const {request}=require('./controller-client')
async function main(){
  const [op='status',...flags]=process.argv.slice(2)
  if(!['start','status','cancel','resume'].includes(op))throw new Error('usage: fish.js start [--count=8] [--radius=64] | status | cancel | resume')
  const args={}
  for(const flag of flags){const match=/^--(count|radius)=(\d+)$/.exec(flag);if(!match)throw new Error('unknown_flag');args[match[1]]=Number(match[2])}
  const payload=op==='status'?{op:'tool.dry',tool:'observe_detail',args:{what:'fishing'}}:{op:'tool.run',tool:'fishing_goal',args:{op,args}}
  const response=await request(payload)
  console.log(JSON.stringify(response,null,2));if(!response.ok||response.result?.ok===false)process.exitCode=1
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1})
