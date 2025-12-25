import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ctxMod from '../bot_impl/ai-chat/context-bus.js'
import feedbackPoolMod from '../bot_impl/ai-chat/feedback-pool.js'

const { createContextBus } = ctxMod
const { appendFeedback } = feedbackPoolMod

test('feedback pool persists title + full context transcript', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-feedback-'))
  const filePath = path.join(tmp, 'requirements-pool.txt')

  const state = { ai: { context: {} } }
  const now = () => 1700000000000
  const contextBus = createContextBus({ state, now })
  contextBus.pushPlayer('alice', 'owk 你能给我做个拍卖行吗')
  contextBus.pushBotFrom('这个功能我做不到', 'LLM')
  contextBus.pushTool('feedback{need:"添加拍卖行功能"}')

  const res = appendFeedback({
    need: '添加拍卖行功能',
    username: 'alice',
    userMessage: 'owk 你能给我做个拍卖行吗',
    contextBus,
    state,
    now,
    filePath
  })

  assert.equal(res.ok, true)
  const saved = fs.readFileSync(filePath, 'utf8')
  assert.match(saved, /标题：添加拍卖行功能/)
  assert.match(saved, /上下文：/)
  assert.match(saved, /<alice> owk 你能给我做个拍卖行吗/)
  assert.match(saved, /<bot:LLM> 这个功能我做不到/)
  assert.match(saved, /<tool> feedback\{need:"添加拍卖行功能"\}/)
})

