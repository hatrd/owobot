#!/usr/bin/env node
const {request}=require('./controller-client')
async function main(){
  const [op='status',...flags]=process.argv.slice(2)
  if(!['start','status','cancel','resume'].includes(op))throw new Error('usage: fish.js start [--count=8] [--radius=64] | status | cancel | resume')
  const args={}
  const detail=flags.includes('--detail')
  for(const flag of flags.filter(f=>f!=='--detail')){const match=/^--(count|radius)=(\d+)$/.exec(flag);if(!match)throw new Error('unknown_flag');args[match[1]]=Number(match[2])}
  const payload=op==='status'?{op:'tool.dry',tool:'observe_detail',args:{what:'fishing',full:detail}}:{op:'tool.run',tool:'fishing_goal',args:{op,args}}
  const response=await request(payload)
  const d=response.data
  const output=op==='status'&&!detail&&d?{ok:response.ok,error:response.error,id:d.id,status:d.status,phase:d.phase,reason:d.reason||null,caught:d.caught,target:d.count,baseline:d.baseline,home:d.home,facts:d.facts,receipt:d.receipt||null,stats:d.stats,lastEvent:d.events?.at(-1)}:response
  console.log(JSON.stringify(output,null,2));if(!response.ok||response.result?.ok===false)process.exitCode=1
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1})
