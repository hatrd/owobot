#!/usr/bin/env node
// Model-neutral one-action tasks, with leases, cancellation and terminal receipts.
const { call } = require('./controller-client')
const { randomUUID } = require('crypto')
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms))
const checked = r => { if(!r?.ok) throw Object.assign(new Error(r?.error || r?.msg || 'request_failed'),{result:r}); return r }
async function session (owner='external-agent') {
  const lease=checked(await call('session.acquire',{controllerId:owner,ttlMs:60000}))
  const auth={leaseId:lease.leaseId,epoch:lease.epoch}
  let renewalError=null
  const timer=setInterval(()=>call('session.renew',{...auth,ttlMs:60000}).then(checked).catch(e=>{renewalError=e}),20000)
  timer.unref()
  const api={
    async write(op,args){if(renewalError)throw renewalError;return checked(await call(op,{...auth,...args}))},
    async action(action,args,timeoutMs=30000){
      const behavior=makeBehavior(action,args,timeoutMs)
      checked(await call('behavior.validate',{behavior}))
      await api.write('behavior.install',{behavior})
      try{
        const started=await api.write('task.start',{requestId:randomUUID(),behaviorId:behavior.id,revision:behavior.revision,timeoutMs:Math.min(300000,timeoutMs+2000)})
        const deadline=Date.now()+timeoutMs+5000
        while(Date.now()<deadline){
          if(renewalError)throw renewalError
          const status=checked(await call('status',{taskId:started.taskId}))
          const task=status.tasks[0]
          if(['succeeded','failed','canceled'].includes(task.status))return {ok:task.status==='succeeded',task}
          await wait(150)
        }
        await api.write('task.cancel',{taskId:started.taskId})
        throw new Error('task_poll_timeout')
      }finally{await api.write('behavior.remove',{behaviorId:behavior.id,revision:behavior.revision}).catch(()=>{})}
    },
    async close(){clearInterval(timer);return call('session.release',auth)}
  }
  return api
}
function makeBehavior(action,args,timeoutMs){return {id:`action-${randomUUID()}`,revision:'1',entry:'action',nodes:{action:{type:'action',action,args,timeoutMs,next:'done'},done:{type:'end'}}}}
async function main(){
  const [action,raw='{}',...flags]=process.argv.slice(2)
  if(action==='schema'){console.log(JSON.stringify(await call('schema'),null,2));return}
  const args=JSON.parse(raw)
  const timeoutMs=Number(flags.find(f=>f.startsWith('--timeout-ms='))?.split('=')[1] || 30000)
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>298000)throw new Error('invalid_timeout')
  if(flags.includes('--dry')){console.log(JSON.stringify(await call('behavior.validate',{behavior:makeBehavior(action,args,timeoutMs)}),null,2));return}
  const s=await session('codex-cli')
  const stop=()=>s.close().finally(()=>process.exit(130))
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try{const result=await s.action(action,args,timeoutMs);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1}
  finally{await s.close();process.off('SIGINT',stop);process.off('SIGTERM',stop)}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,detail:e.result}));process.exitCode=1})
module.exports={session,makeBehavior,checked,wait}
