import test from 'node:test'
import assert from 'node:assert/strict'

import { extractBookInfo, toPlainText } from '../bot_impl/actions/lib/book.js'

test('toPlainText flattens JSON text components', () => {
  assert.equal(toPlainText('{"text":"hi"}'), 'hi')
  assert.equal(toPlainText('{"text":"a","extra":[{"text":"b"},"c"]}'), 'abc')
  assert.equal(toPlainText('plain'), 'plain')
})

test('extractBookInfo reads written_book title/author/pages', async () => {
  const item = {
    name: 'written_book',
    displayName: '成书',
    nbt: {
      title: '{"text":"My Book"}',
      author: 'Ameyaku',
      pages: ['{"text":"p1"}', '{"text":"p2","extra":[{"text":"!"}] }', 'plain3']
    }
  }

  const res = await extractBookInfo(item, { maxPages: 2 })
  assert.equal(res.ok, true)
  assert.match(res.msg, /书: My Book/)
  assert.match(res.msg, /作者: Ameyaku/)
  assert.match(res.msg, /类型: written_book/)
  assert.match(res.msg, /【第1页】/)
  assert.match(res.msg, /p1/)
  assert.match(res.msg, /【第2页】/)
  assert.match(res.msg, /p2!/)
  assert.match(res.msg, /只展示第1-2页/)
  assert.equal(res.data.totalPages, 3)
  assert.equal(res.data.pages.length, 2)
})

test('extractBookInfo supports pageFrom/pageTo selection', async () => {
  const item = {
    name: 'writable_book',
    displayName: '书与笔',
    nbt: {
      pages: ['a', 'b', 'c']
    }
  }
  const res = await extractBookInfo(item, { pageFrom: 2, pageTo: 3 })
  assert.equal(res.ok, true)
  assert.match(res.msg, /【第2页】/)
  assert.match(res.msg, /b/)
  assert.match(res.msg, /【第3页】/)
  assert.match(res.msg, /c/)
  assert.doesNotMatch(res.msg, /【第1页】/)
})

