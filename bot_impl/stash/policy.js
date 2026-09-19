const {held}=require('../inventory-reservations')
const key=p=>`${p.x},${p.y},${p.z}`
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
// All component-bearing variants are reserved: Mineflayer deposit does not compare
// modern components. Never let a name-only transfer select a custom variant.
const special=i=>!!i.nbt || !!i.components?.length || !!i.removedComponents?.length || !!i.removeComponents?.length
function partition(items,registry,state,config){
  const kept=[],cargo=[]
  for(const name of [...new Set(items.map(i=>i.name))]){
    const group=items.filter(i=>i.name===name),count=group.reduce((n,i)=>n+i.count,0)
    const reason=held(state,name)?'task_hold':group.some(special)?'custom_components':group.some(i=>i.maxDurability||i.stackSize===1)?'equipment_or_container':null
    const reserve=reason?count:Math.max(config.keep?.[name]||0,registry.foodsByName?.[name]?config.foodReserve??64:0)
    const keep=Math.min(count,reserve)
    if(keep)kept.push({item:name,count:keep,reason:reason||(config.keep?.[name]>=keep?'configured_keep':'food_reserve')})
    if(count>keep)cargo.push({item:name,count:count-keep,type:group[0].type,metadata:group[0].metadata,stackSize:group[0].stackSize||64})
  }
  return {kept,cargo}
}
function plain(i){return i?{name:i.name,type:i.type,metadata:i.metadata,count:i.count,stackSize:i.stackSize||64,special:special(i)}:null}
const compatible=(i,c)=>i&&!i.special&&i.name===c.item&&i.metadata===c.metadata
function plan(cargo,containers,config){
  const working=containers.filter(c=>!c.error&&Array.isArray(c.slots)).map(c=>({...c,slots:c.slots.map(i=>i&&({...i}))}))
  const transfers=[],remaining=[]
  for(const item of cargo){
    let left=item.count
    const explicit=(config.routes||[]).filter(r=>r.item===item.item)
    const ranked=working.map(c=>{
      const matches=p=>c.positions.some(q=>key(p)===key(q))
      const rank=explicit.length?(explicit.some(r=>matches(r.position))?0:99):c.labels?.length?(c.labels.includes(item.item)?1:99):c.slots.some(i=>compatible(i,item))?2:config.overflow&&matches(config.overflow)?3:99
      return {c,rank}
    }).filter(x=>x.rank<99).sort((a,b)=>a.rank-b.rank||a.c.distance-b.c.distance)
    for(const {c,rank} of ranked){
      const before=left
      // Shared slot budget across item kinds and stacks, including double chests.
      for(let j=0;j<c.slots.length&&left;j++){
        const slot=c.slots[j]
        if(slot&&!compatible(slot,item))continue
        const n=Math.min(left,slot?Math.max(0,item.stackSize-slot.count):item.stackSize)
        if(n){c.slots[j]=slot?{...slot,count:slot.count+n}:{name:item.item,metadata:item.metadata,count:n,special:false};left-=n}
      }
      if(before>left)transfers.push({item:item.item,count:before-left,position:c.position,container:c.id,evidence:['explicit_route','item_frame','existing_item','configured_overflow'][rank]})
      if(!left)break
    }
    if(left)remaining.push({item:item.item,count:left,reason:ranked.length?'capacity_exhausted':'no_destination'})
  }
  return {transfers,remaining}
}
// Return executable suggestions, not a dump that makes an LLM count slots.
// Choosing to mix unassigned cargo into existing storage remains explicit.
function suggestions(cargo,containers,config){
  if(!cargo.length)return []
  const baseline=plan(cargo,containers,config).transfers.reduce((n,t)=>n+t.count,0)
  return containers.filter(c=>!c.error&&c.slots&&!c.labels?.length).map(c=>{
    const result=plan(cargo,containers,{...config,overflow:c.position})
    return {position:c.position,observedAt:c.observedAt,emptySlots:c.slots.filter(i=>!i).length,wouldStore:result.transfers.reduce((n,t)=>n+t.count,0),remaining:result.remaining,configure:{overflow:c.position},distance:c.distance}
  }).filter(c=>c.wouldStore>baseline).sort((a,b)=>a.remaining.length-b.remaining.length||b.wouldStore-a.wouldStore||a.distance-b.distance).slice(0,3)
}
// A two-sided delta is required for an interrupted intent; contradictory changes
// caused by concurrent players cannot be attributed to this task.
function reconcile(intent,source,destination){
  const removed=intent.sourceBefore-source,added=destination-intent.destinationBefore
  return removed===added&&removed>=0&&removed<=intent.count?{ok:true,moved:removed}:{ok:false,error:'ambiguous_transfer',removed,added}
}
module.exports={key,distance,special,plain,partition,plan,reconcile,compatible,suggestions}
