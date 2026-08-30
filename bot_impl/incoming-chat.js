function normalizeUuid (value) {
  return String(value || '').replace(/-/g, '').toLowerCase()
}

function findUsernameByUuid (bot, senderUuid) {
  const target = normalizeUuid(senderUuid)
  if (!target) return null
  for (const [name, player] of Object.entries(bot?.players || {})) {
    if (normalizeUuid(player?.uuid) === target) return String(player?.username || name)
  }
  return null
}

function extractPlainText (message) {
  if (!message) return ''
  const text = typeof message.getText === 'function'
    ? message.getText()
    : (typeof message.toString === 'function' ? message.toString() : String(message))
  return String(text || '').replace(/\u00a7./g, '').trim()
}

function isStructuredPlayerChat (position, senderUuid) {
  return position === 'chat' && senderUuid != null && String(senderUuid) !== ''
}

function resolveStructuredPlayerChat (bot, message, position, senderUuid) {
  if (!isStructuredPlayerChat(position, senderUuid)) return null
  const username = findUsernameByUuid(bot, senderUuid)
  const content = extractPlainText(message)
  if (!username || !content) return null
  return { username, content, senderUuid: String(senderUuid) }
}

function ensureIncomingChatState (state) {
  if (!state || typeof state !== 'object') return {}
  if (!state.incomingChat || typeof state.incomingChat !== 'object') state.incomingChat = {}
  const incomingChat = state.incomingChat
  for (const key of ['structuredSeen', 'synthesized', 'unresolvedSender', 'contextMirrorRemoved', 'contextMirrorRemaining']) {
    if (!Number.isFinite(incomingChat[key])) incomingChat[key] = 0
  }
  return incomingChat
}

function createStructuredChatBridge ({ bot, state }) {
  const nativeChatMessages = new WeakSet()
  const incomingChat = ensureIncomingChatState(state)

  function noteNativeChat (jsonMessage) {
    if (jsonMessage && typeof jsonMessage === 'object') nativeChatMessages.add(jsonMessage)
  }

  function handleMessage (message, position, senderUuid) {
    incomingChat.lastPacket = {
      at: Date.now(),
      position: position == null ? null : String(position),
      senderUuid: senderUuid == null ? null : String(senderUuid),
      text: extractPlainText(message).slice(0, 320)
    }
    if (position === 'chat' && senderUuid) incomingChat.structuredSeen++
    const playerChat = resolveStructuredPlayerChat(bot, message, position, senderUuid)
    if (!playerChat) {
      if (position === 'chat' && senderUuid) incomingChat.unresolvedSender++
      return null
    }
    const isSelf = playerChat.username === bot.username
    const nativeHandled = message && typeof message === 'object' && nativeChatMessages.has(message)
    if (!isSelf) {
      incomingChat.lastPlayerPacket = Object.assign({ at: Date.now() }, playerChat)
      incomingChat.last = Object.assign({ at: Date.now() }, playerChat)
    }
    const shouldEmit = !isSelf && !nativeHandled
    if (shouldEmit) incomingChat.synthesized++
    return { playerChat, shouldEmit, nativeHandled: Boolean(nativeHandled) }
  }

  return { handleMessage, noteNativeChat }
}

module.exports = {
  createStructuredChatBridge,
  ensureIncomingChatState,
  extractPlainText,
  findUsernameByUuid,
  isStructuredPlayerChat,
  normalizeUuid,
  resolveStructuredPlayerChat
}
