const path = require('path')

function parseBool (value, fallback = true) {
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (!s) return fallback
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off')
}

function normalizeAudioPath (inputPath) {
  const p = String(inputPath || '').trim()
  if (!p) return null
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
}

function nowIso () {
  return new Date().toISOString()
}

function setVoiceError (state, err) {
  try {
    if (!state?.voiceChat) return
    state.voiceChat.lastError = err ? String(err?.message || err) : null
  } catch {}
}

function isVoiceNotLoadedError (err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('voice chat is not loaded')
}

function parsePort (value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const p = Math.floor(n)
  if (p < 1 || p > 65535) return null
  return p
}

function splitHostPort (value, fallbackPort = null) {
  const text = String(value || '').trim()
  if (!text) return { host: null, port: fallbackPort }
  const colonCount = (text.match(/:/g) || []).length
  if (colonCount === 1) {
    const [hostPart, portPart] = text.split(':', 2)
    const parsedPort = parsePort(portPart)
    return {
      host: hostPart || null,
      port: parsedPort || fallbackPort
    }
  }
  return { host: text, port: fallbackPort }
}

function isLoopbackHost (host) {
  const value = String(host || '').trim().toLowerCase()
  if (!value) return true
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  return /^127\./.test(value)
}

function resolveBotServerHost (bot) {
  try {
    const candidates = [
      bot?._client?.socketServerHost,
      bot?._client?.host,
      bot?._client?.socketServerIp,
      bot?._client?.socket?.remoteAddress
    ]
    for (const candidate of candidates) {
      const host = String(candidate || '').trim()
      if (!host) continue
      return host
    }
  } catch {}
  return null
}

function resolveEffectiveVoiceTarget (secret, bot) {
  const parsed = splitHostPort(secret?.voiceHost, parsePort(secret?.serverPort))
  const envHostRaw = String(process.env.MC_VOICECHAT_HOST || '').trim()
  const envPort = parsePort(process.env.MC_VOICECHAT_PORT)
  const envParsed = splitHostPort(envHostRaw, null)

  let host = envParsed.host || parsed.host
  if (!envParsed.host && isLoopbackHost(host)) {
    const botHost = resolveBotServerHost(bot)
    if (botHost) host = botHost
  }

  const port = envPort || envParsed.port || parsed.port

  return {
    host: host || '127.0.0.1',
    port: port || null
  }
}

function readVoiceTarget (bot) {
  try {
    const storedDataMod = require('mineflayer-simplevoice/lib/StoredData')
    const secret = storedDataMod?.StoredData?.secretPacketData
    if (!secret || typeof secret !== 'object') return { host: null, port: null }
    const target = resolveEffectiveVoiceTarget(secret, bot)
    return { host: target.host, port: target.port }
  } catch {
    return { host: null, port: null }
  }
}

function createNoopPacket () {
  return {
    send () {},
    on () {},
    once () {},
    off () {},
    removeListener () {}
  }
}

function createNoopPackets () {
  const packet = createNoopPacket()
  return {
    authenticatePacket: packet,
    authenticateAckPacket: packet,
    connectionCheckPacket: packet,
    connectionCheckAckPacket: packet,
    pingPacket: packet,
    clientboundKeepAlivePacket: packet,
    serverboundKeepAlivePacket: packet,
    clientboundPingPacket: packet,
    serverboundPingPacket: packet,
    playerSoundPacket: packet,
    groupSoundPacket: packet,
    locationSoundPacket: packet,
    micPacket: packet
  }
}

