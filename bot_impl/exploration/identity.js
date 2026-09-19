const {createHash}=require('crypto')
// Connection config exists before login; bot.username and socket fields may not.
function worldIdentity(bot,env=process.env){
  const c=bot.connectionIdentity || {host:env.MC_HOST,port:env.MC_PORT,username:env.MC_USERNAME}
  if(!env.MCBOT_WORLD_ID && (!c.host||!c.username))throw new Error('world_identity_requires_connection_config')
  const identity=env.MCBOT_WORLD_ID || `${c.host}:${c.port||25565}:${c.username}`
  return createHash('sha256').update(identity).digest('hex').slice(0,24)
}
module.exports={worldIdentity}
