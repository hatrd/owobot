const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { createStore } = require('../bot_impl/memory')
const { checkDig, install } = require('../bot_impl/safety')
const record = { id: 'home', kind: 'home', subject: 'home', dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, radius: 20, fact: 'Departure', source: 'user', confidence: 'observed' }
test('durable evidence survives process state replacement, reports corruption without overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-'))
  try {
    const file = path.join(dir, 'memory.json')
    const store = createStore({}, file, 'world')
    assert.equal(store.write('knowledge.put', record).ok, true)
    assert.equal(createStore({}, file, 'world').query({kind:'home'}).records[0].id, 'home')
    assert.equal(store.write('knowledge.put', {...record, id:'player',kind:'player',subject:'uuid',fact:'Prefers quiet', confidence:'reported'}).ok,true)
    assert.equal(store.query({subject:'uuid'}).total,1)
    fs.writeFileSync(file, '{broken')
    const broken = createStore({}, file, 'world')
    assert.equal(broken.write('knowledge.put', record).ok,false)
    assert.equal(fs.readFileSync(file,'utf8'),'{broken')
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})
function fixture () {
  const block = (p,name='stone',type=1) => ({position:p,name,type,boundingBox:'block'})
  const bot = {state:{knowledge:{document:{records:[]}}},game:{dimension:'overworld'},entity:{position:new Vec3(1,10,1)},registry:{blocksByName:{lava:{id:2},water:{id:3}}},blockAt:p=>block(p),dig:async()=>{bot.dug=true}}
  const target = block(new Vec3(2,10,1))
  bot.state.knowledge.document.records.push({...record,kind:'mining',position:{x:1,y:10,z:1},radius:40})
  return {bot,target,block}
}
test('all digging entrypoints enforce protection, fluid and underfoot policies',async()=>{
  const {bot,target,block}=fixture()
  assert.equal(checkDig(bot,target).ok,true)
  bot.state.knowledge.document.records.push(record)
  assert.equal(checkDig(bot,target).error,'protected_region')
  let cleanup; const original=bot.dig
  install(bot,{state:bot.state,registerCleanup:fn=>{cleanup=fn}})
  await assert.rejects(bot.dig(target), /protected_region/)
  assert.equal(bot.dug,undefined)
  cleanup();assert.equal(bot.dig,original)
  bot.state.knowledge.document.records.pop()
  assert.equal(checkDig(bot,block(new Vec3(1,9,1))).error,'underfoot_excavation')
  bot.blockAt=p=>block(p,'lava',2)
  assert.equal(checkDig(bot,target).error,'fluid_or_unknown_neighbor')
  bot.blockAt=()=>null
  assert.equal(checkDig(bot,target).error,'fluid_or_unknown_neighbor')
})
test('modern item enchantments use components instead of empty legacy NBT',()=>{
  const {enchantments}=require('../bot_impl/safety/items')
  const item={componentMap:new Map([['enchantments',{data:{enchantments:[{id:33,level:1}]}}]]),enchants:[]}
  assert.deepEqual(enchantments({registry:{enchantments:{33:{name:'silk_touch'}}}},item),[{id:33,name:'silk_touch',level:1}])
})
test('storage confirmation reads active window inventory rather than stale closed inventory',async()=>{
  const {transfer}=require('../bot_impl/controller/storage')
  const item={name:'bow',type:1,metadata:0,count:1}
  const win={inventoryStart:1,inventoryEnd:2,slots:[null,item],containerItems:()=>[],deposit:async()=>{win.slots=[item,null]},close:()=>{bot.currentWindow=null}}
  const bot={entity:{position:new Vec3(0,1,0)},blockAt:()=>({name:'chest'}),inventory:{items:()=>[item]},openContainer:async()=>{bot.currentWindow=win;return win}}
  const r=await transfer(bot,{}, {x:1,y:1,z:0,item:'bow',count:1,direction:'deposit'},{canceled:false})
  assert.equal(r.ok,true);assert.equal(r.data.transferred,1);assert.equal(bot.currentWindow,null)
})
test('navigation arrival accounts for actual half-height support without accepting an airborne offset',()=>{
  const {reached}=require('../bot_impl/navigation/drive')
  const target={isEnd:p=>p.x===2&&p.y===69&&p.z===3}
  const slab={blockAt:()=>({shapes:[[0,0,0,1,0.5,1]]})}
  assert.equal(reached(slab,target,new Vec3(2.5,68.5,3.5)),true)
  assert.equal(reached({blockAt:()=>({shapes:[]})},target,new Vec3(2.5,68.5,3.5)),false)
})
test('mining height bounds never weaken a protected column',()=>{
  const {bot,target}=fixture()
  bot.state.knowledge.document.records[0].maxY=9
  assert.equal(checkDig(bot,target).error,'outside_mining_region')
  bot.state.knowledge.document.records[0].maxY=10
  assert.equal(checkDig(bot,target).ok,true)
  bot.state.knowledge.document.records.push({...record,minY:100,maxY:110})
  assert.equal(checkDig(bot,target).error,'protected_region')
})
