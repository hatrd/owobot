function ensureMcData (bot) {
  try {
    if (!bot) return null
    if (bot.mcData) return bot.mcData
    const mcData = require('minecraft-data')(bot.version)
    bot.mcData = mcData
    return mcData
  } catch {
    return null
  }
}

module.exports = { ensureMcData }

