const mineflayer = require('mineflayer')
const readline = require('readline')

const options = {
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT),
  username: process.env.MC_USERNAME,
  auth: process.env.MC_AUTH || 'offline'
}

if (process.env.MC_PASSWORD) {
  options.password = process.env.MC_PASSWORD
}

const bot = mineflayer.createBot(options)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

let fireWatcher = null
let extinguishing = false
const pendingGreets = new Map()
const greetedPlayers = new Set()
let readyForGreeting = false

bot.on('message', (message) => {
  const rendered = typeof message.toAnsi === 'function' ? message.toAnsi() : message.toString()
  console.log(rendered)
})

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  bot.chat(trimmed)
})

bot.once('spawn', () => {
  console.log(`Connected to ${bot._client.socketServerHost || options.host}:${options.port} as ${bot.username}`)
  console.log('Type chat messages or commands here (e.g. /login <password>)')
  greetedPlayers.clear()
  for (const timeout of pendingGreets.values()) {
    clearTimeout(timeout)
  }
  pendingGreets.clear()

  for (const username of Object.keys(bot.players)) {
    if (username && username !== bot.username) {
      greetedPlayers.add(username)
    }
  }

  readyForGreeting = true

  fireWatcher = setInterval(() => {
    extinguishNearbyFire().catch((err) => {
      console.log('Fire watcher error:', err.message || err)
    })
  }, 1500)
})

bot.on('playerJoined', (player) => {
  const username = resolvePlayerUsername(player)
  if (!username) return
  if (username === bot.username) return
  if (!readyForGreeting) return
  if (greetedPlayers.has(username)) return
  if (pendingGreets.has(username)) return

  const timeout = setTimeout(() => {
    pendingGreets.delete(username)
    const tracked = bot.players[username]
    if (!tracked?.entity) return

    const message = buildGreeting(username)
    bot.chat(message)
    greetedPlayers.add(username)
  }, 2000)

  pendingGreets.set(username, timeout)
})

bot.on('playerLeft', (player) => {
  const username = resolvePlayerUsername(player)
  if (!username) return
  greetedPlayers.delete(username)
  const timeout = pendingGreets.get(username)
  if (timeout) {
    clearTimeout(timeout)
    pendingGreets.delete(username)
  }
})

bot.on('end', () => {
  console.log('Bot connection closed')
  if (fireWatcher) clearInterval(fireWatcher)
  for (const timeout of pendingGreets.values()) {
    clearTimeout(timeout)
  }
  pendingGreets.clear()
  greetedPlayers.clear()
  readyForGreeting = false
  rl.close()
})

bot.on('kicked', (reason) => {
  console.log('Kicked:', reason)
})

bot.on('error', (err) => {
  console.error('Error:', err)
})

process.on('SIGINT', () => {
  console.log('Shutting down bot...')
  for (const timeout of pendingGreets.values()) {
    clearTimeout(timeout)
  }
  pendingGreets.clear()
  greetedPlayers.clear()
  readyForGreeting = false
  rl.close()
  bot.end('Interrupt received')
})

async function extinguishNearbyFire () {
  if (extinguishing || bot.targetDigBlock) return

  const fireBlock = bot.findBlock({
    matching: (block) => block && block.name === 'fire',
    maxDistance: 6
  })

  if (!fireBlock) return

  extinguishing = true

  try {
    await bot.lookAt(fireBlock.position.offset(0.5, 0.5, 0.5), true)
    await bot.dig(fireBlock)
    console.log(`Extinguished fire at ${fireBlock.position}`)
  } catch (err) {
    if (err?.message === 'Block is not currently diggable') return
    console.log('Failed to extinguish fire:', err.message || err)
  } finally {
    extinguishing = false
  }
}

function buildGreeting (username) {
  const now = new Date()
  const hour = now.getHours()

  let salutation
  if (hour >= 5 && hour < 11) salutation = '早上好呀'
  else if (hour >= 11 && hour < 14) salutation = '午安午安~'
  else if (hour >= 14 && hour < 18) salutation = '下午好喔'
  else if (hour >= 18 && hour < 23) salutation = '晚上好呀'
  else salutation = '深夜好喔'

  const suffix = '☆ (≧▽≦)ﾉ'

  return `${salutation} ${username}酱~ 这里是${bot.username}，${suffix}`
}

function resolvePlayerUsername (player) {
  if (!player) return null
  if (typeof player === 'string') return player
  if (player.username && typeof player.username === 'string') return player.username
  if (player.name && typeof player.name === 'string') return player.name
  if (player.profile?.name && typeof player.profile.name === 'string') return player.profile.name
  if (player.uuid && bot.players) {
    const match = Object.values(bot.players).find((entry) => entry?.uuid === player.uuid && typeof entry.username === 'string')
    if (match?.username) return match.username
  }
  if (typeof player.displayName?.toString === 'function') {
    const rendered = player.displayName.toString().trim()
    if (rendered) {
      const sanitized = rendered.replace(/\u00a7./g, '').trim()
      return sanitized || rendered
    }
  }
  if (player.entity?.username && typeof player.entity.username === 'string') return player.entity.username
  return null
}
