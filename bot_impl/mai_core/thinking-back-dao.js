'use strict'

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'thinking-back.json')

function safeArray (value) {
  return Array.isArray(value) ? value : []
}

function loadRecords () {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return safeArray(parsed.records)
  } catch {
    return []
  }
}

function saveRecords (records) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, records: safeArray(records) }, null, 2))
  } catch {}
}

function createThinkingBackDao () {
  let records = loadRecords()

  function persist () {
    saveRecords(records)
  }

  return {
    async fetchRecent (chatId, limit = 5) {
      return records
        .filter(item => item.chatId === chatId)
        .sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0))
        .slice(0, limit)
    },
    async findByQuestion (chatId, question) {
      const target = records
        .filter(item => item.chatId === chatId && item.question === question)
        .sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0))[0]
      return target || null
    },
    async insert (record) {
      records.push(record)
      persist()
      return record
    },
    async update (id, updates) {
      const idx = records.findIndex(item => item.id === id)
      if (idx === -1) return null
      records[idx] = { ...records[idx], ...updates }
      persist()
      return records[idx]
    }
  }
}

module.exports = { createThinkingBackDao }

