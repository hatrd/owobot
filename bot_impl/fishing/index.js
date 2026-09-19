const path=require('path')
const {randomUUID}=require('crypto')
const {decide,distance,night}=require('./policy')
const {schemas,validate}=require('./contract')
function install(bot,{state,on,registerCleanup,log}){
  const worldId=state.explorationMemory?.worldId
  if(!worldId)throw new Error('fishing_requires_world_identity')
  const store=require('./store').createStore(state,worldId,path.resolve('data',`fishing-${worldId}.json`))
  const driver=require('./driver').createDriver(bot,state)
  const runtime=state.fishing.runtime={phase:'waiting',operation:null,auth:null,renewAt:0,damageAt:store.get().lastDamageAt||0,lastHealth:bot.health,nextAt:Date.now()+3000,disposed:false,failures:0}
  function event(type,data={}){store.save(d=>{d.events.push({at:Date.now(),type,...data})});log?.event?.('fishing', {type,...data})}
  function release(){if(runtime.auth)state.controllerApi?.write('session.release',runtime.auth);runtime.auth=null}
  function status(){const doc=store.get();return {ok:!store.error(),error:store.error(),data:{...doc,schemas,phase:runtime.phase,operation:runtime.operation?.kind||null,journey:runtime.journey||null,facts:driver.facts(),preview:doc.home?decide(doc,{...driver.facts(),damageAt:runtime.damageAt},Date.now()):null}}}
  function stop(reason='canceled',status='paused'){
    driver.stop(runtime.operation?.token)
    if(store.get().status==='running'||(status==='canceled'&&['blocked','paused'].includes(store.get().status)))store.save(d=>{d.status=status;d.reason=reason;d.events.push({at:Date.now(),type:reason})})
    // Keep ownership until outstanding asynchronous operations have acknowledged cancellation.
    if(!runtime.operation)release()
    return {ok:true,data:{status:store.get().status,reason}}
  }
  function configure(op,args={}){
    const v=validate(op,args);if(!v.ok)return v
    if(op==='cancel')return stop('user_canceled','canceled')
    if(runtime.operation||store.get().status==='running')return {ok:false,error:'fishing_already_running'}
    if(store.error())return {ok:false,error:store.error()}
    const f=driver.facts()
    if(!f.ready)return {ok:false,error:'not_spawned'}
    if(op==='resume'&&!['paused','blocked'].includes(store.get().status))return {ok:false,error:'no_resumable_fishing_goal'}
    if(state.controller?.lease)return {ok:false,error:'controller_busy'}
    if(!['overworld','minecraft:overworld'].includes(f.dimension))return {ok:false,error:'overworld_required'}
    state.lifeApi?.yield('fishing_goal')
    const acquired=state.controllerApi?.write('session.acquire',{controllerId:'fishing-goal',ttlMs:60000})
    if(!acquired?.ok)return acquired||{ok:false,error:'controller_unavailable'}
    runtime.auth={leaseId:acquired.leaseId,epoch:acquired.epoch}
    try{
      if(op==='start')store.save(d=>Object.assign(d,{id:randomUUID(),status:'running',reason:null,home:{...(args.home||f.position),dimension:f.dimension},radius:args.radius||128,count:args.count||8,caught:0,stats:{casts:0,sleeps:0,damage:0,storageChecks:0},failure:null,receipt:null,finishedAt:null,lastDamageAt:runtime.damageAt,baseline:f.fish,spot:null,checkedStorage:[],startedAt:Date.now(),events:[],recoveredAt:0}))
      else store.save(d=>{d.status='running';d.reason=null;d.failure=null;if(args.radius)d.radius=args.radius})
      const saved=state.knowledgeApi.write('knowledge.put',{id:'task:fishing-inventory',kind:'task',subject:'fishing-goal',fact:'Keep raw cod and salmon for cats; reserve rod and ingredients during fishing.',source:'fishing_goal',confidence:'observed',inventoryHold:['cod','salmon','fishing_rod','string','stick']})
      if(!saved.ok)throw new Error(saved.error)
      runtime.nextAt=Date.now()+1000;runtime.failures=0
      event(op,{goalId:store.get().id})
      return {ok:true,data:{id:store.get().id,status:'running',count:store.get().count,home:store.get().home}}
    }catch(e){stop(e.message,'blocked');release();return {ok:false,error:e.message}}
  }
  async function execute(kind,token){
    const doc=store.get()
    if(['retreat','return_for_sleep','return_complete','return_failed'].includes(kind)){await driver.go(doc.home,token,doc,.8);return {home:true}}
    if(kind==='recover'){
      await driver.wait(1500,token)
      const f=driver.facts()
      if(f.health>=18&&f.hostiles===0&&!f.inWater&&Date.now()-runtime.damageAt>=15000)store.save(d=>{d.recoveredAt=Date.now()})
      return {health:f.health}
    }
    if(kind==='eat'){await driver.wait(1000,token);return {food:driver.facts().food}}
    if(kind==='sleep')return driver.sleep(doc,token)
    if(kind==='prepare')return driver.prepare(doc,token)
    if(kind==='choose_spot')return {spot:await driver.chooseSpot(doc,token)}
    if(kind==='travel'){await driver.go(doc.spot.stand,token,doc,.5);return {arrived:true}}
    if(kind==='cast')return driver.cast(doc,token)
    if(kind==='report_failed'){stop(doc.failure.error,'blocked');return {blocked:true}}
    if(kind==='verify'){
      const f=driver.facts()
      if(f.fish-doc.baseline<doc.count)throw new Error('catch_inventory_missing')
      if(distance(f.position,doc.home)>1.5||f.health<18)throw new Error('home_verification_failed')
      store.save(d=>{d.status='succeeded';d.finishedAt=Date.now();d.receipt={caught:d.caught,retainedRaw:f.fish-d.baseline,position:f.position,health:f.health,food:f.food};d.events.push({at:Date.now(),type:'complete',...d.receipt})})
      return {complete:true}
    }
    if(['wrong_dimension','dead'].includes(kind))throw new Error(kind)
    await driver.wait(1000,token);return {waiting:true}
  }
  function tick(){
    if(runtime.disposed||store.get().status!=='running')return
    if(!runtime.auth){
      // Restart/reload continues the durable goal only after resources are free.
      const a=state.controllerApi?.write('session.acquire',{controllerId:'fishing-goal',ttlMs:60000})
      if(!a?.ok)return
      runtime.auth={leaseId:a.leaseId,epoch:a.epoch}
    }
    if(Date.now()>=runtime.renewAt){
      const renewed=state.controllerApi?.write('session.renew',{...runtime.auth,ttlMs:60000})
      if(!renewed?.ok){stop('control_lost');return}
      runtime.renewAt=Date.now()+20000
    }
    if(state.controller?.lease?.id!==runtime.auth.leaseId){stop('control_lost');return}
    const f={...driver.facts(),damageAt:runtime.damageAt},doc=store.get()
    if(state.surfaceTravel?.phase==='moving')f.inWater=false
    const kind=decide(doc,f,Date.now())
    if(runtime.operation){
      const urgent=['retreat','recover','return_for_sleep','sleep','wrong_dimension','dead','eat'].includes(kind)
      if(urgent&&runtime.operation.kind!==kind&&!['recover','eat'].includes(runtime.operation.kind))driver.stop(runtime.operation.token)
      return
    }
    if(Date.now()<runtime.nextAt)return
    runtime.phase=kind
    const operation={kind,token:{canceled:false}}
    runtime.operation=operation
    if(!['recover','eat','wait_connection'].includes(kind))event('action',{kind})
    execute(kind,operation.token).then(result=>{
      if(runtime.disposed||operation.token.canceled||store.get().status!=='running')return
      store.save(d=>{
        d.stats ||= {casts:0,sleeps:0,damage:0,storageChecks:0}
        if(kind==='cast')d.stats.casts++
        if(result.slept)d.stats.sleeps++
        if(result.checked)d.stats.storageChecks++
        if(result.spot)d.spot=result.spot
        if(result.checked)d.checkedStorage=[...(d.checkedStorage||[]),result.checked,...(result.paired||[])].slice(-512)
        if(result.caught)d.caught+=result.caught
        d.events.push({at:Date.now(),type:'result',kind,result})
      })
      runtime.failures=0
    }).catch(error=>{
      if(runtime.disposed||store.get().status!=='running')return
      if(operation.token.canceled){event('interrupted',{kind});return}
      runtime.failures++
      event('failure',{kind,error:error.message,detail:error.detail||null})
      // Retry transient casts/sleep a bounded number of times. No blind replay of storage mutations.
      if(['cast','sleep'].includes(kind)&&runtime.failures<3){runtime.nextAt=Date.now()+5000;return}
      if(kind==='return_failed' || ['wrong_dimension','dead'].includes(kind) || distance(driver.facts().position,store.get().home)<=1.5)stop(error.message,'blocked')
      else store.save(d=>{d.failure={error:error.message,detail:error.detail||null};d.spot=null})
    }).finally(()=>{
      if(runtime.operation===operation)runtime.operation=null
      if(store.get().status!=='running'||runtime.disposed)release()
      else runtime.nextAt=Math.max(runtime.nextAt,Date.now()+500)
    })
  }
  function markDamage(source,before,after){
    const at=Date.now(),fresh=at-runtime.damageAt>250
    runtime.damageAt=at
    if(store.get().status!=='running')return
    store.save(d=>{d.lastDamageAt=at;d.stats ||= {casts:0,sleeps:0,damage:0,storageChecks:0};if(fresh)d.stats.damage++;d.events.push({at,type:'damage',source,before:before??null,after:after??null})})
    driver.stop(runtime.operation?.token)
  }
  on('health',()=>{const h=bot.health;if(Number.isFinite(runtime.lastHealth)&&h<runtime.lastHealth)markDamage('health',runtime.lastHealth,h);runtime.lastHealth=h})
  on('entityHurt',entity=>{if(entity?.id===bot.entity?.id)markDamage('entityHurt',null,bot.health)})
  on('death',()=>stop('death','blocked'))
  on('end',()=>stop('connection_ended'))
  on('agent:stop_all',()=>stop('emergency_stop','canceled'))
  const api={configure,status,stop};state.fishingApi=api
  const timer=setInterval(()=>{try{tick()}catch(e){log?.error?.('fishing tick failed',e.message);try{stop(e.message,'blocked')}catch{driver.stop(runtime.operation?.token);release()}}},500)
  timer.unref?.()
  registerCleanup(()=>{clearInterval(timer);runtime.disposed=true;driver.stop(runtime.operation?.token);if(!runtime.operation)release();if(state.fishingApi===api)state.fishingApi=null})
  return api
}
function read(bot,args={}){
  const r=bot.state?.fishingApi?.status()||{ok:false,error:'fishing_unavailable'}
  if(r.data&&!args.full){
    const d=r.data
    d.checkedStorageCount=d.checkedStorage?.length||0;delete d.checkedStorage
    d.events=d.events.slice(-12)
    if(d.journey)d.journey={target:d.journey.target,index:d.journey.index,total:d.journey.actions.length,next:d.journey.actions[d.journey.index]||null}
  }
  return {...r,msg:r.ok?'Durable fishing goal, facts and decision preview':r.error}
}
module.exports={install,read}
