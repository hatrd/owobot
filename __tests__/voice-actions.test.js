const test = require('node:test')
const assert = require('node:assert/strict')

const registerVoiceTools = require('../bot_impl/actions/modules/voice')

function createHarness () {
  const registry = new Map()
  const ctx = {
    bot: {
      voiceChat: {
        async play (target) {
          return { ok: true, msg: '已发送语音音频', path: target }
        },
        status () {
          return { enabled: true, available: true, pluginLoaded: true, connected: true }
        }
      }
    },
    register (name, fn) { registry.set(name, fn) },
    ok (msg, extra) { return { ok: true, msg, ...(extra || {}) } },
    fail (msg, extra) { return { ok: false, msg, ...(extra || {}) } }
  }
  registerVoiceTools(ctx)
  return { registry }
}

test('voice_speak maps preset ciallo to fixed local asset', async () => {
  const { registry } = createHarness()
  const fn = registry.get('voice_speak')
  assert.equal(typeof fn, 'function')
  const res = await fn({ preset: 'ciallo' })
  assert.equal(res.ok, true)
  assert.equal(res.source, 'preset')
  assert.equal(res.preset, 'ciallo')
})

test('voice_speak rejects non-preset source', async () => {
  const { registry } = createHarness()
  const fn = registry.get('voice_speak')
  const res = await fn({ source: 'url', preset: 'ciallo' })
  assert.equal(res.ok, false)
  assert.match(String(res.msg || ''), /仅支持 preset/)
})

test('voice_speak rejects unsupported preset', async () => {
  const { registry } = createHarness()
  const fn = registry.get('voice_speak')
  const res = await fn({ preset: 'unknown' })
  assert.equal(res.ok, false)
  assert.deepEqual(res.supportedPresets, ['ciallo'])
})

