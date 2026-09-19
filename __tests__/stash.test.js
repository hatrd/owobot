const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {partition,plan,reconcile}=require('../bot_impl/stash/policy')
const {createStore}=require('../bot_impl/stash/store')
const {validate}=require('../bot_impl/stash/contract')
const p={x:0,y:64,z:0},config={keep:{},foodReserve:64,routes:[],overflow:null,radius:16}
const item=(name,count=1,extra={})=>({name,count,type:1,metadata:0,stackSize:64,...extra})
const slot=(name,count=1)=>({...item(name,count),special:false})
const cargo=(name,count=1)=>({item:name,count,type:1,metadata:0,stackSize:64})
const container=(slots,extra={})=>({id:'0,64,0',position:p,positions:[p],labels:[],distance:0,slots,...extra})
test('stash preserves durable holds, name-sharing custom variants, equipment and food; explicit keep applies',()=>{
 const items=[item('diamond',64),item('cod',11),item('ore',10),item('ore',1,{components:[{type:'custom_name'}]}),item('pick',1,{maxDurability:500}),item('box',1,{stackSize:1}),item('food',100),item('stone',50)]
 const state={knowledge:{document:{records:[{kind:'task',confidence:'observed',inventoryHold:['diamond','cod']}]}}}
 const result=partition(items,{foodsByName:{food:{}}},state,{...config,keep:{stone:20}})
 assert.deepEqual(result.cargo.map(({item,count})=>({item,count})),[{item:'food',count:36},{item:'stone',count:30}])
 assert.equal(result.kept.find(i=>i.item==='ore').count,11)
 assert.equal(partition(items,{}, {knowledge:{error:'corrupt'}},config).cargo.length,0)
})
test('planner uses shared capacity across cargo kinds; never silently treats empty chest as overflow',()=>{
 const c=container([slot('stone',60),null])
 const result=plan([cargo('stone',10),cargo('ore',64)],[c],{...config,overflow:p})
 assert.deepEqual(result.transfers.map(i=>[i.item,i.count]),[['stone',10],['ore',0]].filter(i=>i[1]))
 assert.deepEqual(result.remaining,[{item:'ore',count:64,reason:'capacity_exhausted'}])
 assert.equal(plan([cargo('ore')],[container([null])],config).transfers.length,0)
 assert.equal(c.slots[0].count,60)
})
test('explicit routes precede frames; labels prevent contamination; capacity splits across containers',()=>{
 const q={x:2,y:64,z:0},a=container([null],{labels:['ore']}),b=container([slot('ore',63)],{id:'2,64,0',position:q,positions:[q],distance:2})
 assert.equal(plan([cargo('stone')],[a],{...config,overflow:p}).transfers.length,0)
 assert.equal(plan([cargo('ore')],[a,b],{...config,routes:[{item:'ore',position:q}]}).transfers[0].position.x,2)
 const r=plan([cargo('ore',66)],[a,b],config)
 assert.deepEqual(r.transfers.map(t=>t.count),[64,1]);assert.equal(r.remaining[0].count,1)
})
test('a route to either half of a double chest consumes its capacity once',()=>{
 const q={x:1,y:64,z:0}
 const r=plan([cargo('ore',65)],[container([null],{positions:[p,q]})],{...config,routes:[{item:'ore',position:q}]})
 assert.equal(r.transfers[0].count,64);assert.equal(r.remaining[0].count,1)
})
test('two-sided interrupted transfers recognize zero/partial/full and reject ambiguous concurrent changes',()=>{
 const intent={sourceBefore:30,destinationBefore:10,count:20}
 assert.deepEqual(reconcile(intent,30,10),{ok:true,moved:0})
 assert.deepEqual(reconcile(intent,25,15),{ok:true,moved:5})
 assert.deepEqual(reconcile(intent,10,30),{ok:true,moved:20})
 assert.equal(reconcile(intent,10,31).ok,false);assert.equal(reconcile(intent,0,40).ok,false)
})
test('stash contract rejects invalid coordinates/counts/operations',()=>{
 assert.ok(validate('configure',{overflow:p,keep:{stone:32}}).ok)
 for(const [op,args] of [['configure',{keep:{stone:-1}}],['start',{radius:300}],['configure',{overflow:{...p,x:.5}}],['resume',{radius:8}],['cook',{}]])assert.equal(validate(op,args).ok,false)
})
test('journal preserves pending mutation and config across fresh state, corruption and world mismatch fail closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stash-test-')),file=path.join(dir,'state.json')
 try{
  const s=createStore({},'world',file)
  s.save(d=>{d.goal={status:'paused',home:p,receipts:[],pending:{item:'ore',count:10}};d.config.overflow=p})
  const fresh=createStore({},'world',file)
  assert.equal(fresh.get().goal.pending.count,10);assert.deepEqual(fresh.get().config.overflow,p)
  assert.ok(createStore({},'other',file).error())
  fs.writeFileSync(file,'corrupt');const bad=createStore({},'world',file);assert.ok(bad.error());assert.throws(()=>bad.save(()=>{}))
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
async function fixture(t,{deposit,slots=[null],carried=[item('ore',12)]}={}){
 const {EventEmitter}=require('events'),{Vec3}=require('vec3')
 const bot=new EventEmitter(),state={hasSpawned:true,explorationMemory:{worldId:'test-stash-'+require('crypto').randomUUID()},controller:{},knowledge:{document:{records:[]}}}
 bot.state=state;bot.entity={id:1,position:new Vec3(0,64,0)};bot.game={dimension:'overworld'};bot.health=20;bot.food=20
 bot.registry={blocksArray:[{id:1,name:'barrel'}],itemsByName:{ore:{id:1}},foodsByName:{}}
 bot.inventory={items:()=>carried,emptySlotCount:()=>36-carried.length}
 bot.findBlocks=()=>[new Vec3(2,64,0)]
 bot.blockAt=position=>({name:'barrel',position,getProperties:()=>({})})
 const cleanups=[];let traveling=0
 t.mock.method(require('../bot_impl/frame-sorter'),'scanFrames',()=>({framedChests:[]}))
 t.mock.method(require('../bot_impl/navigation/travel'),'createTravel',()=>({go:async(target)=>{traveling++;bot.entity.position=new Vec3(target.x,target.y,target.z)},stop(){}}))
 bot.closeWindow=w=>w.close()
 bot.openContainer=async()=>{
  const w={inventoryStart:slots.length,inventoryEnd:slots.length+36,get slots(){return [...slots,...carried,...Array(36-carried.length).fill(null)]},containerItems:()=>slots.filter(Boolean),close(){if(bot.currentWindow===w)bot.currentWindow=null},deposit:async(type,metadata,n)=>{
   const move=()=>{const i=carried.find(i=>i.type===type);i.count-=n;carried=carried.filter(i=>i.count);if(slots[0])slots[0].count+=n;else slots[0]=item('ore',n)}
   if(deposit)await deposit(move);else move()
  }};bot.currentWindow=w;return w
 }
 state.controllerApi={write(op){if(op==='session.acquire'){state.controller.lease={id:'lease'};return {ok:true,leaseId:'lease',epoch:1}}if(op==='session.release')state.controller.lease=null;return {ok:true}}}
 const context={state,on:(e,f)=>{bot.on(e,f);cleanups.push(()=>bot.off(e,f))},registerCleanup:f=>cleanups.push(f)}
 const api=require('../bot_impl/stash').install(bot,context)
 t.after(()=>{for(const f of cleanups.reverse())f();fs.rmSync(path.resolve('data',`stash-${state.explorationMemory.worldId}.json`),{force:true})})
 const settle=async()=>{for(let i=0;i<100&&api.status().data.busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(api.status().data.busy,false)}
 return {api,bot,state,settle,carried:()=>carried,traveling:()=>traveling,reload(){for(const f of cleanups.splice(0).reverse())f();return require('../bot_impl/stash').install(bot,context)}}
}
test('live runtime plans, confirms both deltas, returns home; duplicate request is a no-op',async t=>{
 const f=await fixture(t)
 assert.ok(f.api.configure('configure',{overflow:{x:2,y:64,z:0}}).ok)
 const start=f.api.configure('start',{requestId:'one'});assert.ok(start.ok);await f.settle()
 const g=f.api.status().data.goal
 assert.equal(g.status,'succeeded');assert.equal(g.receipt.moved,12);assert.equal(g.receipt.returned,true);assert.equal(f.state.controller.lease,null)
 assert.equal(f.api.configure('start',{requestId:'one'}).data.duplicate,true)
 const before=f.traveling();f.api.configure('start',{});await f.settle();assert.equal(f.api.status().data.goal.receipt.moved,0);assert.equal(f.traveling(),before+1)
})
test('missing destination returns partial without losing cargo; preview never opens or travels',async t=>{
 const f=await fixture(t)
 f.api.preview();assert.equal(f.traveling(),0);assert.equal(f.bot.currentWindow,undefined)
 f.api.configure('start',{});await f.settle()
 const g=f.api.status().data.goal;assert.equal(g.status,'partial');assert.equal(g.receipt.remaining[0].reason,'no_destination');assert.equal(f.carried()[0].count,12)
})
test('cancel retains ownership until pending deposit settles, records its real delta, then releases',async t=>{
 let finish,entered
 const started=new Promise(r=>{entered=r})
 const f=await fixture(t,{deposit:move=>new Promise(resolve=>{finish=()=>{move();resolve()};entered()})})
 f.api.configure('configure',{overflow:{x:2,y:64,z:0}});f.api.configure('start',{})
 await started;assert.ok(f.api.status().data.goal.pending)
 f.api.configure('cancel',{});assert.ok(f.state.controller.lease);assert.equal(f.api.configure('start',{}).error,'stash_busy')
 finish();await f.settle()
 const g=f.api.status().data.goal;assert.equal(g.status,'canceled');assert.equal(g.pending,null);assert.equal(g.receipts[0].moved,12);assert.equal(f.state.controller.lease,null)
})
test('damage interrupts and returns with a blocked diagnostic; container open failures remain visible',async t=>{
 const f=await fixture(t)
 f.bot.openContainer=async()=>{f.bot.health=19;f.bot.emit('health');throw new Error('server_rejected_open')}
 f.api.configure('start',{});await f.settle()
 assert.equal(f.api.status().data.goal.status,'blocked');assert.equal(f.api.status().data.goal.reason,'damage_interrupted');assert.equal(f.api.status().data.goal.receipt.returned,true)
})
test('storage routes and cached containers never cross dimensions',async t=>{
 const f=await fixture(t)
 f.api.configure('configure',{overflow:{x:2,y:64,z:0}})
 f.api.configure('start',{});await f.settle()
 f.bot.game.dimension='the_nether'
 const preview=f.api.preview().data
 assert.equal(preview.policy.overflow,null);assert.deepEqual(preview.catalog,[])
})
test('ambiguous destination changes leave durable intent and block blind restart',async t=>{
 const slots=[null]
 const f=await fixture(t,{slots,deposit:async move=>{move();slots[0].count++}})
 f.api.configure('configure',{overflow:{x:2,y:64,z:0}});f.api.configure('start',{});await f.settle()
 let g=f.api.status().data.goal
 assert.equal(g.status,'blocked');assert.equal(g.reason,'ambiguous_transfer');assert.ok(g.pending)
 assert.equal(f.api.configure('start',{}).error,'pending_transfer_requires_resume')
 f.api.configure('resume',{});await f.settle();g=f.api.status().data.goal
 assert.equal(g.status,'blocked');assert.equal(g.receipts.length,0);assert.equal(slots[0].count,13)
})
test('unreachable/open-rejected containers produce diagnostics and retain inventory',async t=>{
 const f=await fixture(t)
 f.bot.openContainer=async()=>{throw new Error('server_rejected_open')}
 f.api.configure('start',{});await f.settle()
 const g=f.api.status().data.goal
 assert.equal(g.status,'partial');assert.equal(g.errors[0].error,'server_rejected_open');assert.equal(f.carried()[0].count,12)
})
test('overflow suggestions calculate mixed cargo capacity and emit directly executable config',()=>{
 const {suggestions}=require('../bot_impl/stash/policy')
 const q={x:4,y:64,z:0}
 const candidates=[container([null]),container([null,null,null],{id:'4,64,0',position:q,positions:[q],distance:4})]
 const s=suggestions([cargo('stone',80),cargo('ore',2)],candidates,config)
 assert.deepEqual(s[0].configure,{overflow:q});assert.equal(s[0].wouldStore,82);assert.equal(s[0].remaining.length,0)
})
test('labels are re-read at the storage location, so a newly labelled box cannot become overflow',async t=>{
 const f=await fixture(t)
 t.mock.method(require('../bot_impl/frame-sorter'),'scanFrames',()=>({framedChests:f.bot.entity.position.x===2?[{positions:[{x:2,y:64,z:0}],itemKey:'stone'}]:[]}))
 f.api.configure('configure',{overflow:{x:2,y:64,z:0}});f.api.configure('start',{});await f.settle()
 assert.equal(f.api.status().data.goal.status,'partial');assert.equal(f.carried()[0].count,12)
})
test('explicit cancellation overrides a simultaneous damage retreat',async t=>{
 let finish,entered
 const started=new Promise(r=>{entered=r})
 const f=await fixture(t,{deposit:move=>new Promise(resolve=>{finish=()=>{move();resolve()};entered()})})
 f.api.configure('configure',{overflow:{x:2,y:64,z:0}});f.api.configure('start',{});await started
 f.bot.health=19;f.bot.emit('health');f.api.configure('cancel',{})
 const before=f.traveling();finish();await f.settle()
 assert.equal(f.api.status().data.goal.status,'canceled');assert.equal(f.traveling(),before)
})

test('hot reload pauses a pending transfer and blocks new ownership until the old promise settles',async t=>{
 let finish,entered
 const started=new Promise(r=>{entered=r})
 const f=await fixture(t,{deposit:move=>new Promise(resolve=>{finish=()=>{move();resolve()};entered()})})
 f.api.configure('configure',{overflow:{x:2,y:64,z:0}});f.api.configure('start',{});await started
 const fresh=f.reload()
 assert.equal(fresh.status().data.goal.status,'paused');assert.equal(fresh.configure('resume',{}).error,'stash_busy')
 finish();await f.settle()
 assert.equal(fresh.status().data.goal.pending,null);assert.equal(fresh.status().data.goal.receipts[0].moved,12)
 assert.ok(fresh.configure('resume',{}).ok)
 for(let i=0;i<100&&fresh.status().data.busy;i++)await new Promise(r=>setTimeout(r,5))
 assert.equal(fresh.status().data.goal.status,'succeeded');assert.equal(fresh.status().data.goal.receipts.length,1)
})
