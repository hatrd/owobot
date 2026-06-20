import test from 'node:test'
import assert from 'node:assert/strict'

import controlPlaneContract from '../bot_impl/control-plane-contract.js'
import schemaMod from '../bot_impl/interaction-schema.js'
import connectivityMod from '../bot_impl/ai-chat/connectivity.js'

const { checkAiConnectivity } = connectivityMod

test('control schema exposes live AI connectivity check', () => {
  assert.equal(controlPlaneContract.CTL_OPS.AI_CONNECTIVITY, 'ai.connectivity')
  const schema = schemaMod.getCtlSchema()
  const op = schema.ops.find(item => item.op === 'ai.connectivity')
  assert.ok(op, 'expected ai.connectivity op in ctl schema')
  assert.equal(op.requiresBot, true)
  assert.equal(op.args.timeoutMs.type, 'number')
  assert.equal(op.args.prompt.type, 'string')
  assert.equal(op.args.maxOutputTokens.type, 'number')
})

test('AI connectivity check uses live Responses config shape', async () => {
  let capturedUrl = ''
  let capturedBody = null
  const result = await checkAiConnectivity({
    ai: {
      key: 'secret-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/responses',
      model: 'test-model',
      timeoutMs: 5000
    },
    defaults: {
      DEFAULT_BASE: 'https://fallback.invalid',
      DEFAULT_PATH: '/v1/chat/completions',
      DEFAULT_MODEL: 'fallback-model'
    },
    prompt: 'ping',
    maxOutputTokens: 256,
    now: (() => {
      let t = 100
      return () => { t += 5; return t }
    })(),
    fetchImpl: async (url, init) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init.body || '{}'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: 'OK',
          usage: { input_tokens: 3, output_tokens: 1 }
        })
      }
    }
  })

  assert.equal(capturedUrl, 'https://example.invalid/v1/responses')
  assert.deepEqual(Object.keys(capturedBody).sort(), ['input', 'max_output_tokens', 'model'])
  assert.equal(capturedBody.max_output_tokens, 256)
  assert.equal(capturedBody.messages, undefined)
  assert.equal(result.ok, true)
  assert.equal(result.config.schema, 'responses')
  assert.equal(result.config.hasKey, true)
  assert.equal(result.reply, 'OK')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})

test('AI connectivity check rejects empty assistant text', async () => {
  const result = await checkAiConnectivity({
    ai: {
      key: 'secret-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/responses',
      model: 'test-model'
    },
    defaults: {
      DEFAULT_BASE: 'https://fallback.invalid',
      DEFAULT_PATH: '/v1/chat/completions',
      DEFAULT_MODEL: 'fallback-model'
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: 'reasoning', summary: [] }],
        usage: { input_tokens: 3, output_tokens: 12 }
      })
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'empty_assistant_text')
  assert.equal(result.responseShape.output[0].type, 'reasoning')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})
