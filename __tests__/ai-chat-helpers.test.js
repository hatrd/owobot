import test from 'node:test'
import assert from 'node:assert/strict'
import { estTokensFromText, trimReply, buildContextPrompt, projectedCostForCall, canAfford } from '../bot_impl/ai-chat-helpers.js'

test('estTokensFromText approximates chars/4 ceil', () => {
  assert.equal(estTokensFromText(''), 0)
  assert.equal(estTokensFromText('abcd'), 1)
  assert.equal(estTokensFromText('abcde'), 2)
  assert.equal(estTokensFromText('你好世界'), Math.ceil('你好世界'.length / 4))
})

test('trimReply truncates with ellipsis', () => {
  assert.equal(trimReply('hello', 10), 'hello')
  assert.equal(trimReply('hello world', 5), 'hell…')
  assert.equal(trimReply('  a   b  ', 3), 'a b')
})

// memory selection removed in favor of global recent chat context

test('buildContextPrompt includes recent chat lines and owk lines', () => {
  const now = Date.now()
  const recent = [
    { t: now - 1000, user: 'A', text: 'hi' },
    { t: now - 500, user: 'B', text: 'yo' },
    { t: now - 10, user: 'C', text: 'ok' },
    { t: now - 300, user: 'A', text: 'owk 我想问' }
  ]
  const ctx = buildContextPrompt('Me', recent, recent, { include: true, recentCount: 2, recentWindowSec: 60, includeOwk: true, owkWindowSec: 600, owkMax: 3 })
  assert.match(ctx, /Minecraft服务器/)
  assert.match(ctx, /Me/)
  assert.match(ctx, /C: ok/)
  assert.match(ctx, /owk/)
})

test('cost projection and affordability', () => {
  const price = { in: 0.002, out: 0.004 }
  const proj = projectedCostForCall(price.in, price.out, 800, 400)
  assert.ok(proj > 0)
  const budgets = { day: proj + 0.001, month: proj + 0.001, total: proj + 0.001 }
  const ok = canAfford(800, 400, budgets, price)
  assert.equal(ok.ok, true)
  const small = canAfford(800, 400, { day: proj - 0.0001, month: 999, total: 999 }, price)
  assert.equal(small.ok, false)
})
