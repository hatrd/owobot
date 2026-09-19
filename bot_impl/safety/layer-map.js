const { Vec3 } = require('vec3')
const { fluid, fullSupport } = require('../navigation/liquids')
function read (bot, args={}) {
  const radius=Math.max(1,Math.min(32,Math.floor(Number(args.radius)||16)))
  const center=bot.entity.position.floored()
  const y=Number.isInteger(args.y)?args.y:center.y-1
  const x0=center.x-radius,z0=center.z-radius
  const rows=[]
  for(let z=z0;z<=center.z+radius;z++){
    let row=''
    for(let x=x0;x<=center.x+radius;x++){
      const b=bot.blockAt(new Vec3(x,y,z),false),f=fluid(bot,b)
      row+=f.kind==='unknown'?'?':f.kind==='lava'?'!':f.kind==='water'?'~':fullSupport(b)?'#':b.boundingBox==='empty'?'.':'+'
    }
    rows.push(row)
  }
  return {ok:true,msg:'Read-only horizontal block layer; not a path guarantee',data:{x0,z0,y,width:2*radius+1,rows,legend:{'#':'full support','~':'water','!':'lava','.':'empty bounding box','+':'partial collision','?':'unloaded'},center,dimension:bot.game.dimension}}
}
module.exports={read}
