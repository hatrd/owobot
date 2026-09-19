const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {decide}=require('../bot_impl/fishing/policy')
const {createStore}=require('../bot_impl/fishing/store')
const {validate}=require('../bot_impl/fishing/contract')
const home={x:0,y:64,z:0,dimension:'overworld'}
const doc={home,count:8,caught:0,baseline:6,radius:32,spot:{stand:{x:4,y:64,z:0}},recoveredAt:0}
const facts={ready:true,dimension:'overworld',health:20,food:20,hostiles:0,damageAt:0,position:{x:4,y:64,z:0},timeOfDay:6000,rod:true,freeSlots:6,fish:6}
test('fishing priority interrupts a cast immediately on damage, before low-health threshold',()=>{
  assert.equal(decide(doc,facts,100),'cast')
  assert.equal(decide(doc,{...facts,health:19,damageAt:50},100),'retreat')
  assert.equal(decide(doc,{...facts,position:home,damageAt:50},100),'recover')
  assert.equal(decide({...doc,recoveredAt:60},{...facts,damageAt:50},100),'cast')
})
test('night returns home and sleeps; successful catch target does not override night safety',()=>{
  assert.equal(decide({...doc,caught:8},{...facts,timeOfDay:14000},100),'return_for_sleep')
  assert.equal(decide(doc,{...facts,position:home,timeOfDay:14000},100),'sleep')
  assert.equal(decide({...doc,caught:8},facts,100),'return_complete')
  assert.equal(decide({...doc,caught:8},{...facts,position:home},100),'verify')
})
test('supplies, food, hostiles, water and dimension are structured decisions',()=>{
  assert.equal(decide(doc,{...facts,rod:false},0),'prepare')
  assert.equal(decide(doc,{...facts,freeSlots:0},0),'prepare')
  assert.equal(decide(doc,{...facts,food:10},0),'eat')
  assert.equal(decide(doc,{...facts,hostiles:1},0),'retreat')
  assert.equal(decide(doc,{...facts,inWater:true},0),'retreat')
  assert.equal(decide(doc,{...facts,dimension:'the_nether'},0),'wrong_dimension')
})
test('durable fishing progress and baseline survive a fresh runtime; corrupt/wrong-world journals fail closed',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fishing-test-')),file=path.join(dir,'goal.json')
  try{
    const s=createStore({},'w',file)
    s.save(d=>Object.assign(d,doc,{status:'running',caught:3,events:[{type:'catch',count:3}]}))
    const fresh=createStore({},'w',file)
    assert.equal(fresh.get().caught,3);assert.equal(fresh.get().baseline,6);assert.equal(fresh.get().status,'running')
    assert.ok(createStore({},'other',file).error())
    fs.writeFileSync(file,'{broken')
    const bad=createStore({},'w',file);assert.ok(bad.error());assert.throws(()=>bad.save(()=>{}))
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('fishing contract rejects impossible counts and extra arguments',()=>{
  assert.ok(validate('start',{count:8}).ok)
  assert.equal(validate('start',{count:0}).ok,false)
  assert.equal(validate('resume',{count:8}).ok,false)
  assert.equal(validate('cook',{}).ok,false)
})
test('canceling an active cast retracts once, rejects promptly and releases hand/look ownership',async()=>{
  const {Vec3}=require('vec3'),{EventEmitter}=require('events')
  const bot=new EventEmitter(),registry=require('minecraft-data')('1.21.4'),Block=require('prismarine-block')('1.21.4')
  bot.registry=registry;bot.entity={position:new Vec3(.5,64,.5)}
  const rod={name:'fishing_rod',count:1,maxDurability:64,durabilityUsed:0}
  bot.inventory={items:()=>[rod]};bot.equip=async()=>{bot.heldItem=rod};bot.lookAt=async()=>{}
  bot.blockAt=p=>{const b=Block.fromStateId(registry.blocksByName[p.y<64?'stone':'air'].defaultState,0);b.position=p.floored();return b}
  let rejectFish,retractions=0
  bot.fish=()=>new Promise((resolve,reject)=>{rejectFish=reject})
  bot.activateItem=()=>{retractions++;rejectFish(new Error('server_retracted'))}
  const state={},driver=require('../bot_impl/fishing/driver').createDriver(bot,state),token={canceled:false}
  const promise=driver.cast({spot:{aim:{x:3,y:63,z:0}}},token)
  await new Promise(resolve=>setTimeout(resolve,30));driver.stop(token)
  await assert.rejects(promise,/canceled/)
  assert.equal(retractions,1);assert.equal(state.isFishing,false);assert.equal(state.holdItemLock,null);assert.equal(state.autoLookSuspended,false)
})
