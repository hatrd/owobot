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

test('context bus honors explicit zero maxEntries', () => {
  const state = { ai: { context: {} } }
  const bus = createContextBus({ state, now: () => 1 })
  bus.pushPlayer('Alice', '这条不应注入')
  bus.pushBotFrom('这条也不应注入', 'LLM')
  const xml = bus.buildXml({ maxEntries: 0, windowSec: 999, includeGaps: false })
  assert.equal(xml, '')
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

test('context bus drops minimalSelf.score events', () => {
  const state = { ai: { context: {} } }
  const bus = createContextBus({ state, now: () => 1 })
  bus.pushEvent('minimalSelf.score', 'reset:1.07')
  assert.equal(bus.getStore().length, 0)
  const xml = bus.buildXml({ maxEntries: 10, windowSec: 999, includeGaps: false })
  assert.equal(xml, '')
})

test('context bus default XML view caps repeated bot/tool echoes while keeping player context', () => {
  const state = { ai: { context: {} } }
  let now = 1
  const bus = createContextBus({ state, now: () => now })

  for (let i = 0; i < 10; i++) {
    bus.pushPlayer('Alice', `玩家问题 ${i}`)
    bus.pushBotFrom(`机器人长回复 ${i} ${'x'.repeat(180)}`, 'LLM')
    bus.pushTool(`observe_detail result ${i} ${'y'.repeat(180)}`)
    now += 1000
  }

  const xml = bus.buildXml({ maxEntries: 50, windowSec: 999, includeGaps: false })
  const playerLines = xml.match(/<p n="Alice">/g) || []
  const botLines = xml.match(/<b f="LLM">/g) || []
  const toolLines = xml.match(/<b f="tool">/g) || []

  assert.equal(playerLines.length, 10)
  assert.ok(botLines.length <= 3, `expected at most 3 bot echoes, got ${botLines.length}`)
  assert.ok(toolLines.length <= 3, `expected at most 3 tool echoes, got ${toolLines.length}`)
  assert.ok(xml.length < 1800, `expected compact context XML, got ${xml.length} chars`)
})

test('context bus XML view truncates long player turns without mutating raw store', () => {
  const state = { ai: { context: {} } }
  const bus = createContextBus({ state, now: () => 1 })
  const longText = `请帮我看一下 ${'非常长的上下文 '.repeat(40)}最后一句要保留在原始记录里`

  bus.pushPlayer('Alice', longText)
  const raw = bus.getStore()[0]?.payload?.content
  const xml = bus.buildXml({ maxEntries: 10, windowSec: 999, includeGaps: false })

  assert.equal(raw, longText.slice(0, 200))
  assert.match(xml, /…/)
  assert.ok(xml.length < raw.length + 120, `expected XML view to be compact, got ${xml.length} chars`)
})
