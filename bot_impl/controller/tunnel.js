const {Vec3}=require('vec3')
const {fluid,fullSupport}=require('../navigation/liquids')
const {excavate}=require('./excavate')
// One reversible cardinal stair/tunnel step; external planner chooses direction.
async function step(bot,state,args,cancel,navigator){
  const start=bot.entity.position.floored(),p=new Vec3(args.x,args.y,args.z)
  if(Math.abs(p.x-start.x)+Math.abs(p.z-start.z)!==1 || ![0,-1].includes(p.y-start.y))return {ok:false,error:'adjacent_level_or_down_step_required',position:start}
  const support=bot.blockAt(p.offset(0,-1,0),false)
  if(!fullSupport(support)||fluid(bot,support).kind!=='dry')return {ok:false,error:'unsafe_step_support'}
  const cleared=[]
  for(let y=Math.max(start.y+1,p.y+1);y>=p.y;y--){
    if(cancel.canceled)return {ok:false,error:'canceled',data:{cleared}}
    const block=bot.blockAt(new Vec3(p.x,y,p.z),false)
    if(!block||fluid(bot,block).kind!=='dry')return {ok:false,error:'unsafe_step_volume',data:{cleared}}
    if(block.boundingBox==='empty')continue
    const result=await excavate(bot,state,{x:p.x,y,z:p.z,expected:block.name},cancel)
    if(!result.ok)return {...result,data:{...result.data,cleared}}
    cleared.push({x:p.x,y,z:p.z,name:block.name})
  }
  if(cancel.canceled)return {ok:false,error:'canceled',data:{cleared}}
  const result=await navigator.start({...args,range:0.5},cancel)
  return {...result,data:{...result.data,cleared,start,target:p}}
}
module.exports={step}
