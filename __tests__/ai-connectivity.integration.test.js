import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_MODEL, DEFAULT_BASE, DEFAULT_PATH } from '../bot_impl/ai-chat/config.js'

/**
 * Quick connectivity check to verify the AI chat env vars point to a working endpoint.
 * Skips itself if no API key is present.
 */
test('ai chat endpoint responds with text', async (t) => {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    t.skip('DEEPSEEK_API_KEY not set; skipping connectivity check')
    return
  }

  const base = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE
  const path = process.env.DEEPSEEK_PATH || DEFAULT_PATH
  const model = process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const url = `${String(base || '').replace(/\/$/, '')}${path || ''}`

  const body = {
    model,
    messages: [{ role: 'user', content: 'ping? reply with a short OK.' }],
    temperature: 0,
    max_tokens: 12,
    stream: false
  }

  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(new Error('timeout after 12s')), 12_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      assert.fail(`HTTP ${res.status}: ${text}`)
    }
    const data = await res.json()
    const reply = data?.choices?.[0]?.message?.content || ''
    assert.ok(typeof reply === 'string', 'reply is not a string')
    assert.ok(reply.trim().length > 0, 'empty reply')
  } catch (err) {
    console.error('connectivity test error', err)
    throw err
  } finally {
    clearTimeout(timeout)
  }
})
