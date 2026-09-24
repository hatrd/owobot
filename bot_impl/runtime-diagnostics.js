// Bounded process telemetry. Data survives reload; resource handles are replaced.
const { monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks')
const SAMPLE_MS = 30000
const MAX_SAMPLES = 240

function size (value) {
  if (value instanceof Map || value instanceof Set) return value.size
  if (Array.isArray(value)) return value.length
  return value && typeof value === 'object' ? Object.keys(value).length : 0
}

function listenerCounts (emitter) {
  if (typeof emitter?.eventNames !== 'function') return { total: 0, byEvent: {} }
  const byEvent = Object.fromEntries(emitter.eventNames().map(name => [String(name), emitter.listenerCount(name)]))
  return { total: Object.values(byEvent).reduce((a, b) => a + b, 0), byEvent }
}

function collectSample (bot, reason = 'interval', telemetry = {}) {
  const state = bot.state || {}
  let columns = null
  try { columns = bot.world?.getColumns ? bot.world.getColumns().length : null } catch {}
  return {
    at: Date.now(), reason, pid: process.pid, uptimeSec: Math.round(process.uptime()),
    memory: process.memoryUsage(), // bytes; arrayBuffers is included in external, not additive
    eventLoop: telemetry.eventLoop || null,
    gc: telemetry.gc || null,
    counts: {
      entities: size(bot.entities), players: size(bot.players), columns,
      aiRecent: size(state.aiRecent), aiDialogues: size(state.aiDialogues),
      aiContextBus: size(state.aiContextBus), aiToolDecisions: size(state.aiToolDecisions), aiMemory: size(state.aiMemory?.entries),
      aiMemoryQueue: size(state.aiMemory?.queue), aiRecentReplies: size(state.aiRecentReplies),
      commitments: size(state.aiPeople?.commitments), cleanups: size(state.cleanups),
      skillTasks: size(bot._skillRunnerState?.tasks)
    },
    listeners: { bot: listenerCounts(bot), client: listenerCounts(bot._client) }
  }
}

function install (bot, { state = bot.state, on, registerCleanup } = {}) {
  const d = state.runtimeDiagnostics = state.runtimeDiagnostics || {}
  if (typeof d.stop === 'function') d.stop()
  d.samples = Array.isArray(d.samples) ? d.samples.slice(-MAX_SAMPLES) : []
  d.reloads = (d.reloads || 0) + 1
  d.sampleMs = SAMPLE_MS
  d.maxSamples = MAX_SAMPLES
  let gc = { count: 0, durationMs: 0, maxMs: 0 }
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gc.count++
      gc.durationMs += entry.duration
      gc.maxMs = Math.max(gc.maxMs, entry.duration)
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  function sample (reason = 'interval') {
    const hasDelay = delay.count > 0
    const current = collectSample(bot, reason, {
      eventLoop: { p99Ms: hasDelay ? delay.percentile(99) / 1e6 : 0, maxMs: hasDelay ? delay.max / 1e6 : 0 },
      gc: { ...gc }
    })
    delay.reset()
    gc = { count: 0, durationMs: 0, maxMs: 0 }
    d.samples.push(current)
    if (d.samples.length > MAX_SAMPLES) d.samples.splice(0, d.samples.length - MAX_SAMPLES)
  }
  const timer = setInterval(sample, SAMPLE_MS)
  timer.unref?.()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    delay.disable()
    observer.disconnect()
    if (d.stop === stop) d.stop = null
  }
  d.stop = stop
  registerCleanup?.(stop)
  on?.('end', () => sample('disconnect'))
  sample('activate')
}

function read (bot, { max = 20 } = {}) {
  const d = bot.state?.runtimeDiagnostics
  if (!d?.samples?.length) return { ok: false, msg: 'Runtime diagnostics not installed', error: 'diagnostics_unavailable', data: null }
  const limit = Math.min(MAX_SAMPLES, Math.max(1, Number(max) || 20))
  const samples = d.samples.slice(-limit)
  const first = samples[0]
  const latest = samples[samples.length - 1]
  const deltaBytes = Object.fromEntries(Object.keys(latest.memory).map(key => [key, latest.memory[key] - first.memory[key]]))
  return {
    ok: true,
    msg: `Runtime diagnostics: ${samples.length} samples, RSS ${(latest.memory.rss / 1048576).toFixed(1)} MiB`,
    data: JSON.parse(JSON.stringify({
      sampleMs: d.sampleMs, maxSamples: d.maxSamples, reloads: d.reloads,
      ageMs: Date.now() - latest.at, windowMs: latest.at - first.at, deltaBytes, samples
    }))
  }
}

module.exports = { install, read, collectSample }
