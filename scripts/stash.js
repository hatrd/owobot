#!/usr/bin/env node
// Provider-neutral CLI: one run waits for a terminal receipt; timeout leaves the
// durable goal running and returns its id. No secret config or model SDK needed.
const path=require('path')
const {request}=require('./controller-client')
const root=path.resolve(__dirname,'..')
const help=`Usage: node scripts/stash.js <preview|run|start|status|resume|cancel|configure|schema> [JSON] [--detail] [--timeout=300]
run/start: {"radius":64,"requestId":"optional-idempotency-key"}
configure: {"keep":{"oak_log":32},"foodReserve":64,"routes":[{"item":"raw_copper","position":{"x":0,"y":64,"z":0}}],"overflow":{"x":1,"y":64,"z":0}}
preview: read-only discovery and dated cached storage evidence; no walking or deposit.
run: starts, waits, returns receipt. resume also waits. start returns immediately.
Default radius: 64 (maximum 64); configured destinations are visited first.
Default: retain equipment/custom items, 64 of each food, all durable task holds.
Routes: explicit > frame > same item already in storage > configured overflow.
No arbitrary junk chest. No matching destination/full chest => partial, cargo retained.
Inventory only; never withdraw, drop, break or place blocks. Return to starting point.
Config/catalog persist per world. Configure replaces provided keep/routes collections.
Exit: 0 succeeded/read success; 2 partial; 3 blocked/canceled/paused; 4 wait timeout (goal continues); 1 request error.
Status includes schemas; --detail adds plan, individual transfer receipts and diagnostics.`
function compact(response,detail){
  if(detail||!response.data||!("goal" in response.data))return response
  const {goal:g,...data}=response.data
  delete data.schemas
  if(!g)return {...response,data:{...data,goal:null}}
  return {...response,data:{...data,goal:{id:g.id,status:g.status,reason:g.reason||null,home:g.home,pending:g.pending,receipt:g.receipt,errors:g.errors,scanTruncated:g.scanTruncated,progress:g.progress,suggestions:g.suggestions}}}
}
async function main(){
  const [op='status',...rest]=process.argv.slice(2)
  if(['--help','help','-h'].includes(op)){console.log(help);return}
  if(!['preview','run','start','status','resume','cancel','configure','schema'].includes(op))throw new Error(help)
  const raw=rest.find(s=>!s.startsWith('--'))||'{}',args=JSON.parse(raw)
  const detail=rest.includes('--detail'),timeout=Number(rest.find(s=>s.startsWith('--timeout='))?.slice(10)||300)
  if(!Number.isFinite(timeout)||timeout<1||timeout>3600)throw new Error('timeout_must_be_1_to_3600_seconds')
  for(const flag of rest.filter(s=>s.startsWith('--')))if(flag!=='--detail'&&!flag.startsWith('--timeout='))throw new Error('unknown_flag:'+flag)
  const call=payload=>request(payload,{sock:process.env.MCBOT_SOCK||path.join(root,'.mcbot.sock'),timeoutMs:20000})
  const status=()=>call({op:'tool.dry',tool:'observe_detail',args:{what:'stash'}})
  let result
  if(op==='schema'){result=await status();if(result.data)result={ok:result.ok,schemas:result.data.schemas}}
  else if(op==='status')result=await status()
  else if(op==='preview')result=await call({op:'tool.dry',tool:'observe_detail',args:{what:'stash',preview:true,...args}})
  else result=await call({op:'tool.run',tool:'stash_goal',args:{op:op==='run'?'start':op,args}})
  if(['run','resume'].includes(op)&&result.ok){
    const goalId=result.data.id,until=Date.now()+timeout*1000
    do{
      result=await status()
      if(!result.ok||result.data?.goal?.id!==goalId)throw new Error('goal_replaced_or_status_unavailable')
      if(result.data.goal.status!=='running'&&!result.data.busy)break
      if(Date.now()>=until){result.waitTimeout=true;process.exitCode=4;break}
      await new Promise(r=>setTimeout(r,1000))
    }while(true)
  }
  console.log(JSON.stringify(compact(result,detail),null,2))
  if(!result.ok)process.exitCode=1
  else if(!process.exitCode&&['run','resume'].includes(op))process.exitCode=result.data.goal.status==='succeeded'?0:result.data.goal.status==='partial'?2:3
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1})
