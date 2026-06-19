import test from 'node:test'
import assert from 'node:assert/strict'
import introspectionMod from '../bot_impl/ai-chat/introspection.js'

const { createIntrospectionEngine } = introspectionMod

test('introspection uses local fallback without external LLM when there is no feedback evidence', async () => {
  let aiCalls = 0
  let savedEvolution = null
  const state = {}
  const engine = createIntrospectionEngine({
    state,
    bot: { username: 'bot' },
    log: { info: () => {}, debug: () => {}, warn: () => {} },
    now: () => 1000,
    feedbackCollector: {
      getStats: () => ({ totalFeedback: 0, totalActions: 0 }),
      getRecentSignals: () => []
    },
    memory: { longTerm: { getStats: () => ({ totalEntries: 0, effectivenessRate: 0 }) } },
    memoryStore: { saveEvolution: data => { savedEvolution = data } },
    aiCall: async () => {
      aiCalls += 1
      return '{"insights":["不应调用外部模型"],"behavior_adjustments":[],"memory_reinforcements":[],"memory_decays":[],"emotional_state":"content","self_narrative":"x"}'
    }
  })

  const result = await engine.runIntrospection('scheduled')

  assert.equal(aiCalls, 0)
  assert.ok(result)
  assert.match(result.insights.join('\n'), /缺少可用反馈数据/)
  assert.equal(state.aiIntrospection.history.length, 1)
  assert.ok(savedEvolution?.introspectionHistory?.length)
})

test('scheduled introspection still uses LLM when feedback evidence exists', async () => {
  let aiCalls = 0
  const state = {}
  const engine = createIntrospectionEngine({
    state,
    bot: { username: 'bot' },
    log: { info: () => {}, debug: () => {}, warn: () => {} },
    now: () => 2000,
    feedbackCollector: {
      getStats: () => ({ totalFeedback: 1, positive: 1, negative: 0, totalActions: 0, feedbackRatio: 1 }),
      getRecentSignals: () => [
        {
          isPositive: true,
          botMessage: '我帮你找到了路',
          signals: [{ type: 'THANKS' }]
        }
      ]
    },
    memory: { longTerm: { getStats: () => ({ totalEntries: 0, effectivenessRate: 0 }) } },
    memoryStore: { saveEvolution: () => {} },
    aiCall: async () => {
      aiCalls += 1
      return '{"insights":["反馈不错"],"behavior_adjustments":[],"memory_reinforcements":[],"memory_decays":[],"emotional_state":"content","self_narrative":"继续保持"}'
    }
  })

  const result = await engine.runIntrospection('scheduled')

  assert.equal(aiCalls, 1)
  assert.deepEqual(result.insights, ['反馈不错'])
})
