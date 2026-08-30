const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createStructuredChatBridge,
  extractPlainText,
  findUsernameByUuid,
  isStructuredPlayerChat,
  normalizeUuid,
  resolveStructuredPlayerChat
} = require('../bot_impl/incoming-chat')

test('normalizes UUIDs independently of hyphen format', () => {
  assert.equal(normalizeUuid('12345678-1234-1234-1234-123456789ABC'), '12345678123412341234123456789abc')
})

test('resolves a player name from the structured sender UUID', () => {
  const bot = {
    players: {
      FenZite: { username: 'FenZite', uuid: '12345678-1234-1234-1234-123456789abc' }
    }
  }
  assert.equal(findUsernameByUuid(bot, '12345678123412341234123456789abc'), 'FenZite')
})

test('resolves player chat without requiring a name in rendered text', () => {
  const bot = {
    players: {
      FenZite: { username: 'FenZite', uuid: '12345678-1234-1234-1234-123456789abc' }
    }
  }
  const result = resolveStructuredPlayerChat(
    bot,
    { getText: () => '这是什么地方！！！我要回家qwq' },
    'chat',
    '12345678-1234-1234-1234-123456789abc'
  )
  assert.deepEqual(result, {
    username: 'FenZite',
    content: '这是什么地方！！！我要回家qwq',
    senderUuid: '12345678-1234-1234-1234-123456789abc'
  })
})

test('does not classify system chat as player chat', () => {
  const bot = { players: { FenZite: { uuid: 'abc' } } }
  assert.equal(resolveStructuredPlayerChat(bot, 'Sleeping through this night', 'system', 'abc'), null)
})

test('identifies structured player chat metadata', () => {
  assert.equal(isStructuredPlayerChat('chat', 'abc'), true)
  assert.equal(isStructuredPlayerChat('system', 'abc'), false)
  assert.equal(isStructuredPlayerChat('chat', null), false)
})

test('extracts plain text from chat components', () => {
  assert.equal(extractPlainText({ getText: () => '§a你好' }), '你好')
})

test('bridge synthesizes chat once when Mineflayer pattern parsing misses it', () => {
  const state = { incomingChat: { structuredSeen: 0, synthesized: 0, unresolvedSender: 0 } }
  const bot = { players: { FenZite: { uuid: 'abc' } } }
  const bridge = createStructuredChatBridge({ bot, state })
  const message = { getText: () => '我要回家qwq' }

  assert.deepEqual(bridge.handleMessage(message, 'chat', 'abc'), {
    playerChat: {
      username: 'FenZite',
      content: '我要回家qwq',
      senderUuid: 'abc'
    },
    shouldEmit: true,
    nativeHandled: false
  })
  assert.equal(state.incomingChat.structuredSeen, 1)
  assert.equal(state.incomingChat.synthesized, 1)
  assert.equal(state.incomingChat.lastPacket.position, 'chat')
  assert.equal(state.incomingChat.lastPacket.senderUuid, 'abc')
  assert.equal(state.incomingChat.lastPacket.text, '我要回家qwq')
})

test('bridge does not duplicate a native Mineflayer chat event', () => {
  const state = { incomingChat: { structuredSeen: 0, synthesized: 0, unresolvedSender: 0 } }
  const bot = { players: { FenZite: { uuid: 'abc' } } }
  const bridge = createStructuredChatBridge({ bot, state })
  const message = { getText: () => '<FenZite> 你好' }

  bridge.noteNativeChat(message)
  assert.deepEqual(bridge.handleMessage(message, 'chat', 'abc'), {
    playerChat: {
      username: 'FenZite',
      content: '<FenZite> 你好',
      senderUuid: 'abc'
    },
    shouldEmit: false,
    nativeHandled: true
  })
  assert.equal(state.incomingChat.structuredSeen, 1)
  assert.equal(state.incomingChat.synthesized, 0)
})

test('bridge ignores the bot own echoed player chat', () => {
  const state = { incomingChat: { structuredSeen: 0, synthesized: 0, unresolvedSender: 0 } }
  const bot = { username: 'owkowk', players: { owkowk: { uuid: 'self' } } }
  const bridge = createStructuredChatBridge({ bot, state })

  assert.deepEqual(bridge.handleMessage({ getText: () => '机器人回复' }, 'chat', 'self'), {
    playerChat: {
      username: 'owkowk',
      content: '机器人回复',
      senderUuid: 'self'
    },
    shouldEmit: false,
    nativeHandled: false
  })
  assert.equal(state.incomingChat.synthesized, 0)
  assert.equal(state.incomingChat.last, undefined)
})
