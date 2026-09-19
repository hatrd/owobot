const test = require('node:test'), assert = require('node:assert/strict')
const { held } = require('../bot_impl/inventory-reservations')
const { validRecord } = require('../bot_impl/memory/contract')
const record = { id: 'task:hold', kind: 'task', subject: 'mission', fact: 'Keep output', source: 'executor', confidence: 'observed', inventoryHold: ['diamond'] }
test('persistent task holds protect only explicit items and honor expiry', () => {
  assert.equal(validRecord(record), true)
  const state = { knowledge: { document: { records: [{ ...record }] } } }
  assert.equal(held(state, 'diamond'), true)
  assert.equal(held(state, 'stone'), false)
  state.knowledge.document.records[0].expiresAt = 10
  assert.equal(held(state, 'diamond', 11), false)
  state.knowledge.error = 'corrupt'
  assert.equal(held(state, 'stone'), true)
})
test('free-form descriptions do not create implicit inventory reservations', () => {
  assert.equal(held({ knowledge: { document: { records: [{ ...record, fact: 'reserve stone', inventoryHold: [] }] } } }, 'stone'), false)
  assert.equal(validRecord({ ...record, inventoryHold: ['diamond', 'diamond'] }), false)
})
