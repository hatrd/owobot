import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estTokensFromText,
  trimReply,
  buildContextPrompt,
  projectedCostForCall,
  canAfford,
  extractAssistantText,
  stripReasoningText,
  isResponsesApiPath,
  extractAssistantTextFromApiResponse,
  extractToolCallsFromApiResponse,
  extractUsageFromApiResponse
} from '../bot_impl/ai-chat-helpers.js'

test('extractAssistantText supports string/segment content and avoids reasoning when content exists', () => {
  assert.equal(extractAssistantText('hi'), 'hi')
  assert.equal(extractAssistantText({ content: 'ok' }), 'ok')
  assert.equal(extractAssistantText({ content: '  ' }), '')
  assert.equal(extractAssistantText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(extractAssistantText({ content: [{ type: 'output_text', text: 'answer' }], reasoning_content: 'analysis' }), 'answer')
  assert.equal(extractAssistantText({ content: { text: 'obj' } }), 'obj')
  assert.equal(extractAssistantText({ text: 'alt' }), 'alt')
  assert.equal(extractAssistantText({ content: '', reasoning_content: 'reason' }), 'reason')
  assert.equal(extractAssistantText({ content: '', reasoning_content: 'reason' }, { allowReasoning: false }), '')
  assert.equal(extractAssistantText({ reasoning_content: [{ type: 'text', text: 'r' }] }, { allowReasoning: true }), 'r')
})

test('stripReasoningText removes <think>/<analysis> blocks', () => {
  assert.equal(stripReasoningText('a<think>secret</think>b'), 'ab')
  assert.equal(stripReasoningText('a<analysis>secret</analysis>b'), 'ab')
  assert.equal(stripReasoningText('a<THINK>secret</THINK>b'), 'ab')
  assert.equal(stripReasoningText('a<think>secret'), 'a')
})

test('extractAssistantText strips <think> when allowReasoning=false', () => {
  const msg = { content: '<think>secret</think>final answer' }
  assert.equal(extractAssistantText(msg, { allowReasoning: false }), 'final answer')
})

test('OpenAI-compatible response helpers support chat-completions and responses shapes', () => {
  assert.equal(isResponsesApiPath('/v1/responses'), true)
  assert.equal(isResponsesApiPath('/v1/chat/completions'), false)

  const chatData = {
    choices: [
      { message: { role: 'assistant', content: '<think>x</think>hi', tool_calls: [{ id: 't1', function: { name: 'say', arguments: '{}' } }] } }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  }
  assert.equal(extractAssistantTextFromApiResponse(chatData, { allowReasoning: false }), 'hi')
  assert.equal(extractToolCallsFromApiResponse(chatData).length, 1)
  assert.deepEqual(extractUsageFromApiResponse(chatData), { inTok: 10, outTok: 20 })

  const respData = {
    output: [
      { type: 'message', role: 'assistant', content: '<think>x</think>hello' },
      { type: 'function_call', call_id: 'c1', name: 'say', arguments: '{"text":"ok"}' }
    ],
    usage: { input_tokens: 3, output_tokens: 4 }
  }
  assert.equal(extractAssistantTextFromApiResponse(respData, { allowReasoning: false }), 'hello')
  assert.equal(extractToolCallsFromApiResponse(respData)[0]?.function?.name, 'say')
  assert.deepEqual(extractUsageFromApiResponse(respData), { inTok: 3, outTok: 4 })
})

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

test('buildContextPrompt limits to recent window/count', () => {
  const now = Date.now()
  const recent = [
    { t: now - 120 * 1000, user: 'Old', text: 'past' },
    { t: now - 40 * 1000, user: 'A', text: 'hi there' },
    { t: now - 20 * 1000, user: 'B', text: 'yo' },
    { t: now - 2 * 1000, user: 'C', text: 'latest line' }
  ]
  const ctx = buildContextPrompt('Me', recent, { include: true, recentCount: 2, recentWindowSec: 60 })
  assert.match(ctx, /当前对话玩家: Me/)
  assert.match(ctx, /C: \[.*\] latest line/)
  assert.match(ctx, /B: \[.*\] yo/)
  assert.doesNotMatch(ctx, /Old: \[.*\] past/)
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
