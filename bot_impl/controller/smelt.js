const {Vec3}=require('vec3')
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function smelt(bot,state,args,cancel){
  const p=new Vec3(args.x,args.y,args.z),block=bot.blockAt(p,false)
  const receipt=state.smelting={position:{x:args.x,y:args.y,z:args.z},input:args.input,output:args.output,count:args.count,fuel:args.fuel,fuelCount:args.fuelCount,phase:'checking',at:Date.now()}
  const fail=error=>{receipt.phase='failed';receipt.error=error;return {ok:false,error,data:{...receipt}}}
  if(cancel.canceled)return fail('canceled')
  if(!block||!['furnace','blast_furnace','smoker'].includes(block.name))return fail('furnace_required')
  if(bot.entity.position.distanceTo(p.offset(0.5,0.5,0.5))>4.5)return fail('furnace_out_of_reach')
  if(bot.currentWindow)return fail('window_busy')
  const items=bot.inventory.items(),input=items.find(i=>i.name===args.input),fuel=items.find(i=>i.name===args.fuel)
  if(!input||!fuel||items.filter(i=>i.name===args.input).reduce((n,i)=>n+i.count,0)<args.count||items.filter(i=>i.name===args.fuel).reduce((n,i)=>n+i.count,0)<args.fuelCount)return fail('insufficient_materials')
  const beforeOutput=items.filter(i=>i.name===args.output).reduce((n,i)=>n+i.count,0)
  let furnace
  try{
    receipt.phase='opening';furnace=await bot.openFurnace(block)
    if(cancel.canceled)return fail('canceled')
    if(furnace.inputItem()||furnace.fuelItem()||furnace.outputItem())return fail('furnace_not_empty')
    receipt.phase='input';await furnace.putInput(input.type,input.metadata,args.count)
    if(cancel.canceled)return fail('canceled')
    receipt.phase='fuel';await furnace.putFuel(fuel.type,fuel.metadata,args.fuelCount)
    receipt.phase='smelting'
    while(!cancel.canceled){
      const output=furnace.outputItem()
      receipt.produced=output?.count || 0;receipt.progress=furnace.progress
      if(output&&output.name!==args.output)return fail('unexpected_smelting_output')
      if(output?.count>=args.count){
        receipt.phase='collecting';await furnace.takeOutput()
        const owned=()=>furnace.slots.slice(furnace.inventoryStart,furnace.inventoryEnd).filter(i=>i?.name===args.output).reduce((n,i)=>n+i.count,0)
        const until=Date.now()+2000
        while(!cancel.canceled&&owned()-beforeOutput<args.count&&Date.now()<until)await wait(50)
        receipt.collected=owned()-beforeOutput
        if(receipt.collected<args.count)return fail('smelt_collection_unconfirmed')
        receipt.phase='confirmed';return {ok:true,data:{...receipt}}
      }
      if(Date.now()-receipt.at>120000)return fail('smelting_timeout')
      await wait(200)
    }
    return fail('canceled')
  }catch(e){return fail(e.message)}finally{try{furnace?.close()}catch{}}
}
module.exports={smelt}
