const path=require('path'),{randomUUID}=require('crypto')
const {schemas,validate}=require('./contract')
const {key,distance,partition,plan,reconcile,special,suggestions}=require('./policy')
const {discover,labelsFor,open,snapshot,inventory,count,point}=require('./containers')
function install(bot,{state,on,registerCleanup,log}){
  const worldId=state.explorationMemory?.worldId
  if(!worldId)throw new Error('stash_requires_world_identity')
  const previous=state.stash?.runtime
  const store=require('./store').createStore(state,worldId,path.resolve('data',`stash-${worldId}.json`))
  const runtime=state.stash.runtime={phase:'idle',auth:null,operation:null,disposed:false,journey:null,lastHealth:bot.health,damaged:false,renewAt:0}
  const travel=require('../navigation/travel').createTravel(bot,state,runtime)
  // An old async deposit may still be settling during hot reload. It owns its
  // lease until done; never start another operation over that window.
  if(!store.error()&&store.get().goal?.status==='running')store.save(d=>{d.goal.status='paused';d.goal.reason='runtime_reloaded'})
  function config(){const d=store.get();return d.storageDimension&&d.storageDimension!==String(bot.game.dimension)?{...d.config,routes:[],overflow:null}:d.config}
  const cargo=()=>partition(bot.inventory.items(),bot.registry,state,config())
  function preview(args={}){
    if(!bot.entity?.position)return {ok:false,error:'not_spawned'}
    const home=point(bot.entity.position),radius=Math.max(4,Math.min(64,args.radius||store.get().goal?.radius||config().radius))
    const discovery=discover(bot,home,radius),policy=cargo()
    const catalog=store.get().catalog.filter(c=>c.dimension===String(bot.game.dimension)&&discovery.containers.some(d=>d.id===c.id))
    return {ok:!store.error(),error:store.error(),data:{policy:config(),...policy,candidates:discovery.containers,truncated:discovery.truncated,catalog:catalog.map(c=>({...c,slots:undefined,contents:c.slots?.filter(Boolean).map(i=>({item:i.name,count:i.count})),emptySlots:c.slots?.filter(i=>!i).length})),cachedPlan:plan(policy.cargo,catalog,config()),suggestions:suggestions(policy.cargo,catalog,config()),note:'Read-only discovery. Cached contents are dated evidence; start reopens containers before planning and each transfer.'}}
  }
  function status(){
    const g=store.get().goal
    return {ok:!store.error(),error:store.error(),data:{worldId,schemas,config:config(),storageDimension:store.get().storageDimension,goal:g,phase:runtime.phase,busy:!!runtime.operation,journey:runtime.journey?{target:runtime.journey.target,index:runtime.journey.index,total:runtime.journey.actions.length}:null,facts:{position:bot.entity?.position&&point(bot.entity.position),health:bot.health,food:bot.food,freeSlots:bot.inventory.emptySlotCount()},next:g?.pending?'resume_to_reconcile':g&&['paused','blocked'].includes(g.status)?'resume':null}}
  }
  function saveGoal(edit){return store.save(d=>edit(d.goal))}
  function release(){if(runtime.auth)state.controllerApi?.write('session.release',runtime.auth);runtime.auth=null}
  function check(t){if(t.canceled||runtime.disposed)throw new Error('canceled');if(String(bot.game?.dimension)!==store.get().goal.dimension)throw new Error('dimension_changed');if(bot.health<=0)throw new Error('dead')}
  function stop(reason='user_canceled',status='canceled'){
    if(runtime.operation){runtime.operation.token.canceled=true;travel.stop(reason);if(bot.currentWindow)bot.closeWindow(bot.currentWindow)}
    const g=store.get().goal
    if(g&&!store.error()&&(['running','paused','blocked'].includes(g.status))){try{saveGoal(d=>{d.status=status;d.reason=reason})}catch(e){log?.error?.('stash journal failed',e.message)}}
    if(!runtime.operation)release()
    return {ok:true,data:{status:store.get().goal?.status||'idle',settling:!!runtime.operation}}
  }
  async function visit(c,t){check(t);runtime.phase='travel';await travel.go(c.position,t,store.get().goal,3);check(t);runtime.phase='opening';return open(bot,c.position,t)}
  function remember(c){store.save(d=>{const dimension=String(bot.game.dimension);d.catalog=d.catalog.filter(x=>x.id!==c.id||x.dimension!==dimension);d.catalog.push({...c,dimension});d.catalog=d.catalog.slice(-128)})}
  async function reconcilePending(t){
    const intent=store.get().goal.pending
    if(!intent)return
    let w
    try{
      w=await visit({position:intent.position},t);check(t)
      const result=reconcile(intent,count(inventory(w),intent.item),count(w.containerItems(),intent.item))
      if(!result.ok)throw Object.assign(new Error(result.error),{detail:result})
      saveGoal(g=>{g.receipts.push({...g.pending,moved:result.moved,reconciled:true,at:Date.now()});g.pending=null})
    }finally{w?.close()}
  }
  async function deposit(transfer,t,c){
    let w
    try{
      w=await visit(c,t);check(t)
      const current=snapshot(w,{...c,labels:labelsFor(bot,c)}),policy=partition(inventory(w),bot.registry,state,config())
      const candidate=policy.cargo.find(i=>i.item===transfer.item)
      if(!candidate){remember(current);return}
      // Recompute both reservations and capacity at the mutation boundary.
      const fresh=plan([{...candidate,count:Math.min(candidate.count,transfer.count)}],[current],config()).transfers[0]
      if(!fresh){remember(current);return}
      const item=inventory(w).find(i=>i.name===fresh.item)
      if(!item||inventory(w).some(i=>i.name===fresh.item&&special(i)))throw new Error('item_variant_changed')
      const intent={...fresh,id:randomUUID(),sourceBefore:count(inventory(w),fresh.item),destinationBefore:count(w.containerItems(),fresh.item),at:Date.now()}
      saveGoal(g=>{g.pending=intent}) // fsync BEFORE inventory mutation.
      runtime.phase='deposit'
      let error=null
      try{await w.deposit(item.type,item.metadata,fresh.count)}catch(e){error=e.message}
      const result=reconcile(intent,count(inventory(w),fresh.item),count(w.containerItems(),fresh.item))
      if(!result.ok)throw Object.assign(new Error(result.error),{detail:result})
      // Even cancellation may have transferred some items: settle and persist the
      // actual delta before checking cancellation or releasing ownership.
      saveGoal(g=>{g.receipts.push({...intent,moved:result.moved,error,at:Date.now()});g.pending=null})
      remember(snapshot(w,{...c,labels:labelsFor(bot,c)}));check(t)
      if(error||result.moved!==fresh.count)throw Object.assign(new Error('transfer_incomplete'),{detail:{error,requested:fresh.count,moved:result.moved}})
    }finally{w?.close()}
  }
  async function execute(t){
    const goal=store.get().goal
    let failure=null
    try{
      if(bot.health<18||bot.food<12)throw new Error('unsafe_vitals')
      await reconcilePending(t)
      runtime.phase='discover'
      const discovery=discover(bot,goal.home,goal.radius)
      saveGoal(g=>{g.scanTruncated=discovery.truncated;g.errors=[]})
      // Reopen everything used by this run. The durable catalog is never treated
      // as authoritative capacity, and no storage is shuffled or withdrawn.
      const observed=[],cfg=config(),wanted=new Set(cargo().cargo.map(i=>i.item))
      const explicit=(cfg.routes||[]).filter(r=>wanted.has(r.item)).map(r=>r.position)
      const priority=c=>explicit.some(p=>c.positions.some(q=>key(q)===key(p)))?0:c.labels.some(i=>wanted.has(i))?1:store.get().catalog.some(x=>x.dimension===goal.dimension&&x.id===c.id&&x.slots?.some(i=>i&&wanted.has(i.name)))?2:cfg.overflow&&c.positions.some(p=>key(p)===key(cfg.overflow))?3:4
      const ordered=discovery.containers.sort((a,b)=>priority(a)-priority(b)||a.distance-b.distance)
      for(const c of ordered){
        check(t)
        if(!cargo().cargo.length)break
        let w
        try{w=await visit(c,t);check(t);const fresh=snapshot(w,{...c,labels:labelsFor(bot,c)});observed.push(fresh);remember(fresh)}
        catch(e){check(t);saveGoal(g=>g.errors.push({position:c.position,error:e.message,detail:e.detail||null}));remember({...c,error:e.message,observedAt:Date.now()})}
        finally{w?.close()}
        saveGoal(g=>{g.progress={scanned:observed.length,candidates:ordered.length}})
        if(!plan(cargo().cargo,observed,cfg).remaining.length)break
      }
      const planned=plan(cargo().cargo,observed,config())
      saveGoal(g=>{g.plan=planned})
      for(const transfer of planned.transfers){check(t);await deposit(transfer,t,observed.find(c=>c.id===transfer.container))}
    }catch(e){failure={error:e.message,detail:e.detail||null}}
    if(runtime.disposed)return
    // Explicit cancel stops at once; damage cancels current action, then attempts
    // a bounded safe return under the same lease. No digging/placing/dropping.
    if(store.get().goal.status!=='running'||(t.canceled&&!runtime.damaged))return
    if(runtime.damaged)failure={error:'damage_interrupted'}
    if(bot.health>0&&String(bot.game?.dimension)===goal.dimension){
      runtime.phase='return'
      t.canceled=false
      try{await travel.go(goal.home,t,goal,.8);check(t)}
      catch(e){failure={error:'return_failed',detail:{cause:e.message,prior:failure}}}
    }else failure ||= {error:'cannot_return'}
    if(runtime.disposed)return
    if(t.canceled){if(store.get().goal.status==='running')saveGoal(g=>{g.status='blocked';g.reason='return_interrupted';g.failure=failure});return}
    const policy=cargo(),returned=distance(bot.entity.position,goal.home)<=1.5
    saveGoal(g=>{
      g.status=failure||g.pending||!returned?'blocked':policy.cargo.length?'partial':'succeeded'
      g.reason=failure?.error||(policy.cargo.length?'cargo_remaining':null)
      g.failure=failure;g.finishedAt=Date.now()
      const catalog=store.get().catalog.filter(c=>c.dimension===g.dimension&&(g.plan?.transfers.some(t=>t.container===c.id)||discoverIds.has(c.id)))
      g.suggestions=suggestions(policy.cargo,catalog,config())
      g.receipt={durationMs:Date.now()-g.startedAt,moved:g.receipts.reduce((n,r)=>n+r.moved,0),transfers:g.receipts.length,kept:policy.kept,remaining:plan(policy.cargo,catalog,config()).remaining,unresolvedCargo:policy.cargo.map(({item,count})=>({item,count})),returned,position:point(bot.entity.position),health:bot.health,food:bot.food,freeSlots:bot.inventory.emptySlotCount()}
    })
  }
  // Ids restrict final diagnostics to this mission's search boundary.
  let discoverIds=new Set()
  function launch(){
    const g=store.get().goal
    discoverIds=new Set(discover(bot,g.home,g.radius).containers.map(c=>c.id))
    runtime.damaged=false
    const operation={token:{canceled:false}};runtime.operation=operation
    operation.promise=execute(operation.token).catch(e=>{
      log?.error?.('stash failed',e.message)
      if(!runtime.disposed){try{saveGoal(g=>{g.status='blocked';g.reason=e.message})}catch{}}
    }).finally(()=>{if(runtime.operation===operation)runtime.operation=null;runtime.phase='idle';release()})
  }
  function configure(op,args={}){
    const v=validate(op,args);if(!v.ok)return v
    if(op==='cancel')return stop()
    if(store.error())return {ok:false,error:store.error()}
    const doc=store.get(),g=doc.goal
    if(op==='start'&&args.requestId&&g?.requestId===args.requestId)return {ok:true,data:{id:g.id,status:g.status,duplicate:true}}
    if(runtime.operation||previous?.operation)return {ok:false,error:'stash_busy'}
    if(op==='configure'){
      const names=[...Object.keys(args.keep||{}),...(args.routes||[]).map(r=>r.item)]
      const unknown=names.filter(n=>!bot.registry.itemsByName[n]);if(unknown.length)return {ok:false,error:'unknown_items',items:unknown}
      if(g?.pending)return {ok:false,error:'pending_transfer_requires_resume'}
      store.save(d=>{
        if('routes' in args||'overflow' in args){
          if(d.storageDimension&&d.storageDimension!==String(bot.game.dimension)){d.config.routes=[];d.config.overflow=null}
          d.storageDimension=String(bot.game.dimension)
        }
        d.config={...d.config,...args}
      })
      return {ok:true,data:{config:store.get().config}}
    }
    if(!state.hasSpawned||!bot.entity?.position)return {ok:false,error:'not_spawned'}
    if(op==='start'&&g?.pending)return {ok:false,error:'pending_transfer_requires_resume'}
    if(op==='resume'&&(!g||!['paused','blocked','partial','canceled'].includes(g.status)))return {ok:false,error:'no_resumable_stash_goal'}
    if(op==='resume'&&g.dimension!==String(bot.game.dimension))return {ok:false,error:'dimension_changed'}
    if(state.controller?.lease)return {ok:false,error:'controller_busy'}
    state.lifeApi?.yield('stash_goal')
    const a=state.controllerApi?.write('session.acquire',{controllerId:'stash-goal',ttlMs:60000})
    if(!a?.ok)return a||{ok:false,error:'controller_unavailable'}
    runtime.auth={leaseId:a.leaseId,epoch:a.epoch}
    try{
      if(op==='start')store.save(d=>{d.goal={id:randomUUID(),requestId:args.requestId||null,status:'running',home:point(bot.entity.position),dimension:String(bot.game.dimension),radius:args.radius||d.config.radius,startedAt:Date.now(),receipts:[],pending:null,errors:[],receipt:null}})
      else saveGoal(d=>{d.status='running';d.reason=null;d.receipt=null})
      launch()
      return {ok:true,data:{id:store.get().goal.id,status:'running'}}
    }catch(e){if(!store.error()&&store.get().goal?.status==='running')saveGoal(g=>{g.status='blocked';g.reason=e.message});release();return {ok:false,error:e.message}}
  }
  function damaged(){if(!runtime.operation)return;runtime.damaged=true;runtime.operation.token.canceled=true;travel.stop('damage');if(bot.currentWindow)bot.closeWindow(bot.currentWindow)}
  on('health',()=>{if(bot.health<runtime.lastHealth)damaged();runtime.lastHealth=bot.health})
  on('entityHurt',e=>{if(e?.id===bot.entity?.id)damaged()})
  on('death',()=>stop('death','blocked'));on('end',()=>stop('connection_ended','paused'));on('agent:stop_all',()=>stop('emergency_stop'))
  const timer=setInterval(()=>{
    if(!runtime.auth)return
    if(state.controller?.lease?.id!==runtime.auth.leaseId){stop('control_lost','paused');return}
    if(Date.now()<runtime.renewAt)return
    const r=state.controllerApi?.write('session.renew',{...runtime.auth,ttlMs:60000})
    if(!r?.ok)stop('control_lost','paused');else runtime.renewAt=Date.now()+20000
  },500);timer.unref?.()
  const api={configure,status,preview,stop};state.stashApi=api
  registerCleanup(()=>{clearInterval(timer);runtime.disposed=true;stop('runtime_reloaded','paused');if(state.stashApi===api)state.stashApi=null})
  return api
}
function read(bot,args={}){const api=bot.state?.stashApi;const r=api?(args.preview?api.preview(args):api.status()):{ok:false,error:'stash_unavailable'};return {...r,msg:r.ok?'Loot policy, durable goal and verified receipts':r.error}}
module.exports={install,read}
