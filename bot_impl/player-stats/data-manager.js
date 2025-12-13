const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(process.cwd(), 'data', 'player_stats')
const DAILY_STARS_FILE = path.join(DATA_DIR, 'daily_stars.json')

function ensureDataDir () {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

function getPlayerFilePath (uuid) {
  return path.join(DATA_DIR, `${uuid}.json`)
}

function loadPlayerData (uuid) {
  try {
    const filePath = getPlayerFilePath(uuid)
    const text = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(text)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function savePlayerData (uuid, data) {
  ensureDataDir()
  const filePath = getPlayerFilePath(uuid)
  const tmpPath = filePath + '.tmp'
  const content = JSON.stringify(data, null, 2)
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

function createEmptyPlayerData (uuid, name) {
  const now = Date.now()
  return {
    version: 1,
    uuid,
    lastKnownName: name,
    nameHistory: [{ name, firstSeen: now }],
    stats: {
      totalOnlineMs: 0,
      totalMessages: 0,
      totalDeaths: 0,
      firstSeen: now,
      lastSeen: now
    },
    daily: {},
    achievements: []
  }
}

function getOrCreatePlayerData (uuid, name) {
  let data = loadPlayerData(uuid)
  if (!data) {
    data = createEmptyPlayerData(uuid, name)
    savePlayerData(uuid, data)
  } else if (data.lastKnownName !== name) {
    // Player renamed
    if (!data.nameHistory) data.nameHistory = []
    const existing = data.nameHistory.find(h => h.name === name)
    if (!existing) {
      data.nameHistory.push({ name, firstSeen: Date.now() })
    }
    data.lastKnownName = name
    savePlayerData(uuid, data)
  }
  return data
}

function loadDailyStars () {
  try {
    const text = fs.readFileSync(DAILY_STARS_FILE, 'utf8')
    return JSON.parse(text)
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, stars: [] }
    throw err
  }
}

function saveDailyStars (data) {
  ensureDataDir()
  const tmpPath = DAILY_STARS_FILE + '.tmp'
  const content = JSON.stringify(data, null, 2)
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, DAILY_STARS_FILE)
}

function listAllPlayerUUIDs () {
  try {
    ensureDataDir()
    const files = fs.readdirSync(DATA_DIR)
    return files
      .filter(f => f.endsWith('.json') && f !== 'daily_stars.json')
      .map(f => f.replace('.json', ''))
  } catch {
    return []
  }
}

function findPlayerByName (name) {
  const lowerName = String(name || '').toLowerCase()
  if (!lowerName) return null
  const uuids = listAllPlayerUUIDs()
  for (const uuid of uuids) {
    try {
      const data = loadPlayerData(uuid)
      if (data && String(data.lastKnownName || '').toLowerCase() === lowerName) {
        return data
      }
    } catch {}
  }
  return null
}

function getAllPlayersData () {
  const uuids = listAllPlayerUUIDs()
  const players = []
  for (const uuid of uuids) {
    try {
      const data = loadPlayerData(uuid)
      if (data) players.push(data)
    } catch {}
  }
  return players
}

function getTodayKey () {
  const now = new Date()
  // Asia/Shanghai timezone offset is +8 hours
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const shanghai = new Date(utc + 8 * 3600000)
  const y = shanghai.getFullYear()
  const m = String(shanghai.getMonth() + 1).padStart(2, '0')
  const d = String(shanghai.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getYesterdayKey () {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const shanghai = new Date(utc + 8 * 3600000 - 24 * 3600000)
  const y = shanghai.getFullYear()
  const m = String(shanghai.getMonth() + 1).padStart(2, '0')
  const d = String(shanghai.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

module.exports = {
  ensureDataDir,
  loadPlayerData,
  savePlayerData,
  createEmptyPlayerData,
  getOrCreatePlayerData,
  loadDailyStars,
  saveDailyStars,
  listAllPlayerUUIDs,
  findPlayerByName,
  getAllPlayersData,
  getTodayKey,
  getYesterdayKey,
  DATA_DIR,
  DAILY_STARS_FILE
}
