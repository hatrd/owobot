const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'ai-people.json')

function safeArray (value) {
  return Array.isArray(value) ? value : []
}

function safeObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function load () {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    if (!raw) return { profiles: {}, commitments: [] }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { profiles: {}, commitments: [] }
    }
    return {
      profiles: safeObject(parsed.profiles),
      commitments: safeArray(parsed.commitments)
    }
  } catch {
    return { profiles: {}, commitments: [] }
  }
}

function save (data = {}) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
  const payload = {
    version: 1,
    profiles: safeObject(data.profiles),
    commitments: safeArray(data.commitments)
  }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(payload)) } catch {}
}

module.exports = {
  DATA_FILE,
  load,
  save
}

