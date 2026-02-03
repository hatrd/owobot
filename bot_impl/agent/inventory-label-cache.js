// Inventory label cache: asynchronously parse item NBT to extract human-facing labels
// Used to enrich observer snapshot without blocking the main loop.

function stripColorCodes (s) {
  try { return String(s || '').replace(/\u00a7./g, '') } catch { return '' }
}

async function parseNbtToSimplifiedTag (raw) {
  if (!raw) return null
  try {
    const nbt = require('prismarine-nbt')
    const simplify = nbt.simplify || ((x) => x)
    if (raw.type && raw.value) return simplify(raw)
    if (raw.parsed && raw.parsed.type && raw.parsed.value) return simplify(raw.parsed)
    if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      const parsed = await nbt.parse(raw)
      if (parsed && parsed.parsed) return simplify(parsed.parsed)
      if (parsed && parsed.type && parsed.value) return simplify(parsed)
      return null
    }
    if (typeof raw === 'object') return raw
  } catch {}
  return null
}

function makeLabelFromTag (itemName, tag) {
  try {
    const { toPlainText } = require('../actions/lib/book')
    const id = String(itemName || '').toLowerCase()
    if (id === 'written_book' || id === 'writable_book') {
      const title = stripColorCodes(toPlainText(tag?.title || '')).trim()
      if (title) return title
    }
    const custom = stripColorCodes(toPlainText(tag?.display?.Name || '')).trim()
    return custom || null
  } catch {
    return null
  }
}

function ensureStateCache (state) {
  if (!state.invLabels) state.invLabels = { bySlot: {} }
  if (!state.invLabels.bySlot) state.invLabels.bySlot = {}
  return state.invLabels
}

function install (bot, { state, on, registerCleanup, log } = {}) {
  const st = state || bot?.state || {}
  const cache = ensureStateCache(st)

  let timer = null
  let running = false
  let pending = false

  async function refreshOnce () {
    if (running) { pending = true; return }
    running = true
    pending = false
    try {
      const slots = bot.inventory?.slots || []
      for (let i = 0; i < slots.length; i++) {
        const it = slots[i]
        if (!it || !it.name) { cache.bySlot[String(i)] = ''; continue }
        const raw = it.nbt
        if (!raw) { cache.bySlot[String(i)] = ''; continue }
        const tag = await parseNbtToSimplifiedTag(raw)
        if (!tag) { cache.bySlot[String(i)] = ''; continue }
        const label = makeLabelFromTag(it.name, tag)
        cache.bySlot[String(i)] = label || ''
      }
    } catch (e) {
      try { log?.warn && log.warn('inv label cache refresh error', e?.message || e) } catch {}
    } finally {
      running = false
      if (pending) schedule('pending')
    }
  }

  function schedule (reason) {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      refreshOnce().catch(() => {})
    }, 120)
    try { if (process.env.MC_DEBUG === '1') log?.debug && log.debug('inv label cache scheduled', reason || '') } catch {}
  }

  const kick = () => schedule('event')

  // Best-effort hooks (mineflayer events vary by version/implementation)
  try { on && on('spawn', kick) } catch {}
  try { on && on('heldItemChanged', kick) } catch {}
  try { on && on('windowUpdate', kick) } catch {}
  try { on && on('setSlot', kick) } catch {}
  try { on && on('inventoryUpdate', kick) } catch {}
  try { on && on('playerCollect', kick) } catch {}

  // Initial warm-up
  schedule('init')

  registerCleanup && registerCleanup(() => { try { if (timer) clearTimeout(timer) } catch {} })
  return { refresh: refreshOnce, schedule }
}

module.exports = { install }

