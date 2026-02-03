import test from 'node:test'
import assert from 'node:assert/strict'

import observer from '../bot_impl/agent/observer.js'

function nbtCompound (obj) {
  const wrap = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { type: 'compound', value: Object.fromEntries(Object.entries(v).map(([k, vv]) => [k, wrap(vv)])) }
    }
    if (Array.isArray(v)) return { type: 'list', value: v.map(wrap) }
    if (typeof v === 'string') return { type: 'string', value: v }
    if (typeof v === 'number') return { type: 'int', value: v }
    if (v == null) return { type: 'string', value: '' }
    return { type: 'string', value: String(v) }
  }
  return { type: 'compound', value: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, wrap(v)])) }
}

test('snapshot inventory includes custom labels (book title / display.Name) only when present', () => {
  const writtenBook = {
    name: 'written_book',
    type: 999,
    count: 1,
    nbt: nbtCompound({ title: '{"text":"OwO Diary"}', author: 'Ameyaku', pages: ['a'] })
  }
  const renamedSword = {
    name: 'diamond_sword',
    type: 276,
    count: 1,
    nbt: nbtCompound({ display: { Name: '{"text":"Excalibur"}' } })
  }
  const plainTorch = { name: 'torch', type: 50, count: 12 }

  const slots = []
  slots[45] = writtenBook // offhand
  slots[36] = renamedSword // hotbar

  const bot = {
    version: '1.20.4',
    inventory: {
      items: () => [writtenBook, renamedSword, plainTorch],
      slots
    },
    heldItem: plainTorch,
    entity: { position: null }
  }

  const snap = observer.snapshot(bot, { invTop: 999 })
  assert.ok(snap.inv)
  assert.equal(snap.inv.offhand, 'written_book「OwO Diary」')
  assert.equal(snap.inv.held, 'torch')
  assert.ok(Array.isArray(snap.inv.all))

  const bookRow = snap.inv.all.find(r => r.name === 'written_book')
  assert.equal(bookRow.label, 'OwO Diary')

  const swordRow = snap.inv.all.find(r => r.name === 'diamond_sword')
  assert.equal(swordRow.label, 'Excalibur')

  const torchRow = snap.inv.all.find(r => r.name === 'torch')
  assert.equal(torchRow.label, null)

  const prompt = observer.toPrompt(snap)
  assert.match(prompt, /written_book「OwO Diary」x1/)
  assert.match(prompt, /diamond_sword「Excalibur」x1/)
  assert.match(prompt, /torchx12/)
})

