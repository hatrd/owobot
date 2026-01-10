import test from 'node:test'
import assert from 'node:assert/strict'
import memoryMod from '../bot_impl/ai-chat/memory.js'

const { createMemoryService } = memoryMod

test('memory hybrid: dense retrieval (hash embeddings) can recall when lexical tokens are empty', async () => {
  const state = {
    ai: {
      context: {
        memory: {
          include: true,
          max: 2,
          mode: 'hybrid',
          minScore: 0,
          minRelevance: 0,
          wRelevance: 1,
          wRecency: 0,
          wImportance: 0,
          embeddingProvider: 'hash',
          embeddingDim: 32,
          hybridSparseK: 10,
          hybridDenseK: 10,
          rrfK: 20,
          wLexical: 0,
          wDense: 1,
          denseMinSim: 0
        }
      }
    },
    aiMemory: { entries: [] }
  }
  const memoryStore = { save: () => {}, load: () => ({ long: [], memories: [], dialogues: [] }) }
  const defaults = { DEFAULT_BASE: '', DEFAULT_PATH: '', DEFAULT_MODEL: '' }
  const memory = createMemoryService({ state, memoryStore, defaults, bot: { username: 'bot' } })

  state.aiMemory.entries = [
    { id: 'm1', text: 'hello world', instruction: 'hello world', summary: 'hello memo', count: 1, createdAt: 10, updatedAt: 10, lastAuthor: 'Alice' },
    { id: 'm2', text: 'completely unrelated', instruction: 'completely unrelated', summary: 'other memo', count: 1, createdAt: 11, updatedAt: 11, lastAuthor: 'Alice' }
  ]

  // 'hello' is a stopword for lexical tokenization in memory search, so sparse relevance is empty.
  const res = await memory.longTerm.buildContext({ query: 'hello', actor: 'Alice', withRefs: true })
  assert.match(res.text, /长期记忆:/)
  assert.match(res.text, /hello memo/)
  assert.ok(res.refs.includes('m1'))
})

