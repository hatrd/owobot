const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto')
const {validate}=require('./contract')
function createStore(state,worldId,file){
  const s=state.stash ||= {document:null,error:null,runtime:null}
  if(!s.document){
    s.document={version:1,worldId,config:{radius:64,foodReserve:64,keep:{},routes:[],overflow:null},storageDimension:null,catalog:[],goal:null}
    try{
      if(fs.statSync(file).size>1024*1024)throw new Error('stash_file_too_large')
      const d=JSON.parse(fs.readFileSync(file,'utf8'))
      if(d.version!==1||d.worldId!==worldId||!validate('configure',d.config).ok||!Array.isArray(d.catalog)||d.catalog.length>128)throw new Error('invalid_stash_document')
      if(d.goal&&(!['running','succeeded','partial','blocked','paused','canceled'].includes(d.goal.status)||!['x','y','z'].every(k=>Number.isFinite(d.goal.home?.[k]))||!Array.isArray(d.goal.receipts)))throw new Error('invalid_stash_goal')
      s.document=d
    }catch(e){if(e.code!=='ENOENT')s.error=e.message}
  }
  if(s.document.worldId!==worldId)s.error='stash_world_mismatch'
  function save(edit){
    if(s.error)throw new Error(s.error)
    const d=JSON.parse(JSON.stringify(s.document));edit(d);d.savedAt=Date.now()
    if(d.goal?.receipts.length>1024)throw new Error('stash_receipt_limit')
    const tmp=file+'.'+randomUUID()+'.tmp'
    try{fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(d));fs.fsyncSync(fd)}finally{fs.closeSync(fd)};fs.renameSync(tmp,file);s.document=d}
    catch(e){s.error=e.message;try{fs.unlinkSync(tmp)}catch{};throw e}
    return d
  }
  return {get:()=>s.document,save,error:()=>s.error}
}
module.exports={createStore}
