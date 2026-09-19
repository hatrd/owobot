import test from 'node:test'
import assert from 'node:assert/strict'
import logging from '../bot_impl/logging.js'

test('structured evidence persists through quiet log settings', () => {
  const previous = logging.getSpec()
  const original = console.log
  const rows = []
  console.log = (...args) => rows.push(args)
  try {
    logging.setSpec('all:off')
    const log = logging.getLogger('runtime')
    log.info('not evidence')
    log.event('runtime.sample', { memory: { rss: 42 } })
    assert.equal(rows.length, 1)
    assert.deepEqual(JSON.parse(rows[0][1]), { event: 'runtime.sample', data: { memory: { rss: 42 } } })
  } finally {
    console.log = original
    logging.setSpec(previous)
  }
})
