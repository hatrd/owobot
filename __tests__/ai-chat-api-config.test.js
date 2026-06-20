import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import cliMod from '../bot_impl/ai-chat/cli.js'
import stateInitMod from '../bot_impl/ai-chat/state-init.js'

const { createAiCliHandler } = cliMod
const { prepareAiState } = stateInitMod

const defaultsBase = {
  DEFAULT_MODEL: 'test-model',
  DEFAULT_BASE: 'https://example.invalid',
  DEFAULT_CHAT_PATH: '/v1/chat/completions',
  DEFAULT_TIMEOUT_MS: 1000,
  DEFAULT_RECENT_COUNT: 12,
  DEFAULT_RECENT_WINDOW_SEC: 300,
  DEFAULT_MEMORY_STORE_MAX: 20,
  buildDefaultContext: () => ({ include: true, game: {}, memory: {} })
}

function makePrepareOpts (DEFAULT_PATH) {
  return {
    defaults: { ...defaultsBase, DEFAULT_PATH },
    persistedMemory: { dialogues: [], long: [], memories: [] },
    persistedEvolution: {},
    dayStart: () => 0,
    monthStart: () => 0
  }
}

test('AI env reload updates Responses API path and clears stale chat fallback', async () => {
  const state = {
    ai: {
      key: 'old-key',
      baseUrl: 'https://old.example',
      model: 'old-model',
      path: '/v1/chat/completions',
      pathOverride: '/v1/chat/completions',
      _probedResponses: true
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-ai-env-'))
  const rcPath = path.join(tmp, 'rc')
  fs.writeFileSync(rcPath, [
    'export DEEPSEEK_API_KEY=new-key',
    'export DEEPSEEK_BASE_URL=https://new.example',
    'export DEEPSEEK_MODEL=new-model',
    'export DEEPSEEK_PATH=/v1/responses'
  ].join('\n'))
  const oldLog = console.log
  console.log = () => {}
  try {
    const handle = createAiCliHandler({ state, log: null })
    await handle({ cmd: 'ai', args: ['env', 'reload', rcPath] })
  } finally {
    console.log = oldLog
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  assert.equal(state.ai.key, 'new-key')
  assert.equal(state.ai.baseUrl, 'https://new.example')
  assert.equal(state.ai.model, 'new-model')
  assert.equal(state.ai.path, '/v1/responses')
  assert.equal(state.ai.pathOverride, null)
  assert.equal(state.ai._probedResponses, false)
})

test('hot reload adopts changed default API path when runtime still has old default path', () => {
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      pathOverride: '/v1/chat/completions',
      model: 'test-model',
      externalCalls: { allowSources: ['main_chat'] }
    }
  }

  prepareAiState(state, makePrepareOpts('/v1/chat/completions'))
  assert.equal(state.ai.path, '/v1/chat/completions')

  prepareAiState(state, makePrepareOpts('/v1/responses'))
  assert.equal(state.ai.path, '/v1/responses')
  assert.equal(state.ai.pathOverride, null)
  assert.equal(state.ai._probedResponses, false)
})

test('hot reload preserves explicit non-default API path', () => {
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/custom/chat',
      pathOverride: null,
      model: 'test-model',
      externalCalls: { allowSources: ['main_chat'] },
      _defaultPath: '/v1/chat/completions'
    }
  }

  prepareAiState(state, makePrepareOpts('/v1/responses'))

  assert.equal(state.ai.path, '/custom/chat')
  assert.equal(state.ai.pathOverride, null)
  assert.equal(state.ai._probedResponses, undefined)
})
