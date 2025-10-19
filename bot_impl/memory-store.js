const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'ai-memory.json')

function safeArray (value) {
  return Array.isArray(value) ? value : []
}

function load () {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    if (!raw) return { long: [], memories: [] }
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return { long: [], memories: [] }
    }
    return {
      long: safeArray(parsed?.long),
      memories: safeArray(parsed?.memories)
    }
  } catch {
    return { long: [], memories: [] }
  }
}

function save (data = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {}
  const payload = {
    version: 2,
    long: safeArray(data.long),
    memories: safeArray(data.memories)
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload))
  } catch {}
}

module.exports = {
  load,
  save
}
