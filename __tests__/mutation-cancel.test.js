const test=require('node:test'),assert=require('node:assert/strict')
const {createRuntime}=require('../bot_impl/controller/runtime')
const actions={excavate:{x:0,y:0,z:0,expected:'stone'},tunnel_step:{x:0,y:0,z:0},discard:{item:'stone',keep:32},storage_transfer:{x:0,y:0,z:0,direction:'deposit',item:'stone',count:1},smelt:{x:0,y:0,z:0,input:'iron_ore',output:'iron_ingot',count:1,fuel:'coal',fuelCount:1}}
for(const [action,args] of Object.entries(actions))test(`${action} is not replayed after survival interruption`,async()=>{
 let hazard=null,resolve,calls=0
 const state={},api=createRuntime({state,driver:{busy(){},isBusy:()=>false,hazard:()=>hazard,stop(){},facts:()=>({}),action:()=>{calls++;return new Promise(r=>{resolve=r})}}})
 const lease=api.write('session.acquire',{controllerId:'test',ttlMs:10000}),auth={leaseId:lease.leaseId,epoch:lease.epoch}
 assert.equal(api.write('behavior.install',{...auth,behavior:{id:'mutation',revision:'1',entry:'work',nodes:{work:{type:'action',action,args,next:'end',timeoutMs:4000},end:{type:'end'}}}}).ok,true)
 assert.equal(api.write('task.start',{...auth,requestId:'r',behaviorId:'mutation',revision:'1',timeoutMs:5000}).ok,true)
 api.tick();await new Promise(setImmediate);hazard='low_health';api.tick()
 hazard=null;resolve({ok:true});await new Promise(setImmediate);api.tick()
 assert.equal(calls,1);assert.equal(state.controller.tasks[0].status,'canceled');assert.equal(state.controller.tasks[0].reason,'mutation_interrupted_by_hazard')
 api.dispose()
})
