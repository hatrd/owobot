const {Vec3}=require('vec3')
const {key,distance,plain}=require('./policy')
const point=p=>({x:p.x,y:p.y,z:p.z})
const vec=p=>new Vec3(p.x,p.y,p.z)
const storage=name=>['chest','trapped_chest','barrel','shulker_box'].includes(name)||name.endsWith('_shulker_box')
function discover(bot,home,radius){
  const ids=bot.registry.blocksArray.filter(b=>storage(b.name)).map(b=>b.id)
  const found=bot.findBlocks({point:vec(home),matching:ids,maxDistance:radius,count:129})
  const frames=require('../frame-sorter').scanFrames(bot,Math.min(64,radius+Math.ceil(distance(home,bot.entity.position))))
  const labels=new Map()
  for(const c of frames.framedChests||[])for(const p of c.positions||[c.position]){
    if(!labels.has(key(p)))labels.set(key(p),[])
    // Unknown frame items still reserve the chest; do not treat it as unlabelled.
    labels.get(key(p)).push(c.itemKey||'unknown_frame_item')
  }
  const seen=new Set(),result=[]
  for(const p of found){
    if(seen.has(key(p)))continue
    const b=bot.blockAt(p,false),props=b?.getProperties?.()||{},positions=[point(p)]
    if(['chest','trapped_chest'].includes(b?.name)&&['left','right'].includes(props.type)){
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
        if(['north','south'].includes(props.facing)?dz!==0:dx!==0)continue
        const q=p.offset(dx,0,dz),other=bot.blockAt(q,false),op=other?.getProperties?.()||{}
        if(other?.name===b.name&&op.facing===props.facing&&['left','right'].includes(op.type)&&op.type!==props.type)positions.push(point(q))
      }
    }
    positions.sort((a,b)=>key(a).localeCompare(key(b)));positions.forEach(p=>seen.add(key(p)))
    result.push({id:key(positions[0]),position:point(p),positions,name:b?.name,labels:[...new Set(positions.flatMap(p=>labels.get(key(p))||[]))],distance:distance(p,home)})
  }
  return {containers:result.slice(0,128),truncated:found.length>=129}
}
function labelsFor(bot,c){
  const scan=require('../frame-sorter').scanFrames(bot,8)
  return [...new Set((scan.framedChests||[]).filter(f=>(f.positions||[f.position]).some(p=>c.positions.some(q=>key(q)===key(p)))).map(f=>f.itemKey||'unknown_frame_item'))]
}
async function open(bot,p,token){
  if(token.canceled)throw new Error('canceled')
  if(bot.currentWindow)throw new Error('window_busy')
  const block=bot.blockAt(vec(p),false)
  if(!block||!storage(block.name))throw new Error('container_missing')
  if(distance(bot.entity.position,vec(p).offset(.5,.5,.5))>4.5)throw new Error('container_out_of_reach')
  // Mineflayer's openBlock has a bounded 20s listener timeout. Await it rather
  // than racing a shorter timeout and leaving a listener to steal a later window.
  const window=await bot.openContainer(block)
  if(token.canceled){window.close();throw new Error('canceled')}
  return window
}
function snapshot(window,c){return {...c,slots:window.slots.slice(0,window.inventoryStart).map(plain),observedAt:Date.now(),error:null}}
const inventory=w=>w.slots.slice(w.inventoryStart,w.inventoryEnd).filter(Boolean)
const count=(items,name)=>items.filter(i=>i?.name===name).reduce((n,i)=>n+i.count,0)
module.exports={discover,labelsFor,open,snapshot,inventory,count,point,vec}
