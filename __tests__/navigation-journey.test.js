const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3')
const {plan}=require('../bot_impl/navigation/journey')
function fixture(liquid='water'){
  const registry=require('minecraft-data')('1.21.4'),Block=require('prismarine-block')('1.21.4')
  return {registry,game:{minY:-64},inventory:{items:()=>[]},entities:{},entity:{position:new Vec3(.5,64,.5)},blockAt(p){
    p=p.floored();if(p.x<0||p.x>8||p.z!==0||p.y<63)return null
    const name=p.y===63?(p.x>=2&&p.x<=6?liquid:'stone'):'air'
    const b=Block.fromStateId(registry.blocksByName[name].defaultState,0);b.position=p;return b
  }}
}
test('journey plans dry approaches and a verified surface crossing ending on land',async()=>{
  const r=await plan(fixture(),{x:8.5,y:64,z:.5},{range:.5})
  assert.ok(r.ok,JSON.stringify(r));assert.ok(r.actions.some(a=>a.action==='surface_travel'))
  assert.equal(r.actions.at(-1).args.x,8.5)
})
test('journey never crosses lava or an unloaded void',async()=>{
  assert.equal((await plan(fixture('lava'),{x:8.5,y:64,z:.5})).ok,false)
  const bot=fixture(),original=bot.blockAt;bot.blockAt=p=>p.x>=4&&p.x<5?null:original(p)
  assert.equal((await plan(bot,{x:8.5,y:64,z:.5})).ok,false)
})
test('journey bounds traversal to the requested home radius',async()=>{
  assert.equal((await plan(fixture(),{x:8.5,y:64,z:.5},{radius:3})).ok,false)
})
