#!/usr/bin/env node
// A replayable external controller example. Planning stays outside the bot.
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto')
const {call}=require('./controller-client')
const {session,checked,makeBehavior}=require('./cerebellum')
const directions={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}
async function main(){
 const flags=Object.fromEntries(process.argv.slice(2).filter(v=>v.startsWith('--')).map(v=>v.slice(2).split('=')))
 const heading=directions[flags.direction||'north'];if(!heading)throw Error('invalid_direction')
 const steps=Number(flags.steps||16),floor=Number(flags.floor||-54)
 if(!Number.isInteger(steps)||steps<1||steps>80||!Number.isInteger(floor)||floor< -60||floor>300)throw Error('invalid_limits')
 const observe=async()=>checked(await call('observe',{what:'excavation',radius:32,max:16})).data
 let snapshot=await observe()
 const target={x:Math.floor(snapshot.position.x)+heading[0],y:Math.max(floor,Math.floor(snapshot.position.y)-1),z:Math.floor(snapshot.position.z)+heading[1]}
 checked(await call('behavior.validate',{behavior:makeBehavior('tunnel_step',target,20000)}))
 if(Object.hasOwn(flags,'dry')){console.log(JSON.stringify({ok:true,dry:true,firstTarget:target,steps,floor,freeSlots:snapshot.freeSlots,diamonds:snapshot.inventory.filter(i=>i.name==='diamond').reduce((n,i)=>n+i.count,0)}));return}
 const world=checked(await call('knowledge.query',{kind:'home',max:1})).worldId
 const file=path.resolve('data',`diamond-expedition-${world}.json`)
 let doc={version:1,world,revision:0,phase:'prepared',route:[],diamonds:0}
 if(fs.existsSync(file)){doc=JSON.parse(fs.readFileSync(file,'utf8'));if(doc.world!==world)throw Error('world_mismatch')}
 const save=()=>{doc.revision++;doc.updatedAt=Date.now();fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(doc));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
 let s=await session('diamond-expedition'),actions=0
 const stop=()=>s.close().finally(()=>process.exit(130));process.once('SIGINT',stop);process.once('SIGTERM',stop)
 try{
  for(let i=0;i<steps;i++){
   if(actions>=85){await s.close();s=await session('diamond-expedition');actions=0}
   snapshot=await observe()
   if(snapshot.vitals.health<16||snapshot.vitals.food<10)throw Error('unsafe_vitals')
   if(snapshot.freeSlots<4){for(const item of ['stone','deepslate','cobblestone','cobbled_deepslate','granite','diorite','andesite','tuff']){if(!snapshot.inventory.some(it=>it.name===item&&it.count>32))continue;const discarded=await s.action('discard',{item,keep:32});actions++;if(!discarded.ok)throw Error(discarded.task.reason)}snapshot=await observe()}
   if(snapshot.freeSlots<2)throw Error('inventory_reserve_required')
   const from={x:Math.floor(snapshot.position.x),y:Math.floor(snapshot.position.y),z:Math.floor(snapshot.position.z)}
   const target={x:from.x+heading[0],y:Math.max(floor,from.y-1),z:from.z+heading[1]}
   doc.phase='executing';doc.intent={action:'tunnel_step',from,target};save()
   const result=await s.action('tunnel_step',target,20000);actions++
   snapshot=await observe()
   doc.diamonds=snapshot.inventory.filter(i=>i.name==='diamond').reduce((n,it)=>n+it.count,0)
   doc.position=snapshot.position;doc.lastResult=result;doc.phase=result.ok?'checkpoint':'needs_plan'
   if(result.ok){doc.route.push({from,target});await s.write('knowledge.put',{id:`route:diamond:${doc.route.length}`,kind:'route',subject:'diamond-expedition',dimension:snapshot.dimension,position:target,radius:0,fact:JSON.stringify({from,target,status:'arrived',diamonds:doc.diamonds}),source:'controller.tunnel_step+observe.excavation',confidence:'observed'})}
   save();console.log(JSON.stringify({step:i+1,position:snapshot.position,ok:result.ok,reason:result.task.reason,diamonds:doc.diamonds,ores:snapshot.ores,...(!result.ok?{detail:result.task.lastResult}:{})}))
   if(!result.ok)break
  }
 }finally{await s.close();process.off('SIGINT',stop);process.off('SIGTERM',stop)}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,detail:e.result}));process.exitCode=1})
