const test=require('node:test'),assert=require('node:assert/strict')
const {worldIdentity}=require('../bot_impl/exploration/identity')
test('world identity is stable before and after login and uses CLI connection configuration',()=>{
  const config={host:'example.test',port:25565,username:'bot'}
  const early=worldIdentity({connectionIdentity:config},{})
  assert.equal(early,worldIdentity({connectionIdentity:config,username:'bot'},{}))
  assert.equal(early,worldIdentity({connectionIdentity:config},{MC_HOST:'wrong',MC_USERNAME:'wrong'}))
  assert.equal(early,worldIdentity({},{MC_HOST:'example.test',MC_PORT:'25565',MC_USERNAME:'bot'}))
  assert.throws(()=>worldIdentity({},{}),/connection_config/)
  assert.notEqual(early,worldIdentity({connectionIdentity:{...config,host:'another.test'}},{}))
})
