const test=require('node:test'),assert=require('node:assert/strict')
const {Vec3}=require('vec3')
const {step}=require('../bot_impl/controller/tunnel')
test('tunnel step never moves or digs toward unsupported floor, diagonal, or up target',async()=>{
  let moves=0,digs=0
  const bot={entity:{position:new Vec3(0.5,64,0.5)},blockAt:()=>null,dig:()=>{digs++}}
  const navigator={start:()=>{moves++}}
  assert.equal((await step(bot,{}, {x:1,y:63,z:1},{canceled:false},navigator)).error,'adjacent_level_or_down_step_required')
  assert.equal((await step(bot,{}, {x:1,y:65,z:0},{canceled:false},navigator)).error,'adjacent_level_or_down_step_required')
  assert.equal((await step(bot,{}, {x:1,y:63,z:0},{canceled:false},navigator)).error,'unsafe_step_support')
  assert.equal(moves,0);assert.equal(digs,0)
})
