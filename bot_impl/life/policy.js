const { distance } = require('../exploration/terrain')
// Decisions consume structured Minecraft facts only. This function has no side effects.
function decide (doc, facts, now) {
  const wait = reason => ({ activity: 'waiting', reason })
  if (!doc.enabled) return wait('disabled')
  if (!facts.position) return wait('not_spawned')
  if (!doc.home) return wait('home_required')
  if (facts.dimension !== doc.home.dimension) return wait('home_dimension_mismatch')
  if (!Number.isFinite(facts.health) || !Number.isFinite(facts.food) || facts.health < 16 || facts.food < 10 || facts.recovering) return wait('survival_priority')
  if (facts.busy) return wait('manual_or_external_control')
  if (!Number.isFinite(facts.timeOfDay)) return wait('time_unavailable')
  if (distance(facts.position, doc.home) > doc.maxRadius + 8) return wait('outside_home_area')
  const night = facts.timeOfDay >= 12000
  const atHome = distance(facts.position, doc.home) <= 2
  if (night || facts.thunder || facts.hostiles > 0) return atHome ? { activity: 'resting', reason: night ? 'night_at_home' : 'sheltering' } : { activity: 'returning', reason: night ? 'nightfall' : 'shelter', target: { x: doc.home.x, y: doc.home.y, z: doc.home.z } }
  if (distance(facts.position, doc.home) > doc.maxRadius) return { activity: 'returning', reason: 'home_boundary', target: { x: doc.home.x, y: doc.home.y, z: doc.home.z } }
  const lastAttempt = doc.feedAttempts.at(-1)?.at
  if (facts.fish && (lastAttempt == null || now - lastAttempt >= 60000)) {
    const cat = facts.cats.find(c => c.uuid && distance(c.position, doc.home) <= doc.maxRadius && !doc.feedAttempts.some(a => a.uuid === c.uuid && now - a.at < doc.feedCooldownMs))
    if (cat) return { activity: 'feeding', reason: 'cat_visit_due', target: cat.position, catUuid: cat.uuid }
  }
  const candidates = facts.candidates.filter(c => !c.recentFailure && distance(c.position, doc.home) <= doc.maxRadius && !doc.failures.some(f => f.dimension === facts.dimension && now - f.at < 300000 && distance(f.position, c.position) < 3))
  const visits = c => doc.visits.filter(v => v.dimension === facts.dimension && distance(v.position, c.position) < 3).length
  candidates.sort((a, b) => visits(a) - visits(b) || b.distance - a.distance)
  return candidates.length ? { activity: 'wandering', reason: 'daytime_exploration', target: candidates[0].position } : wait('no_safe_route')
}
module.exports = { decide }
