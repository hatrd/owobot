import test from 'node:test'
import assert from 'node:assert/strict'
import ctxMod from '../bot_impl/ai-chat/context-bus.js'

const { createContextBus } = ctxMod

test('context bus serializes internal bot chat without f attribute', () => {
  const state = { ai: { context: {} } }
  const bus = createContextBus({ state, now: () => 1 })
  bus.pushBot('收到')
  const xml = bus.buildXml({ maxEntries: 10, windowSec: 999, includeGaps: false })
  assert.match(xml, /<b>收到<\/b>/)
  assert.doesNotMatch(xml, /<b f="/)
})

test('context bus serializes LLM bot chat with f="LLM"', () => {
  const state = { ai: { context: {} } }
  const bus = createContextBus({ state, now: () => 1 })
  bus.pushBotFrom('好呀', 'LLM')
  const xml = bus.buildXml({ maxEntries: 10, windowSec: 999, includeGaps: false })
  assert.match(xml, /<b f="LLM">好呀<\/b>/)
})

test('context bus injects a single gap marker for inactivity >= threshold', () => {
  const state = { ai: { context: {} } }
  let now = 0
  const bus = createContextBus({ state, now: () => now })
  bus.pushServer('first')
  now += 6 * 60 * 1000 // 6 minutes later
  bus.pushServer('second')
  const xml = bus.buildXml({ maxEntries: 10, windowSec: 24 * 60 * 60, gapThresholdMs: 5 * 60 * 1000 })
  const gapMatches = xml.match(/<g d="6m"\/>/g) || []
  assert.equal(gapMatches.length, 1)
})

test('hurt events merge and sum damage within short window', () => {
  const state = { ai: { context: {} } }
  let now = 0
  const bus = createContextBus({ state, now: () => now })
  bus.pushEvent('hurt.combat', 'Rilishuibin:-1.1')
  now += 1000
  bus.pushEvent('hurt.combat', 'Rilishuibin:-0.5')
  now += 1000
  bus.pushEvent('hurt.combat', 'Rilishuibin:-0.3x2')
  const store = bus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].payload.data, 'Rilishuibin:-2.2')
})

test('hurt events still merge when spaced beyond base window', () => {
  const state = { ai: { context: {} } }
  let now = 0
  const bus = createContextBus({ state, now: () => now })
  bus.pushEvent('hurt.combat', 'zombie:-0.4')
  now += 10 * 1000
  bus.pushEvent('hurt.combat', 'zombie:-0.6')
  const store = bus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].payload.data, 'zombie:-1')
})

test('heal events merge into a single total', () => {
  const state = { ai: { context: {} } }
  let now = 0
  const bus = createContextBus({ state, now: () => now })
  bus.pushEvent('heal', 'hp:+1')
  now += 1500
  bus.pushEvent('heal', 'hp:+0.6x2')
  now += 1500
  bus.pushEvent('heal', 'hp:+1')
  const store = bus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].payload.data, 'hp:+3.2')
})

test('pickup events stack adjacent entries even when not instantaneous', () => {
  const state = { ai: { context: {} } }
  let now = 0
  const bus = createContextBus({ state, now: () => now })
  bus.pushEvent('pickup', 'sea_lantern x3')
  now += 12 * 1000
  bus.pushEvent('pickup', 'sea_lantern x4')
  const store = bus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].payload.data, 'sea_lanternx7')
})

test('server messages stack identical lines within window', () => {
  const state = { ai: { context: {} } }
  let now = 0
  const bus = createContextBus({ state, now: () => now })
  bus.pushServer('1/2 players sleeping')
  now += 1000
  bus.pushServer('1/2 players sleeping')
  now += 1000
  bus.pushServer('1/2 players sleeping')
  const store = bus.getStore()
  assert.equal(store.length, 1)
  assert.equal(store[0].payload.content, '1/2 players sleeping x3')
})
