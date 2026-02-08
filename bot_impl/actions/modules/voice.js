module.exports = function registerVoiceTools (ctx) {
  const { bot, register, ok, fail } = ctx

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

  async function voice_play (args = {}) {
    const api = bot.voiceChat
    if (!api || typeof api.play !== 'function') return fail('语音模块未加载')
    const rawPath = (() => {
      if (args.path != null) return String(args.path)
      if (args.file != null) return String(args.file)
      if (args.audio != null) return String(args.audio)
      return ''
    })().trim()
    if (!rawPath) return fail('缺少音频路径(path)')

    const res = await api.play(rawPath)
    if (res?.ok) return ok(res.msg || '已发送语音音频', { path: res.path })
    return fail((res && res.msg) || '发送语音失败', { error: res?.error || null, status: res?.status || null })
  }

  register('voice_status', voice_status)
  register('voice_play', voice_play)
}
