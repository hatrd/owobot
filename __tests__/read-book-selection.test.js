import test from 'node:test'
import assert from 'node:assert/strict'

import actionsMod from '../bot_impl/actions/index.js'

function fakeBotWithInventory ({ heldItem, slots = [], items = [] }) {
  return {
    username: 'bot',
    inventory: {
      slots,
      items: () => items
    },
    heldItem
  }
}

test('read_book falls back to inventory book when slot/name points to non-book', async () => {
  const sword = { name: 'netherite_sword', type: 1, count: 1, slot: 36 }
  const book = { name: 'writable_book', type: 2, count: 1, slot: 10, nbt: { pages: ['hi'] } }

  const slots = []
  slots[36] = sword
  slots[10] = book

  const bot = fakeBotWithInventory({ heldItem: sword, slots, items: [sword, book] })
  const actions = actionsMod.install(bot, { log: null })

  const res = await actions.run('read_book', { slot: 'hand' })
  assert.equal(res.ok, true)
  assert.match(res.msg, /writable_book/)
})

