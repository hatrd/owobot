const {Vec3}=require('vec3')
const {fluid,fullSupport}=require('./liquids')
const {oxygen}=require('./oxygen')
function corridor(bot,args){
  const start=bot.entity.position,target=new Vec3(args.x,args.y,args.z)
  const distance=Math.hypot(target.x-start.x,target.z-start.z)
  if(distance>48 || start.y<target.y-2.5 || start.y>target.y+4)return {ok:false,error:'surface_range'}
  const inspect=p=>{
    const feet=bot.blockAt(p,false),head=bot.blockAt(p.offset(0,1,0),false),floor=bot.blockAt(p.offset(0,-1,0),false)
    if(!feet||!head||!floor)return 'unloaded'
    if(feet.boundingBox!=='empty'||head.boundingBox!=='empty'||fluid(bot,feet).kind!=='dry'||fluid(bot,head).kind!=='dry')return 'surface_obstructed'
    const f=fluid(bot,floor)
    if(f.kind==='water'&&!f.flowing&&!f.bubble)return null
    if(f.kind==='dry'&&fullSupport(floor))return null
    return 'unsafe_surface'
  }
  const end=target.floored(),floor=bot.blockAt(end.offset(0,-1,0),false)
  if(!fullSupport(floor)||fluid(bot,floor).kind!=='dry'||inspect(end))return {ok:false,error:'dry_landing_required'}
  const steps=Math.max(1,Math.ceil(distance*4))
  for(let i=0;i<=steps;i++){
    const p=new Vec3(Math.floor(start.x+(target.x-start.x)*i/steps),Math.floor(args.y),Math.floor(start.z+(target.z-start.z)*i/steps))
    const error=inspect(p);if(error)return {ok:false,error,position:p}
  }
  return {ok:true,distance}
}
function createSurfaceDriver(bot,state){
  let operation=null
  function stop(reason='canceled'){operation?.finish(false,reason)}
  function start(args,cancellation){
    stop('replaced')
    const preview=corridor(bot,args);if(!preview.ok)return Promise.resolve(preview)
    const r=state.surfaceTravel={phase:'moving',target:args,startedAt:Date.now(),lastProgressAt:Date.now(),lastPosition:bot.entity.position.clone()}
    return new Promise(resolve=>{
      let timer
      const own={finish};operation=own
      function finish(ok,error){
        if(operation!==own)return
        operation=null;clearInterval(timer)
        for(const key of ['forward','jump','sprint'])bot.setControlState(key,false)
        r.phase=ok?'arrived':'failed';r.reason=error;r.finishedAt=Date.now()
        resolve({ok,...(ok?{}:{error}),data:{...r}})
      }
      async function tick(){
        if(operation!==own)return
        if(cancellation.canceled)return finish(false,'canceled')
        const p=bot.entity?.position
        const air=oxygen(bot).level
        if(!p||bot.health<16||bot.food<10||(air!==null&&air<16))return finish(false,'unsafe_vitals')
        const head=bot.blockAt(p.offset(0,bot.entity.eyeHeight||1.62,0).floored(),false)
        if(fluid(bot,head).kind==='water')r.submergedAt ||= Date.now();else r.submergedAt=null
        if(p.y<args.y-2.5 || (r.submergedAt && Date.now()-r.submergedAt>2000))return finish(false,'surface_submerged')
        const dx=args.x-p.x,dz=args.z-p.z
        if(Math.hypot(dx,dz)<0.6&&p.y>=args.y-0.05&&bot.entity.onGround)return finish(true,'landed')
        if(Date.now()-r.startedAt>45000||Date.now()-r.lastProgressAt>8000)return finish(false,'surface_stalled')
        if(p.distanceTo(r.lastPosition)>0.4){r.lastProgressAt=Date.now();r.lastPosition=p.clone()}
        const check=corridor(bot,args);if(!check.ok)return finish(false,check.error)
        await bot.look(Math.atan2(-dx,-dz),0,true)
        if(operation!==own||cancellation.canceled)return
        bot.setControlState('sneak',false);bot.setControlState('sprint',false)
        if(fluid(bot,bot.blockAt(p.floored(),false)).kind==='water')r.enteredWater=true
        bot.setControlState('jump',!!r.enteredWater);bot.setControlState('forward',true)
      }
      timer=setInterval(()=>tick().catch(e=>finish(false,e.message)),100);timer.unref?.()
    })
  }
  return {start,stop}
}
module.exports={corridor,createSurfaceDriver}
