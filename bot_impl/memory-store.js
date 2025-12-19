const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'ai-memory.json')
const EVOLUTION_FILE = path.join(DATA_DIR, 'ai-evolution.json')

function safeArray (value) {
  return Array.isArray(value) ? value : []
}

function load () {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    if (!raw) return { long: [], memories: [], dialogues: [] }
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return { long: [], memories: [], dialogues: [] }
    }
    return {
      long: safeArray(parsed?.long),
      memories: safeArray(parsed?.memories),
      dialogues: safeArray(parsed?.dialogues)
    }
  } catch {
    return { long: [], memories: [], dialogues: [] }
  }
}

function save (data = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {}
  const payload = {
    version: 3,
    long: safeArray(data.long),
    memories: safeArray(data.memories),
    dialogues: safeArray(data.dialogues)
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload))
  } catch {}
}

// --- REFS: Evolution data persistence ---

function loadEvolution () {
  try {
    const raw = fs.readFileSync(EVOLUTION_FILE, 'utf8')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return {
      personality: parsed?.personality || null,
      emotionalState: parsed?.emotionalState || null,
      feedbackStats: parsed?.feedbackStats || null,
      introspectionHistory: safeArray(parsed?.introspectionHistory),
      lastIntrospection: parsed?.lastIntrospection || null
    }
  } catch {
    return {}
  }
}

function saveEvolution (data = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {}
  const payload = {
    version: 1,
    personality: data.personality || null,
    emotionalState: data.emotionalState || null,
    feedbackStats: data.feedbackStats || null,
    introspectionHistory: safeArray(data.introspectionHistory),
    lastIntrospection: data.lastIntrospection || null,
    savedAt: Date.now()
  }
  try {
    fs.writeFileSync(EVOLUTION_FILE, JSON.stringify(payload, null, 2))
  } catch {}
}

module.exports = {
  load,
  save,
  loadEvolution,
  saveEvolution
}
