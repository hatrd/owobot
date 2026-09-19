const fs=require('fs'), path=require('path'), {randomUUID}=require('crypto')
function createStore(state,worldId,file){
  const s=state.fishing ||= {document:null,error:null,runtime:null}
  if(!s.document){
    s.document={version:1,worldId,status:'idle',events:[]}
    try{
      if(fs.statSync(file).size>256*1024)throw new Error('fishing_file_too_large')
      const d=JSON.parse(fs.readFileSync(file,'utf8'))
      if(d.version!==1||d.worldId!==worldId||!['idle','running','paused','blocked','succeeded','canceled'].includes(d.status)||!Array.isArray(d.events))throw new Error('invalid_fishing_document')
      if(d.status!=='idle' && (!require('./contract').validate('start',{count:d.count,radius:d.radius,home:{x:d.home?.x,y:d.home?.y,z:d.home?.z}}).ok||!Number.isInteger(d.caught)||d.caught<0||!Number.isFinite(d.baseline)))throw new Error('invalid_fishing_goal')
      s.document=d
    }catch(e){if(e.code!=='ENOENT')s.error=e.message}
  }
  if(s.document.worldId!==worldId)s.error='fishing_world_mismatch'
  function save(edit){
    if(s.error)throw new Error(s.error)
    const d=JSON.parse(JSON.stringify(s.document));edit(d);d.savedAt=Date.now();d.events=d.events.slice(-100)
    const tmp=file+'.'+randomUUID()+'.tmp'
    try { fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(d));fs.fsyncSync(fd)}finally{fs.closeSync(fd)};fs.renameSync(tmp,file);s.document=d }
    catch(e){s.error=e.message;try{fs.unlinkSync(tmp)}catch{};throw e}
    return d
  }
  return {get:()=>s.document,save,error:()=>s.error}
}
module.exports={createStore}
