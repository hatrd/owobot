const {Vec3}=require('vec3')
const {fluid,fullSupport,cell}=require('./liquids')
const {corridor}=require('./surface')
const key=p=>`${p.x},${p.y},${p.z}`
// Bounded local route graph. Dry stairs and verified straight surface crossings are
// separate edges; water edges always end on solid land and never request diving.
async function plan(bot,target,{range=1,radius=128,home=bot.entity.position,maxNodes=20000}={}){
  let start=bot.entity.position.floored()
  if(bot.entity.onGround && bot.entity.position.y-start.y>.001 && bot.blockAt(start,false)?.boundingBox==='block')start=start.offset(0,1,0)
  const goal=new Vec3(target.x,target.y,target.z)
  const movements=new (require('./pathfinder').Movements)(bot)
  movements.liquidMode='dry';movements.canDig=false;movements.allow1by1towers=false;movements.scafoldingBlocks=[];movements.allowParkour=false;movements.allowSprinting=false;movements.allowEntityDetection=false
  const cache=new Map()
  function medium(p){const k=key(p);if(cache.has(k))return cache.get(k)
    const feet=bot.blockAt(p,false),head=bot.blockAt(p.offset(0,1,0),false),floor=bot.blockAt(p.offset(0,-1,0),false)
    let result=null
    if(feet&&head&&floor&&feet.boundingBox==='empty'&&head.boundingBox==='empty'&&fluid(bot,feet).kind==='dry'&&fluid(bot,head).kind==='dry'){
      const f=fluid(bot,floor)
      if(f.kind==='dry'&&fullSupport(floor)&&cell(bot,p,'dry').allowed)result='dry'
      else if(f.kind==='water'&&!f.flowing&&!f.bubble)result='surface'
    }
    cache.set(k,result);return result
  }
  const h=p=>Math.hypot(p.x+.5-goal.x,p.z+.5-goal.z)+Math.abs(p.y-goal.y)
  const nodes=new Map([[key(start),{p:start,g:0,f:h(start),parent:null}]])
  const open=new (require('mineflayer-pathfinder/lib/heap'))(),closed=new Set()
  open.push(nodes.get(key(start)))
  const started=Date.now()
  let visited=0
  while(!open.isEmpty() && visited++<maxNodes && Date.now()-started<3000){
    if(visited%32===0)await new Promise(resolve=>setImmediate(resolve))
    const n=open.pop(),nk=key(n.p)
    if(closed.has(nk))continue
    closed.add(nk)
    if(n.p.offset(.5,0,.5).distanceTo(goal)<=range){
      const actions=[];let cur=n
      while(cur.parent){actions.push({action:cur.action,args:{x:cur.p.x+.5,y:cur.p.y,z:cur.p.z+.5,range:.5}});cur=cur.parent}
      actions.reverse()
      // Collapse only collinear dry steps at the same elevation. Corners and stairs remain explicit.
      const compact=[]
      for(let i=0;i<actions.length;i++){
        const a=actions[i],prev=actions[i-1],next=actions[i+1]
        if(a.action==='goto'&&prev?.action==='goto'&&next?.action==='goto'&&prev.args.y===a.args.y&&a.args.y===next.args.y&&(a.args.x-prev.args.x)*(next.args.z-a.args.z)===(a.args.z-prev.args.z)*(next.args.x-a.args.x))continue
        compact.push(a)
      }
      return {ok:true,actions:compact,visitedNodes:visited}
    }
    function add(p,action,cost){if(Math.hypot(p.x-home.x,p.y-home.y,p.z-home.z)>radius||closed.has(key(p)))return
      const g=n.g+cost,old=nodes.get(key(p));if(old&&old.g<=g)return
      const node={p,g,f:g+h(p),parent:n,action};nodes.set(key(p),node);open.push(node)
    }
    for(const next of movements.getNeighbors({...n.p,remainingBlocks:0})){
      if(next.toBreak.length || next.toPlace.length)continue
      add(new Vec3(next.x,next.y,next.z),'goto',next.cost)
    }
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      if(medium(n.p.offset(dx,0,dz))!=='surface')continue
      for(let step=2;step<=32;step++){
        const p=n.p.offset(dx*step,0,dz*step),m=medium(p)
        if(!m)break
        if(m==='dry'){
          const facade=Object.create(bot);facade.entity={...bot.entity,position:n.p.offset(.5,0,.5)}
          if(corridor(facade,{x:p.x+.5,y:p.y,z:p.z+.5}).ok)add(p,'surface_travel',Math.hypot(dx,dz)*step*3)
          break
        }
      }
    }
  }
  return {ok:false,error:'no_safe_journey',visitedNodes:visited,loadedOnly:true}
}
module.exports={plan}
