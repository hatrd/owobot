import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_MODEL, DEFAULT_BASE, DEFAULT_PATH } from '../bot_impl/ai-chat/config.js'
import H from '../bot_impl/ai-chat-helpers.js'

/**
 * Quick connectivity check to verify the AI chat env vars point to a working endpoint.
 * Opt-in via RUN_AI_CONNECTIVITY_TEST=1; also skips if no API key is present.
 */
test('ai chat endpoint responds with text', async (t) => {
  if (process.env.RUN_AI_CONNECTIVITY_TEST !== '1') {
    t.skip('RUN_AI_CONNECTIVITY_TEST!=1; skipping connectivity check')
    return
  }
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    t.skip('DEEPSEEK_API_KEY not set; skipping connectivity check')
    return
  }

  const base = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE
  const path = process.env.DEEPSEEK_PATH || DEFAULT_PATH
  const model = process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const url = H.buildAiUrl({ baseUrl: base, path, defaultBase: DEFAULT_BASE, defaultPath: DEFAULT_PATH })

  const body = {
    model,
    messages: [{ role: 'user', content: 'ping? reply with a short OK.' }],
    temperature: 0,
    max_tokens: 12,
    stream: false
  }

  const ac = new AbortController()
  const timeoutMs = (() => {
    const raw = Number(process.env.AI_TEST_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 12_000)
    if (!Number.isFinite(raw) || raw <= 0) return 12_000
    return Math.max(3_000, Math.min(60_000, Math.floor(raw)))
  })()
  const timeout = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
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
    const reply = H.extractAssistantText(data?.choices?.[0]?.message)
    assert.ok(typeof reply === 'string', 'reply is not a string')
    assert.ok(reply.trim().length > 0, 'empty reply')
  } catch (err) {
    console.error('connectivity test error', err)
    throw err
  } finally {
    clearTimeout(timeout)
  }
})
