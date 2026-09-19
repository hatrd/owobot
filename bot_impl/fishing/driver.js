const {Vec3}=require('vec3')
const {fluid,fullSupport,cell,body}=require('../navigation/liquids')
const {edible,distance}=require('./policy')
const {held}=require('../inventory-reservations')
const vec=p=>new Vec3(p.x,p.y,p.z)
const point=p=>({x:p.x,y:p.y,z:p.z})
const delay=ms=>new Promise(r=>setTimeout(r,ms))
function createDriver(bot,state){
  const travel=require('../navigation/travel').createTravel(bot,state,{set journey(value){state.fishing.runtime.journey=value},get journey(){return state.fishing.runtime.journey}})
  const items=()=>bot.inventory.items()
  const count=name=>items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
  const fishCount=()=>edible.reduce((n,name)=>n+count(name),0)
  const check=t=>{if(t.canceled)throw new Error('canceled')}
  async function wait(ms,t){for(let left=ms;left>0;left-=100){check(t);await delay(Math.min(left,100))}check(t)}
  function find(names,doc,max=40){const ids=names.map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger);return ids.length?bot.findBlocks({point:vec(doc.home),matching:ids,maxDistance:doc.radius,count:max}).map(point):[]}
  async function preview(p,range=1,doc){
    const r=await require('../navigation/observe').observe(bot,{...p,range,liquidMode:'dry'})
    if(r.data?.plan?.status==='success')return true
    return !!doc && (await require('../navigation/journey').plan(bot,p,{range,radius:doc.radius,home:doc.home})).ok
  }
  async function go(p,t,doc,range=1){return travel.go(p,t,doc,range)}
  function facts(){return {ready:!!state.hasSpawned&&!!bot.entity?.position,position:bot.entity?.position&&point(bot.entity.position),dimension:String(bot.game?.dimension),health:bot.health,food:bot.food,timeOfDay:bot.time?.timeOfDay,inWater:body(bot).inWater,eating:!!state.autoEat?.eating,hostiles:require('../agent/observer').snapshot(bot,{hostileRange:12}).nearby.hostiles.count,freeSlots:bot.inventory.emptySlotCount(),rod:items().some(i=>i.name==='fishing_rod' && (!i.maxDurability || i.maxDurability-(i.durabilityUsed||0)>8)),fish:fishCount()}}
  async function chooseSpot(doc,t){
    const candidates=new Map()
    const waters=find(['water'],doc,400)
    for(const w of waters){
      const water=vec(w),above=bot.blockAt(water.offset(0,1,0),false)
      if(!above || above.boundingBox!=='empty'||fluid(bot,above).kind!=='dry'||fluid(bot,bot.blockAt(water)).flowing)continue
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(let gap=2;gap<=4;gap++)for(let rise=1;rise<=3;rise++){
        const stand=water.offset(dx*gap,rise,dz*gap)
        const floor=bot.blockAt(stand.offset(0,-1,0),false),feet=bot.blockAt(stand,false),head=bot.blockAt(stand.offset(0,1,0),false)
        if(!fullSupport(floor)||!feet||!head||feet.boundingBox!=='empty'||head.boundingBox!=='empty'||!cell(bot,stand,'dry').allowed||distance(stand,doc.home)>doc.radius)continue
        const p=stand.offset(.5,0,.5)
        candidates.set(p.toString(),{stand:point(p),aim:point(water.offset(.5,.65,.5))})
      }
    }
    const sorted=[...candidates.values()].sort((a,b)=>distance(a.stand,doc.home)-distance(b.stand,doc.home))
    for(const s of sorted.slice(0,32)){check(t);if(await preview(s.stand,.5,doc))return s}
    throw Object.assign(new Error('no_safe_fishing_shore'),{detail:{waterBlocks:waters.length,shoreCandidates:sorted.length}})
  }
  async function prepare(doc,t){
    // Use existing storage and recipes; never break player blocks to obtain supplies.
    const rod=()=>facts().rod
    const ready=()=>rod()&&bot.inventory.emptySlotCount()>=4
    if(ready())return {ready:true}
    const containers=find(bot.registry.blocksArray.filter(b=>['chest','trapped_chest','barrel','shulker_box'].includes(b.name)||b.name.endsWith('_shulker_box')).map(b=>b.name),doc,256)
    const events=doc.events||[]
    const lastCast=events.findLastIndex(e=>e.kind==='cast')
    const recent=rod()?events.slice(lastCast+1):events
    const visited=new Set([...(rod()?[]:(doc.checkedStorage||[])),...recent.filter(e=>e.type==='result'&&e.kind==='prepare'&&e.result?.checked).flatMap(e=>[e.result.checked,...(e.result.paired||[])])].map(p=>`${p.x},${p.y},${p.z}`))
    let errors=[]
    for(const p of (count('string')>=2 && (count('stick')>=3 || bot.recipesFor(bot.registry.itemsByName.stick.id,null,1,false).length) ? [] : containers).sort((a,b)=>distance(a,bot.entity.position)-distance(b,bot.entity.position))){
      const key=`${p.x},${p.y},${p.z}`
      if(visited.has(key))continue
      check(t)
      if(!await preview(p,3,doc)) {errors.push({position:p,error:'no_safe_dry_route'});continue}
      await go(p,t,doc,3)
      let window
      try{
        check(t);window=await bot.openContainer(bot.blockAt(vec(p)));check(t)
        const inventory=()=>window.slots.slice(window.inventoryStart,window.inventoryEnd).filter(Boolean)
        for(const i of inventory()){
          if(bot.inventory.emptySlotCount()>=6)break
          if(!['stone','deepslate','dirt','tuff','rotten_flesh'].includes(i.name)||held(state,i.name))continue
          check(t)
          try{await window.deposit(i.type,i.metadata,i.count)}catch(e){errors.push({position:p,error:e.message})}
        }
        for(const [name,needed] of [['fishing_rod',1],['string',2],['stick',3]]){
          if(rod()&&name!=='fishing_rod')break
          const have=count(name),i=window.containerItems().find(i=>i.name===name)
          if(i && have<needed && bot.inventory.emptySlotCount()>0){check(t);await window.withdraw(i.type,i.metadata,Math.min(needed-have,i.count))}
        }
        if(!rod() && count('stick')<3){
          const recipes=bot.recipesAll(bot.registry.itemsByName.stick.id,null,false)
          for(const recipe of recipes){
            const needs=recipe.delta.filter(d=>d.count<0)
            if(recipe.requiresTable||!needs.every(d=>window.containerItems().filter(i=>i.type===d.id).reduce((n,i)=>n+i.count,0)>=-d.count))continue
            for(const d of needs){check(t);await window.withdraw(d.id,null,-d.count)}
            break
          }
        }
        const paired=[]
        const block=bot.blockAt(vec(p)),props=block.getProperties()
        if(['left','right'].includes(props.type))for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const q=vec(p).offset(dx,0,dz),other=bot.blockAt(q),op=other?.getProperties?.()
          const perpendicular=['north','south'].includes(props.facing)?dz===0:dx===0
          if(perpendicular && other?.name===block.name && op.facing===props.facing && ['left','right'].includes(op.type) && op.type!==props.type)paired.push(point(q))
        }
        return {checked:p,paired,ready:ready(),errors}
      }catch(e){check(t);errors.push({position:p,error:e.message});return {checked:p,ready:false,errors}}
      finally{if(window)window.close()}
    }
    if(!rod()){
      if(count('stick')<3){
        const recipes=bot.recipesFor(bot.registry.itemsByName.stick.id,null,1,false)
        if(recipes.length){check(t);await bot.craft(recipes[0],1,null);check(t)}
      }
      const id=bot.registry.itemsByName.fishing_rod.id
      const recipes=bot.recipesFor(id,null,1,true)
      if(recipes.length){
        for(const tablePos of find(['crafting_table'],doc,12)){
          check(t);if(!await preview(tablePos,3,doc))continue
          await go(tablePos,t,doc,3);check(t)
          await bot.craft(recipes[0],1,bot.blockAt(vec(tablePos)));check(t)
          if(rod())return {ready:ready(),crafted:'fishing_rod'}
          throw new Error('rod_craft_unconfirmed')
        }
      }
    }
    throw Object.assign(new Error(rod()?'inventory_storage_unavailable':'fishing_supplies_unavailable'),{detail:{needs:{fishing_rod:rod()?0:1,string:Math.max(0,2-count('string')),stick:Math.max(0,3-count('stick'))},freeSlots:bot.inventory.emptySlotCount(),errors}})
  }
  async function cast(doc,t){
    check(t)
    if(!cell(bot,bot.entity.position,'dry').allowed||body(bot).inWater)throw new Error('unsafe_fishing_position')
    const rod=items().find(i=>i.name==='fishing_rod'&&(!i.maxDurability||i.maxDurability-(i.durabilityUsed||0)>8))
    if(!rod)throw new Error('missing_usable_rod')
    state.holdItemLock='fishing_rod';state.isFishing=true;state.autoLookSuspended=true
    try{
      await bot.equip(rod,'hand');check(t)
      await bot.lookAt(vec(doc.spot.aim),true);check(t)
      const before=fishCount()
      t.cast=true
      let done=false,error=null
      bot.fish().then(()=>{done=true;t.cast=false},e=>{error=e;done=true;t.cast=false})
      const until=Date.now()+65000
      while(!done && Date.now()<until)await wait(100,t)
      check(t)
      if(!done)throw new Error('fish_bite_timeout')
      if(error)throw Object.assign(new Error('cast_interrupted'),{detail:error.message})
      await wait(2200,t) // The reel promise precedes the inventory pickup packet.
      return {caught:Math.min(1,Math.max(0,fishCount()-before)),before,after:fishCount()}
    }finally{
      if(t.cast && bot.heldItem?.name==='fishing_rod'){bot.activateItem();t.cast=false}
      state.holdItemLock=null;state.isFishing=false;state.autoLookSuspended=false
    }
  }
  async function sleep(doc,t){
    if(!['overworld','minecraft:overworld'].includes(bot.game.dimension))throw new Error('unsafe_sleep_dimension')
    const beds=find(bot.registry.blocksArray.filter(b=>b.name.endsWith('_bed')).map(b=>b.name),{...doc,radius:8},20)
    const p=beds.find(p=>distance(bot.entity.position,p)<=3 && bot.blockAt(vec(p))?.getProperties().occupied===false)
    if(!p)throw new Error('home_bed_unavailable')
    check(t)
    const before=new Set(bot.rawListeners('sleep'))
    let entered=false,woke=false,error=null
    const enter=()=>{entered=true},wake=()=>{woke=true}
    bot.on('sleep',enter);bot.on('wake',wake)
    try{
      bot.sleep(bot.blockAt(vec(p))).catch(e=>{error=e})
      const until=Date.now()+30000
      while(Date.now()<until){check(t);if(error)throw Object.assign(new Error('sleep_rejected'),{detail:error.message});if(entered&&woke&&!bot.isSleeping)return {slept:true,bed:p};await wait(100,t)}
      throw new Error('sleep_unconfirmed')
    }finally{
      bot.off('sleep',enter);bot.off('wake',wake)
      for(const f of bot.rawListeners('sleep'))if(!before.has(f)&&typeof f.listener==='function')bot.off('sleep',f)
      if(t.canceled && bot.isSleeping)await bot.wake().catch(()=>{})
    }
  }
  function stop(t){if(t){t.canceled=true;if(t.cast&&bot.heldItem?.name==='fishing_rod'){bot.activateItem();t.cast=false}}travel.stop();if(bot.currentWindow)bot.closeWindow(bot.currentWindow)}
  return {facts,go,chooseSpot,prepare,cast,sleep,stop,wait,fishCount}
}
module.exports={createDriver}
