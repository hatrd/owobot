const { Worker } = require('worker_threads')
const { Vec3 } = require('vec3')
const { randomUUID, createHash } = require('crypto')
const path = require('path')
const yieldLoop = () => new Promise(resolve => setImmediate(resolve))
async function capture (bot, args = {}) {
  if (!bot.entity?.position || !bot.state?.hasSpawned) return { ok: false, msg: 'View unavailable', error: 'not_spawned' }
  const state = bot.state
  const captureState = state.controllerView ||= { busy: false }
  if (captureState.busy) return { ok: false, msg: 'View busy', error: 'capture_busy' }
  captureState.busy = true
  const startedAt = Date.now()
  const api = state.controllerApi
  const eyePos = bot.entity.position.offset(0, bot.entity.eyeHeight || (bot.entity.height ? bot.entity.height * 0.9 : 1.62), 0)
  const eye = [eyePos.x, eyePos.y, eyePos.z]
  const radius = Math.max(4, Math.min(16, Number.isFinite(args.radius) ? Math.floor(args.radius) : 12))
  const size = radius * 2 + 1
  const origin = eye.map(a => Math.floor(a) - radius)
  const grid = new Int16Array(size ** 3)
  const palette = [null]
  const ids = new Map()
  const yaw = bot.entity.yaw || 0
  const pitch = bot.entity.pitch || 0
  const dimension = bot.game?.dimension
  let unknown = 0
  try {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
        const block = bot.blockAt(new Vec3(origin[0] + x, origin[1] + y, origin[2] + z), false)
        const index = (y * size + z) * size + x
        if (!block) { grid[index] = -1; unknown++; continue }
        if (block.boundingBox === 'empty') continue
        if (!ids.has(block.name)) {
          const digest = createHash('sha256').update(block.name).digest()
          ids.set(block.name, palette.length)
          palette.push({ name: block.name, rgb: [...digest.subarray(0, 3)].map(v => 70 + v % 160) })
        }
        grid[index] = ids.get(block.name)
      }
      await yieldLoop()
      if (Date.now() - startedAt > 3000) throw new Error('capture_timeout')
      if (!state.hasSpawned || state.controllerApi !== api || dimension !== bot.game?.dimension) throw new Error('capture_invalidated')
    }
    const base64 = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'view-worker.js'), { workerData: { grid, size, origin, eye, yaw, pitch, palette, radius }, resourceLimits: { maxOldGenerationSizeMb: 64 } })
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('render_timeout')) }, 3000)
      const done = () => clearTimeout(timer)
      worker.once('message', image => { done(); resolve(image) })
      worker.once('error', error => { done(); reject(error) })
      worker.once('exit', code => { done(); if (code) reject(new Error(`renderer_exit_${code}`)) })
    })
    if (!state.hasSpawned || state.controllerApi !== api || dimension !== bot.game?.dimension) throw new Error('capture_invalidated')
    return { ok: true, msg: 'Voxel view: synthetic block colors; entities, textures and UI omitted', data: {
      frameId: randomUUID(), capturedAt: startedAt, completedAt: Date.now(), epoch: state.controller?.epoch || 0,
      runtimeId: state.controller?.runtimeId, dimension, eye, yaw, pitch, radius, width: 160, height: 100, mimeType: 'image/png', base64,
      renderer: 'voxel', palette: palette.slice(1), unknownBlocks: unknown,
      limitations: ['solid blocks approximated as full cubes', 'synthetic colors; palette names are authoritative', 'no entities, fluids, lighting, textures or UI', 'world collected over an interval; not an atomic snapshot']
    } }
  } catch (err) { return { ok: false, msg: 'View failed', error: String(err.message || err) } }
  finally { captureState.busy = false }
}
module.exports = { capture }
