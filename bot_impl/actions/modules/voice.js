module.exports = function registerVoiceTools (ctx) {
  const { bot, register, ok, fail } = ctx
  const VOICE_PRESET_MAP = Object.freeze({
    ciallo: 'voice/Ciallo.aac'
  })

  function normalizePresetKey (value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    return raw.toLowerCase().replace(/\s+/g, '')
  }

  async function voice_status () {
    const api = bot.voiceChat
    if (!api || typeof api.status !== 'function') return fail('语音模块未加载')
    const status = api.status()
    const parts = [
      `enabled=${status.enabled ? '1' : '0'}`,
      `available=${status.available ? '1' : '0'}`,
      `pluginLoaded=${status.pluginLoaded ? '1' : '0'}`,
      `connected=${status.connected ? '1' : '0'}`
    ]
    if (status.lastSpeaker) parts.push(`lastSpeaker=${status.lastSpeaker}`)
    if (status.lastAudioPath) parts.push(`lastAudio=${status.lastAudioPath}`)
    if (status.lastError) parts.push(`error=${status.lastError}`)
    return ok(`语音状态: ${parts.join(' ')}`, { data: status })
  }

  async function voice_speak (args = {}) {
    const api = bot.voiceChat
    if (!api || typeof api.play !== 'function') return fail('语音模块未加载')

    const sourceRaw = String(args.source ?? args.kind ?? '').trim().toLowerCase()
    const source = sourceRaw || 'preset'
    if (source !== 'preset') {
      return fail('暂不支持该语音来源(source)，目前仅支持 preset', {
        source,
        supportedSources: ['preset']
      })
    }

    const presetKey = normalizePresetKey(args.preset ?? args.name ?? args.text ?? 'ciallo')
    const audioPath = VOICE_PRESET_MAP[presetKey]
    if (!audioPath) {
      return fail('不支持的语音预设(preset)', {
        preset: presetKey || null,
        supportedPresets: Object.keys(VOICE_PRESET_MAP)
      })
    }

    const res = await api.play(audioPath)
    if (res?.ok) {
      return ok(res.msg || '已发送语音音频', {
        source: 'preset',
        preset: presetKey
      })
    }
    return fail((res && res.msg) || '发送语音失败', {
      source: 'preset',
      preset: presetKey,
      error: res?.error || null,
      status: res?.status || null
    })
  }

  register('voice_status', voice_status)
  register('voice_speak', voice_speak)
}