function patchSimplevoiceSocketClient (logger, bot) {
  try {
    const socketClientMod = require('mineflayer-simplevoice/lib/VoiceChatSocketClient')
    const storedDataMod = require('mineflayer-simplevoice/lib/StoredData')
    const SocketClient = socketClientMod && (socketClientMod.default || socketClientMod)
    if (!SocketClient || !SocketClient.prototype) return
    if (SocketClient.prototype.__mcbotPatchedGetPackets && SocketClient.prototype.__mcbotPatchedConnectOverride) return

    const originalGetPackets = SocketClient.prototype.getPackets
    SocketClient.prototype.getPackets = function patchedGetPackets () {
      try {
        return originalGetPackets.call(this)
      } catch (err) {
        const msg = String(err?.message || err)
        if (!msg.includes('Packet registry is not initialized')) throw err
        if (!this.__mcbotNoopPackets) this.__mcbotNoopPackets = createNoopPackets()
        if (!this.__mcbotWarnedPacketRegistry) {
          this.__mcbotWarnedPacketRegistry = true
          try { logger.warn && logger.warn('voicechat packet registry unavailable; using noop packets') } catch {}
        }
        return this.__mcbotNoopPackets
      }
    }
    SocketClient.prototype.__mcbotPatchedGetPackets = true

    if (!SocketClient.prototype.__mcbotPatchedConnectOverride) {
      const originalConnect = SocketClient.prototype.connect
      SocketClient.prototype.connect = function patchedConnect () {
        try {
          const secret = storedDataMod?.StoredData?.secretPacketData
          if (secret && typeof secret === 'object') {
            const target = resolveEffectiveVoiceTarget(secret, bot)
            if (target.host) secret.voiceHost = target.host
            if (target.port) secret.serverPort = target.port
            if (!this.__mcbotVoiceTargetLogged) {
              const host = String(secret.voiceHost || '').trim() || '127.0.0.1'
              const port = parsePort(secret.serverPort)
              try { logger.info && logger.info('voicechat udp target:', `${host}:${port || '?'}`) } catch {}
              this.__mcbotVoiceTargetLogged = true
            }
          }
        } catch {}
        return originalConnect.call(this)
      }
      SocketClient.prototype.__mcbotPatchedConnectOverride = true
    }
  } catch (e) {
    try { logger.warn && logger.warn('voice socket patch skipped:', e?.message || e) } catch {}
  }
}

