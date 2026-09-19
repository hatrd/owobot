const edible = ['cod', 'salmon']
const distance = (a,b) => a && b ? Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z) : Infinity
const night = f => f.timeOfDay >= 12500 && f.timeOfDay < 23500
// Priority is explicit facts, never a classifier over logs or exception messages.
function decide (doc, f, now) {
  if (!f.ready) return 'wait_connection'
  if (f.dimension !== doc.home.dimension) return 'wrong_dimension'
  if (f.health <= 0) return 'dead'
  if (f.damageAt > (doc.recoveredAt || 0) || f.health < 18 || f.hostiles > 0 || f.inWater) return distance(f.position,doc.home)>1.5 ? 'retreat' : 'recover'
  if (night(f)) return distance(f.position,doc.home)>1.5 ? 'return_for_sleep' : 'sleep'
  if (doc.failure) return distance(f.position,doc.home)>1.5 ? 'return_failed' : 'report_failed'
  if (doc.caught >= doc.count) return distance(f.position,doc.home)>1.5 ? 'return_complete' : 'verify'
  if (f.food < 16 || f.eating) return 'eat'
  if (f.freeSlots < 2 || !f.rod) return 'prepare'
  if (!doc.spot) return 'choose_spot'
  if (distance(f.position,doc.spot.stand)>0.8) return 'travel'
  return 'cast'
}
module.exports={edible,distance,night,decide}
