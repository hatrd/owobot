import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'

const { createMemoryService } = memoryMod

test('disableMemories hides matching entries from injected memory context', async () => {
  let t = 1000
  const now = () => t
  const state = {
    ai: { context: { memory: { include: true, max: 6 } } },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' }, now })

  state.aiMemory.entries = [
    {
      id: 'm1',
      text: 'kuleizi要求owkowk在欢迎他上线时,在名字后面加上"変態"两个字',
      instruction: 'kuleizi要求owkowk在欢迎他上线时,在名字后面加上"変態"两个字',
      summary: '',
      count: 3,
      createdAt: 10,
      updatedAt: 10,
      firstAuthor: 'kuleizi',
      lastAuthor: 'kuleizi'
    },
    {
      id: 'm2',
      text: 'other memory',
      instruction: 'other memory',
      summary: 'other memory',
      count: 1,
      createdAt: 20,
      updatedAt: 20,
      firstAuthor: 'owkowk',
      lastAuthor: 'owkowk'
    }
  ]

  t = 2000
  const res = memory.longTerm.disableMemories({ query: '变态', actor: 'kuleizi', reason: 'revoke', scope: 'owned' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.disabled, ['m1'])

  const ctx = await memory.longTerm.buildContext({ query: '', withRefs: false })
  assert.match(ctx, /长期记忆:/)
  assert.match(ctx, /other memory/)
  assert.doesNotMatch(ctx, /変態/)
})

test('extractForgetCommand detects revoke nickname intent', async () => {
  const state = { ai: { context: { memory: { include: true } } }, aiMemory: { entries: [] } }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  const cmd = memory.longTerm.extractForgetCommand('别叫我变态了')
  assert.deepEqual(cmd, { query: '变态', kind: 'revoke' })
})