function install (bot, { on, state, registerCleanup, log } = {}) {
  const logger = log || console
  const out = (...args) => console.log('[VOICE]', ...args)
  const enabled = parseBool(process.env.MC_VOICECHAT, true)
  const VOICE_RECOVER_COOLDOWN_MS = 5000
  const VOICE_RECOVER_INTERVAL_MS = 15000

  if (!state.voiceChat || typeof state.voiceChat !== 'object') state.voiceChat = {}
  state.voiceChat.enabled = enabled
  state.voiceChat.available = false
  state.voiceChat.pluginLoaded = false
  state.voiceChat.connected = false
  if (!('lastError' in state.voiceChat)) state.voiceChat.lastError = null
  if (!('lastAudioPath' in state.voiceChat)) state.voiceChat.lastAudioPath = null
  if (!('lastAudioAt' in state.voiceChat)) state.voiceChat.lastAudioAt = null
  if (!('lastSpeaker' in state.voiceChat)) state.voiceChat.lastSpeaker = null
  if (!('lastSpeakerAt' in state.voiceChat)) state.voiceChat.lastSpeakerAt = null
  if (!('lastConnectAt' in state.voiceChat)) state.voiceChat.lastConnectAt = null
  if (!('lastDisconnectAt' in state.voiceChat)) state.voiceChat.lastDisconnectAt = null

  let lastRecoverAt = 0
  let recoverTimer = null

  function hasVoiceApi () {
    return Boolean(bot.voicechat && typeof bot.voicechat.sendAudio === 'function')
  }

  function isReadyState () {
    return Boolean(state.voiceChat.available && state.voiceChat.pluginLoaded && hasVoiceApi())
  }

  function syncConnectedState () {
    const connected = Boolean(
      bot.voicechat &&
      typeof bot.voicechat.isConnected === 'function' &&
      bot.voicechat.isConnected()
    )
    state.voiceChat.connected = connected
    return connected
  }

  function markDisconnected (reason) {
    try {
      state.voiceChat.connected = false
      state.voiceChat.lastDisconnectAt = nowIso()
      if (reason) out('voicechat disconnected', `(${reason})`)
    } catch {}
  }

  function requestVoiceReconnect (reason, { force = false } = {}) {
    try {
      if (!isReadyState()) return { ok: false, skipped: 'not-ready' }
      if (syncConnectedState()) return { ok: true, skipped: 'already-connected' }
      const mcState = String(bot?._client?.state || '').toLowerCase()
      if (mcState !== 'play') return { ok: false, skipped: 'mc-not-play' }
      const now = Date.now()
      if (!force && now - lastRecoverAt < VOICE_RECOVER_COOLDOWN_MS) return { ok: false, skipped: 'cooldown' }
      lastRecoverAt = now

      const voiceClient = bot.voicechat?._client
      if (!voiceClient) throw new Error('voice client unavailable')

      try {
        const socketClient = typeof voiceClient.getSocketClient === 'function'
          ? voiceClient.getSocketClient()
          : voiceClient.socketClient
        if (socketClient && typeof socketClient.close === 'function') socketClient.close()
      } catch {}

      try {
        if (typeof voiceClient.registerChannels === 'function') voiceClient.registerChannels()
      } catch {}

      const packets = typeof voiceClient.getPackets === 'function'
        ? voiceClient.getPackets()
        : voiceClient.packets
      const requestSecretPacket = packets?.requestSecretPacket
      if (!requestSecretPacket || typeof requestSecretPacket.send !== 'function') {
        throw new Error('voice request packet unavailable')
      }
      const compatibilityVersionRaw = Number(voiceClient.compatibilityVersion)
      const compatibilityVersion = Number.isFinite(compatibilityVersionRaw) ? compatibilityVersionRaw : 18
      requestSecretPacket.send({ compatibilityVersion })
      try { logger.info && logger.info('voice reconnect requested:', reason || 'unknown') } catch {}
      return { ok: true }
    } catch (err) {
      setVoiceError(state, err)
      try { logger.warn && logger.warn('voice reconnect request failed:', err?.message || err) } catch {}
      return { ok: false, error: String(err?.message || err) }
    }
  }

  function queueVoiceReconnect (reason, delayMs = 0) {
    try {
      if (recoverTimer) clearTimeout(recoverTimer)
    } catch {}
    const waitMs = Number.isFinite(Number(delayMs)) ? Math.max(0, Math.floor(Number(delayMs))) : 0
    recoverTimer = setTimeout(() => {
      recoverTimer = null
      requestVoiceReconnect(reason)
    }, waitMs)
  }

  function status () {
    const target = readVoiceTarget(bot)
    return {
      enabled: Boolean(state.voiceChat.enabled),
      available: Boolean(state.voiceChat.available),
      pluginLoaded: Boolean(state.voiceChat.pluginLoaded),
      connected: Boolean(syncConnectedState()),
      hasApi: hasVoiceApi(),
      targetHost: target.host,
      targetPort: target.port,
      lastError: state.voiceChat.lastError || null,
      lastAudioPath: state.voiceChat.lastAudioPath || null,
      lastAudioAt: state.voiceChat.lastAudioAt || null,
      lastSpeaker: state.voiceChat.lastSpeaker || null,
      lastSpeakerAt: state.voiceChat.lastSpeakerAt || null,
      lastConnectAt: state.voiceChat.lastConnectAt || null,
      lastDisconnectAt: state.voiceChat.lastDisconnectAt || null
    }
  }

  const api = {
    isReady () {
      return isReadyState()
    },
    isConnected () {
      return Boolean(syncConnectedState())
    },
    status,
    async play (audioPath) {
      const targetPath = normalizeAudioPath(audioPath)
      if (!targetPath) return { ok: false, msg: '缺少音频路径(path)' }
      if (!api.isReady()) return { ok: false, msg: '语音插件未就绪', status: api.status() }
      if (!api.isConnected()) {
        requestVoiceReconnect('play:not-connected', { force: true })
        return { ok: false, msg: '语音通道未连接', status: api.status() }
      }
      try {
        await Promise.resolve(bot.voicechat.sendAudio(targetPath))
        state.voiceChat.lastAudioPath = targetPath
        state.voiceChat.lastAudioAt = nowIso()
        setVoiceError(state, null)
        return { ok: true, msg: '已发送语音音频', path: targetPath }
      } catch (e) {
        setVoiceError(state, e)
        if (isVoiceNotLoadedError(e)) {
          markDisconnected('send-audio-failed')
          requestVoiceReconnect('play:not-loaded', { force: true })
        }
        return { ok: false, msg: '发送语音失败', error: String(e?.message || e), path: targetPath }
      }
    }
  }

  try { bot.voiceChat = api } catch {}
  registerCleanup && registerCleanup(() => {
    try { if (bot.voiceChat === api) delete bot.voiceChat } catch {}
  })
  registerCleanup && registerCleanup(() => {
    try {
      if (recoverTimer) clearTimeout(recoverTimer)
      recoverTimer = null
    } catch {}
  })

  function findAudioPath (tokens) {
    for (const tok of tokens) {
      const s = String(tok || '').trim()
      if (!s) continue
      const idx = s.indexOf('=')
      if (idx <= 0) continue
      const k = s.slice(0, idx).trim().toLowerCase()
      if (k !== 'path' && k !== 'file') continue
      const v = s.slice(idx + 1).trim()
      if (v) return v
    }
    return null
  }

  async function onCli (payload) {
    try {
      if (!payload || String(payload.cmd || '').toLowerCase() !== 'voice') return
      const argv = Array.isArray(payload.args) ? payload.args : []
      const head = String(argv[0] || '').toLowerCase()

      if (!head || head === 'status' || head === 'info') {
        out('status', JSON.stringify(api.status()))
        return
      }

      if (head === 'play' || head === 'send') {
        const fromKv = findAudioPath(argv.slice(1))
        const fromText = argv.slice(1).filter(v => !String(v).includes('=')).join(' ').trim()
        const rawPath = fromKv || fromText
        if (!rawPath) {
          out('usage: .voice status | .voice play <path> | .voice play path=/abs/or/relative/file.mp3')
          return
        }
        const res = await api.play(rawPath)
        if (res.ok) out('ok', res.msg, res.path)
        else out('fail', res.msg, res.error || '')
        return
      }

      const directPath = argv.join(' ').trim()
      if (directPath) {
        const res = await api.play(directPath)
        if (res.ok) out('ok', res.msg, res.path)
        else out('fail', res.msg, res.error || '')
        return
      }

      out('usage: .voice status | .voice play <path> | .voice play path=/abs/or/relative/file.mp3')
    } catch (e) {
      out('error:', e?.message || e)
    }
  }

  on('cli', onCli)

  if (!enabled) {
    state.voiceChat.available = false
    state.voiceChat.pluginLoaded = false
    state.voiceChat.connected = false
    setVoiceError(state, null)
    return api
  }

  let simplevoice = null
  try {
    simplevoice = require('mineflayer-simplevoice')
  } catch (e) {
    state.voiceChat.available = false
    state.voiceChat.pluginLoaded = false
    state.voiceChat.connected = false
    setVoiceError(state, e)
    try { logger.warn && logger.warn('voice plugin unavailable:', e?.message || e) } catch {}
    return api
  }

  state.voiceChat.available = true
  setVoiceError(state, null)

  patchSimplevoiceSocketClient(logger, bot)

  try {
    const lvlRaw = process.env.MC_VOICECHAT_LOGLEVEL
    if (lvlRaw != null && typeof simplevoice?.setLoggingLevel === 'function') {
      const lvl = Number(lvlRaw)
      if (Number.isFinite(lvl)) simplevoice.setLoggingLevel(lvl)
    }
  } catch (e) {
    try { logger.warn && logger.warn('voice log level setup failed:', e?.message || e) } catch {}
  }

  try {
    if (typeof simplevoice?.plugin !== 'function') throw new Error('simplevoice plugin entry missing')
    bot.loadPlugin(simplevoice.plugin)
    state.voiceChat.pluginLoaded = true
    setVoiceError(state, null)
  } catch (e) {
    state.voiceChat.pluginLoaded = false
    state.voiceChat.connected = false
    setVoiceError(state, e)
    try { logger.warn && logger.warn('voice plugin load failed:', e?.message || e) } catch {}
    return api
  }

  function onConnect () {
    try {
      state.voiceChat.connected = true
      state.voiceChat.lastConnectAt = nowIso()
      setVoiceError(state, null)
      out('voicechat connected')
    } catch {}
  }

  function onDisconnect () {
    markDisconnected(null)
  }

  function onPlayerSound (data) {
    try {
      const sender = data && data.sender ? String(data.sender) : null
      if (!sender) return
      state.voiceChat.lastSpeaker = sender
      state.voiceChat.lastSpeakerAt = nowIso()
    } catch {}
  }

  on('voicechat_connect', onConnect)
  on('voicechat_disconnect', onDisconnect)
  on('voicechat_player_sound', onPlayerSound)
  on('spawn', () => {
    queueVoiceReconnect('spawn', 1500)
  })
  on('end', () => {
    markDisconnected('bot-end')
  })
  on('kicked', () => {
    markDisconnected('bot-kicked')
  })

  const recoverTicker = setInterval(() => {
    try {
      if (!isReadyState()) return
      if (api.isConnected()) return
      requestVoiceReconnect('periodic')
    } catch {}
  }, VOICE_RECOVER_INTERVAL_MS)
  try { if (typeof recoverTicker.unref === 'function') recoverTicker.unref() } catch {}
  registerCleanup && registerCleanup(() => {
    try { clearInterval(recoverTicker) } catch {}
  })

  queueVoiceReconnect('plugin-loaded', 1200)

  return api
}

module.exports = {
  install,
  _internal: { parseBool, normalizeAudioPath }
}
