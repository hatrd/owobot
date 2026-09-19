// Sole upstream adapter: every navigation entrypoint uses the same liquid mechanics.
const upstream = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { fluid, cell } = require('./liquids')
class Movements extends upstream.Movements {
  constructor (bot) {
    super(bot)
    this.liquidMode = 'wade'
    this.liquidCost = 8
    this.maxDropDown = 1
    this.infiniteLiquidDropdownDistance = false
    this.allowParkour = false
    this.exclusionAreasStep.push(block => {
      if (!block?.position) return 1000
      const f = fluid(bot, block)
      if (f.kind === 'lava') return 1000
      if (f.kind === 'water' && !cell(bot, block.position, this.liquidMode).allowed) return 1000
      return 0
    })
  }
  getBlock (...args) {
    const block = super.getBlock(...args)
    if (block.position) {
      const f = fluid(this.bot, block)
      block.liquid = f.kind === 'lava' || (f.kind === 'water' && !block.physical)
    }
    return block
  }
  safeToBreak (block) {
    if (!require('../safety').checkDig(this.bot, block).ok) return false
    return super.safeToBreak(block)
  }
  getNeighbors (node) {
    return super.getNeighbors(node).filter(next => {
      const p = new Vec3(next.x, next.y, next.z)
      if (!cell(this.bot, p, this.liquidMode).allowed) return false
      // A diagonal must not clip a liquid corner the endpoint-only test misses.
      if (next.x !== node.x && next.z !== node.z) {
        for (const q of [new Vec3(next.x, node.y, node.z), new Vec3(node.x, node.y, next.z)]) {
          if (!cell(this.bot, q, this.liquidMode).allowed) return false
        }
      }
      return true
    })
  }
}
module.exports = { ...upstream, Movements }
