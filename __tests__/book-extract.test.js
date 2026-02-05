const test = require('node:test')
const assert = require('node:assert/strict')

const { extractBookInfo, extractBookMeta } = require('../bot_impl/actions/lib/book')

test('extractBookMeta/extractBookInfo support legacy NBT fields', async () => {
  const item = {
    name: 'written_book',
    displayName: 'ediblebook',
    slot: 12,
    nbt: {
      title: 'Old Title',
      author: 'Steve',
      pages: ['{"text":"Hello"}', '{"text":""}']
    }
  }

  const meta = await extractBookMeta(item, { probePages: 3 })
  assert.equal(meta.ok, true)
  assert.equal(meta.data.title, 'Old Title')
  assert.equal(meta.data.author, 'Steve')
  assert.equal(meta.data.type, 'written_book')
  assert.equal(meta.data.slot, 12)
  assert.equal(meta.data.totalPages, 2)
  assert.equal(meta.data.hasContent, true)

  const info = await extractBookInfo(item, { maxPages: 1, maxCharsPerPage: 50, pageFrom: 1, pageTo: 1 })
  assert.equal(info.ok, true)
  assert.equal(info.data.title, 'Old Title')
  assert.equal(info.data.totalPages, 2)
  assert.equal(info.data.pages.length, 1)
  assert.match(info.msg, /书:\s*Old Title/)
  assert.match(info.msg, /【第1页】/)
  assert.match(info.msg, /Hello/)
})

test('extractBookMeta/extractBookInfo support 1.20.5+ data components', async () => {
  const item = {
    name: 'written_book',
    displayName: 'ediblebook',
    slot: 5,
    nbt: {
      components: {
        'minecraft:custom_name': '{"text":"ediblebook"}',
        'minecraft:written_book_content': {
          title: 'The Real Book',
          author: 'Alex',
          pages: [
            { raw: '{"text":"Page1"}' },
            { raw: '{"text":"Page2"}' }
          ]
        }
      }
    }
  }

  const meta = await extractBookMeta(item, { probePages: 2 })
  assert.equal(meta.ok, true)
  assert.equal(meta.data.title, 'The Real Book')
  assert.equal(meta.data.contentTitle, 'The Real Book')
  assert.equal(meta.data.customName, 'ediblebook')
  assert.equal(meta.data.author, 'Alex')
  assert.equal(meta.data.totalPages, 2)
  assert.equal(meta.data.hasContent, true)

  const info = await extractBookInfo(item, { maxPages: 2, maxCharsPerPage: 50 })
  assert.equal(info.ok, true)
  assert.equal(info.data.title, 'The Real Book')
  assert.equal(info.data.customName, 'ediblebook')
  assert.equal(info.data.totalPages, 2)
  assert.match(info.msg, /显示名:\s*ediblebook/)
  assert.match(info.msg, /Page1/)
  assert.match(info.msg, /Page2/)
})

test('extractBookMeta/extractBookInfo support flattened component entries (mineflayer SlotComponent shape)', async () => {
  const item = {
    name: 'writable_book',
    displayName: 'Book and Quill',
    slot: 16,
    // mineflayer 1.20.5+ represents components as an array of SlotComponent objects.
    components: [
      {
        type: 'writable_book_content',
        pages: [
          { content: '{"text":"Hello from writable"}' },
          { content: '{"text":"Second page"}' }
        ]
      }
    ]
  }

  const meta = await extractBookMeta(item, { probePages: 2 })
  assert.equal(meta.ok, true)
  assert.equal(meta.data.type, 'writable_book')
  assert.equal(meta.data.totalPages, 2)
  assert.equal(meta.data.hasContent, true)

  const info = await extractBookInfo(item, { maxPages: 2, maxCharsPerPage: 100 })
  assert.equal(info.ok, true)
  assert.equal(info.data.totalPages, 2)
  assert.match(info.msg, /Hello from writable/)
  assert.match(info.msg, /Second page/)
})
