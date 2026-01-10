import test from 'node:test'
import assert from 'node:assert/strict'
import queryMod from '../bot_impl/ai-chat/memory-query.js'

const { buildMemoryQuery } = queryMod

test('buildMemoryQuery combines username + message + recent chat lines for that user', async () => {
  const q = buildMemoryQuery({
    username: 'Alice',
    message: '我家在哪',
    recentChat: [
      { user: 'Bob', text: '我在挖矿' },
      { user: 'Alice', text: '昨天我搬家了' },
      { user: 'Alice', text: '我在找基地坐标' },
      { user: 'Bob', text: '坐标多少' },
      { user: 'Alice', text: '你还记得我家在哪吗' }
    ],
    worldHint: null
  })

  assert.match(q, /Alice/)
  assert.match(q, /我家在哪/)
  assert.match(q, /昨天我搬家了/)
  assert.doesNotMatch(q, /我在挖矿/)
})

test('buildMemoryQuery includes worldHint when provided', async () => {
  const q = buildMemoryQuery({
    username: 'Alice',
    message: '这里是哪',
    recentChat: [],
    worldHint: { x: 1.2, y: 64, z: -3.8, dim: 'minecraft:overworld' }
  })

  assert.match(q, /1,64,-4/)
  assert.match(q, /minecraft:overworld/)
})

