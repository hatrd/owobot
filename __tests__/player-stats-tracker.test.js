import test from 'node:test'
import assert from 'node:assert/strict'

import trackerMod from '../bot_impl/player-stats/tracker.js'
import dm from '../bot_impl/player-stats/data-manager.js'

test('player leave log reflects full session totals across periodic flushes', () => {
  const store = new Map()

  const orig = {
    getOrCreatePlayerData: dm.getOrCreatePlayerData,
    savePlayerData: dm.savePlayerData,
    getTodayKey: dm.getTodayKey,
    findPlayerByName: dm.findPlayerByName
  }

  dm.getTodayKey = () => '2099-01-01'
  dm.findPlayerByName = () => null
  dm.getOrCreatePlayerData = (uuid, name) => {
    const now = Date.now()
    const existing = store.get(uuid)
    if (existing) {
      existing.lastKnownName = name
      return existing
    }
    const data = {
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
    store.set(uuid, data)
    return data
  }
  dm.savePlayerData = (uuid, data) => {
    store.set(uuid, data)
  }

  const logs = []
  const log = {
    info: (msg) => logs.push(String(msg)),
    warn: () => {}
  }

  const bot = {
    username: 'Bot',
    players: { Alice: { uuid: 'u1' } }
  }

  const state = { playerStats: { activeSessions: new Map(), lastFlushAt: 0 } }
  const tracker = trackerMod.createTracker(bot, state, log)

  const originalNow = Date.now
  let t = 0
  Date.now = () => t
  try {
    tracker.onPlayerJoin({ username: 'Alice', uuid: 'u1' })
    tracker.onChat('Alice', 'hello') // msg #1

    t = 2 * 60 * 1000
    tracker.flushAll() // persists segment #1, resets segment counters

    tracker.onChat('Alice', 'hi') // msg #2

    t = 5 * 60 * 1000
    tracker.onMessage('Alice died') // death #1
    tracker.onPlayerLeave({ username: 'Alice', uuid: 'u1' })
  } finally {
    Date.now = originalNow
    dm.getOrCreatePlayerData = orig.getOrCreatePlayerData
    dm.savePlayerData = orig.savePlayerData
    dm.getTodayKey = orig.getTodayKey
    dm.findPlayerByName = orig.findPlayerByName
  }

  const leftLine = logs.find((l) => l.includes('[STATS] Player left: Alice'))
  assert.ok(leftLine, 'expected a leave log line for Alice')
  assert.match(leftLine, /online 5m/)
  assert.match(leftLine, /\b2 msgs\b/)
  assert.match(leftLine, /\b1 deaths\b/)

  const data = store.get('u1')
  assert.ok(data)
  assert.equal(Math.floor(data.stats.totalOnlineMs / 60000), 5)
  assert.equal(data.stats.totalMessages, 2)
  assert.equal(data.stats.totalDeaths, 1)
})

