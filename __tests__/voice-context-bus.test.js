import test from 'node:test'
import assert from 'node:assert/strict'

import ctxMod from '../bot_impl/ai-chat/context-bus.js'

const { createContextBus } = ctxMod

test('context bus keeps voice_speak tool success summary', () => {
  const state = { ai: { context: {} } }
  const bus = createContextBus({ state, now: () => 1 })
  bus.pushEvent('tool.intent', 'voice_speak')
  bus.pushTool('tool=voice_speak ok=1 source=preset preset=ciallo')

  const xml = bus.buildXml({ maxEntries: 10, windowSec: 999, includeGaps: false })
  assert.match(xml, /<e t="tool.intent" d="voice_speak"\/>/)
  assert.match(xml, /<b f="tool">tool=voice_speak ok=1 source=preset preset=ciallo<\/b>/)
})
