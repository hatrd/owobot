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

