const test = require('node:test')
const assert = require('node:assert/strict')

const botctl = require('../scripts/botctl')

test('botctl builds ai-connectivity control payload', () => {
  const payload = botctl._internal.buildPayload({
    id: 'ctl_test',
    cmd: 'ai-connectivity',
    rest: ['timeoutMs=30000', 'maxOutputTokens=64', 'prompt=ping'],
    token: ''
  })

  assert.equal(payload.op, 'ai.connectivity')
  assert.deepEqual(payload.args, { timeoutMs: 30000, maxOutputTokens: 64, prompt: 'ping' })
})
