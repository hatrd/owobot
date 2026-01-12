function ensurePathfinder (bot) {
  try {
    if (!bot) return null
    const pkg = require('mineflayer-pathfinder')
    if (!bot.pathfinder) bot.loadPlugin(pkg.pathfinder)
    return pkg
  } catch {
    return null
  }
}

module.exports = { ensurePathfinder }

