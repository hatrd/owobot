const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
function createTravel(bot,state,runtime){
  const nav=require('./drive').createNavigator(bot,state)
  const surface=require('./surface').createSurfaceDriver(bot,state)
  const check=t=>{if(t.canceled)throw new Error('canceled')}
  async function go(p,t,doc,range=1){
    check(t)
    if(distance(bot.entity.position,p)<=range)return
    const dry=await require('../navigation/observe').observe(bot,{...p,range,liquidMode:'dry'})
    const plan=dry.data?.plan?.status==='success'?{ok:true,actions:[{action:'goto',args:{...p,range}}]}:await require('../navigation/journey').plan(bot,p,{range,radius:doc.radius,home:doc.home})
    if(!plan.ok)throw Object.assign(new Error(plan.error),{detail:plan})
    runtime.journey={target:p,actions:plan.actions,index:0}
    for(const [index,a] of plan.actions.entries()){
      check(t);runtime.journey.index=index
      const timer=setTimeout(()=>{nav.stop('travel_timeout');surface.stop('travel_timeout')},45000)
      try{
        const r=a.action==='surface_travel'?await surface.start(a.args,t):await nav.start(a.args,t,pos=>distance(pos,doc.home)<=doc.radius+2)
        check(t);if(!r.ok)throw Object.assign(new Error(r.error),{detail:r.data})
      }finally{clearTimeout(timer)}
    }
    if(distance(bot.entity.position,p)>range+Math.sqrt(3))throw new Error('journey_arrival_unconfirmed')
  }
  return {go,stop(reason){nav.stop(reason);surface.stop(reason)}}
}
module.exports={createTravel}
