const test = require('node:test'), assert = require('node:assert/strict')
const { runNode } = require('../scripts/lib/run-node')
test('goal child failure retains bounded stderr and status', async () => {
  await assert.rejects(runNode('-e', ["process.stderr.write('rejected'); process.exit(7)"]), e => e.message === 'segment_failed' && e.detail.status === 7 && e.detail.stderr === 'rejected')
})
test('canceling a goal waits for its child to terminate, leaving no orphan executor', async () => {
  const abort = new AbortController()
  const pending = runNode('-e', ['setInterval(()=>{},1000)'], abort.signal)
  setTimeout(() => abort.abort(), 50)
  await assert.rejects(pending, e => {
    assert.equal(e.message, 'canceled')
    assert.throws(() => process.kill(e.detail.pid, 0), { code: 'ESRCH' })
    return true
  })
})
