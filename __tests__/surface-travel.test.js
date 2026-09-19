const test=require('node:test'),assert=require('node:assert/strict')
const {Vec3}=require('vec3')
const {corridor}=require('../bot_impl/navigation/surface')
function fixture(){
  return {entity:{position:new Vec3(0.5,63,0.5)},registry:{blocksByName:{water:{id:1},lava:{id:2}}},blockAt:p=>p.y>=63?{type:0,boundingBox:'empty',shapes:[]}:(p.x===0||p.x===10)?{type:3,boundingBox:'block',shapes:[[0,0,0,1,1,1]]}:{type:1,boundingBox:'empty',shapes:[],getProperties:()=>({level:0})}}
}
test('short surface corridor requires dry loaded landing and rejects lava/ceiling/unknown',()=>{
 const bot=fixture(),args={x:10.5,y:63,z:0.5}
 assert.equal(corridor(bot,args).ok,true)
 const at=bot.blockAt
 bot.blockAt=p=>p.x===5&&p.y===62?{type:2,boundingBox:'empty'}:at(p)
 assert.equal(corridor(bot,args).ok,false)
 bot.blockAt=p=>p.x===5&&p.y===63?{type:3,boundingBox:'block'}:at(p)
 assert.equal(corridor(bot,args).error,'surface_obstructed')
 bot.blockAt=p=>p.x===5?null:at(p)
 assert.equal(corridor(bot,args).error,'unloaded')
 bot.blockAt=at
 assert.equal(corridor(bot,{x:9.5,y:63,z:0.5}).error,'dry_landing_required')
})
