// Auto-back: when the server prompts "使用/back命令回到死亡地点" (or English equivalent),
// immediately send /back and attempt to collect nearby drops for a short period.

const { Vec3 } = require('vec3')

const PROMPT_VALID_MS = 180000

function wait (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function install (bot, { on, state, log, dlog, registerCleanup }) {
  const L = log
  function debug (...args) {
    const payload = ['[auto-back]', ...args]
    try { if (typeof dlog === 'function') dlog(...payload) } catch {}
    try {
      if (L && typeof L.info === 'function') L.info(...payload)
      else console.log(...payload)
    } catch {
      try { console.log(...payload) } catch {}
    }
  }

  if (typeof state.autoBackCooldownUntil !== 'number') state.autoBackCooldownUntil = 0
  if (typeof state.backInProgress !== 'boolean') state.backInProgress = false
  if (typeof state.backLastCmdAt !== 'number') state.backLastCmdAt = 0
  if (!state.deathChestInfo || typeof state.deathChestInfo !== 'object') state.deathChestInfo = null
  if (typeof state.deathChestTeleportReadyAt !== 'number') state.deathChestTeleportReadyAt = 0
  if (typeof state.deathChestTeleportAttemptId !== 'number') state.deathChestTeleportAttemptId = 0
  if (typeof state.autoBackDeathId !== 'number') state.autoBackDeathId = 0
  if (typeof state.autoBackActiveDeathId !== 'number') state.autoBackActiveDeathId = 0
  if (typeof state.autoBackAwaitingPrompt !== 'boolean') state.autoBackAwaitingPrompt = false
  if (typeof state.autoBackAwaitingRespawn !== 'boolean') state.autoBackAwaitingRespawn = false
  if (typeof state.backLastPromptAt !== 'number') state.backLastPromptAt = 0
  let attemptId = 0
  let fallbackCollectQueued = null
  let fallbackCollectPromise = null

  function hasActivePromptContext () {
    if (!state.autoBackActiveDeathId || state.autoBackActiveDeathId !== state.autoBackDeathId) return false
    const last = state.backLastPromptAt || 0
    return last > 0 && (Date.now() - last) <= PROMPT_VALID_MS
  }

  function clearActiveBackContext (reason) {
    state.backInProgress = false
    state.autoBackActiveDeathId = 0
    state.autoBackAwaitingRespawn = false
    state.backLastPromptAt = 0
    if (reason) debug('auto-back context cleared', { reason })
  }

  function normalizeMessage (message) {
    try {
      const text = typeof message.getText === 'function' ? message.getText() : (typeof message.toString === 'function' ? message.toString() : String(message))
      return (text || '').replace(/\u00a7./g, '')
    } catch { return '' }
  }

  function shouldTriggerBack (s) {
    const t = String(s || '')
    if (!t) return false
    // Common CN variants
    if (/使用\s*\/back.*死亡地点/i.test(t)) return true
    if (/(回到|返回).*死亡地点/i.test(t) && /\/back/i.test(t)) return true
    // EN variants
    if (/use\s*\/back.*death/i.test(t)) return true
    if (/return\s+to\s+(your\s+)?death(\s+(point|location|spot))?/i.test(t)) return true
    return false
  }

  function parseDeathChestLocation (s) {
    if (!s) return null
    const english = /\bdeathchest\b[^\n]*?x:\s*(-?\d+),\s*y:\s*(-?\d+),\s*z:\s*(-?\d+)(?:,\s*world:\s*([A-Za-z0-9_:-]+))?/i
    const matchEn = s.match(english)
    if (matchEn) {
      return {
        x: Number(matchEn[1]),
        y: Number(matchEn[2]),
        z: Number(matchEn[3]),
        world: matchEn[4] ? String(matchEn[4]).trim() : null
      }
    }
    const chinese = /死亡箱子[^\n]*?x[:：]\s*(-?\d+)[,，]\s*y[:：]\s*(-?\d+)[,，]\s*z[:：]\s*(-?\d+)(?:[,，]\s*世界[:：]\s*([\w:-]+))?/i
    const matchCn = s.match(chinese)
    if (matchCn) {
      return {
        x: Number(matchCn[1]),
        y: Number(matchCn[2]),
        z: Number(matchCn[3]),
        world: matchCn[4] ? String(matchCn[4]).trim() : null
      }
    }
    return null
  }

  function isTeleportPreparing (s) {
    if (!s) return false
    if (/准备传送/.test(s)) return true
    if (/teleport/i.test(s) && /(prepare|preparing)/i.test(s)) return true
    if (/teleport will commence/i.test(s)) return true
    return false
  }

  function isDeathChestDisappeared (s) {
    if (!s) return false
    return /deathchest[^\n]*has disappeared/i.test(s) || /死亡箱子[^\n]*已(?:经)?消失/.test(s)
  }

  function findContainerBlock (pos) {
    if (!pos) return null
    try {
      const base = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
      const variants = [
        base,
        base.offset(1, 0, 0),
        base.offset(-1, 0, 0),
        base.offset(0, 0, 1),
        base.offset(0, 0, -1),
        base.offset(0, 1, 0),
        base.offset(0, -1, 0),
        base.offset(1, 0, 1),
        base.offset(1, 0, -1),
        base.offset(-1, 0, 1),
        base.offset(-1, 0, -1),
        base.offset(1, 1, 0),
        base.offset(-1, 1, 0),
        base.offset(0, 1, 1),
        base.offset(0, 1, -1)
      ]
      for (const candidate of variants) {
        const block = bot.blockAt(candidate)
        const name = block && block.name ? String(block.name).toLowerCase() : ''
        if (!block) continue
        if (name.includes('chest') || name.includes('barrel') || name.includes('shulker_box')) return block
      }
    } catch {}
    return null
  }

  async function lootContainerAt (pos) {
    if (!pos) return false
    let container = null
    try {
      const block = findContainerBlock(pos)
      if (!block) {
        debug('no container block found near position', pos)
        return false
      }
      debug('found container block', { pos, name: block?.name })
      try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
      if (typeof bot.activateBlock === 'function') {
        try { await bot.activateBlock(block) } catch {}
      }
      await wait(120)
      container = await bot.openContainer(block)
    } catch (err) {
      dlog && dlog('deathchest: open container failed:', err?.message || err)
      debug('open container failed', err?.message || err)
      return false
    }
    let moved = false
    try {
      const slots = container.slots || []
      const limit = typeof container.inventoryStart === 'number' && container.inventoryStart > 0 ? container.inventoryStart : slots.length
      for (let i = 0; i < limit; i++) {
        const item = slots[i]
        if (!item || !item.count) continue
        debug('withdrawing item', { name: item.name, count: item.count, slot: i })
        try { await container.withdraw(item.type, item.metadata, item.count, item.nbt) } catch (err) {
          dlog && dlog('deathchest: withdraw error:', err?.message || err)
        }
        moved = true
        await wait(160)
      }
    } finally {
      try { container.close() } catch {}
    }
    return moved
  }

  async function ensureNearPosition (actions, targetPos, id) {
    try {
      const me = bot.entity?.position
      if (!me) return false
      const dist = me.distanceTo(targetPos)
      if (Number.isFinite(dist) && dist <= 4.2) return true
      if (!actions) return false
      debug('moving towards death chest', { attemptId: id, from: { x: me.x, y: me.y, z: me.z }, target: { x: targetPos.x, y: targetPos.y, z: targetPos.z } })
      const res = await actions.run('goto', { x: targetPos.x, y: targetPos.y, z: targetPos.z, range: 2.4 })
      debug('goto result', { attemptId: id, ok: res?.ok, msg: res?.msg })
      if (res && res.ok === false) return false
      const deadline = Date.now() + 6500
      while (Date.now() < deadline) {
        if (id != null && id !== attemptId) return false
        const cur = bot.entity?.position
        if (!cur) break
        const d = cur.distanceTo(targetPos)
        debug('distance to death chest', { attemptId: id, dist: d?.toFixed ? Number(d.toFixed(2)) : d })
        if (Number.isFinite(d) && d <= 4.2) {
          try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
          await wait(80)
          return true
        }
        await wait(180)
      }
      try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
      return false
    } catch { return false }
  }

  async function lootDeathChestIfPossible (actions, id) {
    try {
      if (id !== attemptId || !state.backInProgress) return false
      const info = state.deathChestInfo
      if (!info || !Number.isFinite(info.x) || !Number.isFinite(info.y) || !Number.isFinite(info.z)) return false
      const targetPos = new Vec3(info.x, info.y, info.z)
      let success = false
      for (let attempt = 0; attempt < 3; attempt++) {
        debug('ensure near death chest', { attemptId: id, attempt, target: info })
        const near = await ensureNearPosition(actions, targetPos, id)
        if (!near) {
          debug('not close enough yet', { attemptId: id, attempt })
          await wait(200)
          continue
        }
        success = await lootContainerAt(targetPos)
        if (success) break
        await wait(250)
        debug('loot attempt retry', { attemptId: id, attempt })
        if (id !== attemptId || !state.backInProgress) return false
      }
      if (success) state.deathChestInfo = null
      debug('loot attempt finished', { attemptId: id, success })
      return success
    } catch (err) {
      dlog && dlog('deathchest: loot error:', err?.message || err)
      return false
    }
  }

  function queueFallbackCollect (info) {
    fallbackCollectQueued = info
    debug('queued fallback collect', info)
  }

  function triggerFallbackCollect (info) {
    if (!info) return
    if (fallbackCollectPromise) return
    debug('starting fallback collect', info)
    let actions = null
    try { actions = require('./actions').install(bot, { log: L }) } catch {}
    if (!actions) return
    fallbackCollectPromise = (async () => {
      try { bot.emit('external:begin', { source: 'auto', tool: 'back_collect_fallback' }) } catch {}
      try { if (bot.state) bot.state.externalBusy = true } catch {}
      try {
        await wait(250)
        await actions.run('collect', { radius: 16, max: 200, timeoutMs: 10000, until: 'timeout', includeNew: true })
      } catch (err) {
        dlog && dlog('deathchest: fallback collect error:', err?.message || err)
      } finally {
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
        try { bot.clearControlStates() } catch {}
        try { bot.emit('external:end', { source: 'auto', tool: 'back_collect_fallback' }) } catch {}
        try { if (bot.state) bot.state.externalBusy = false } catch {}
      }
    })()
    fallbackCollectPromise.finally(() => { fallbackCollectPromise = null })
    fallbackCollectPromise.then(() => debug('fallback collect finished', info)).catch(err => debug('fallback collect error', err?.message || err))
  }

  async function runPickupRoutine (id) {
    let actions = null
    try { actions = require('./actions').install(bot, { log: L }) } catch {}
    if (!actions) return
    try { bot.emit('external:begin', { source: 'auto', tool: 'back_collect' }) } catch {}
    try { if (bot.state) bot.state.externalBusy = true } catch {}
    try {
      debug('pickup routine started', { attemptId: id })
      // Allow teleport settle (base wait)
      await wait(1500)
      const waitTeleportUntil = Date.now() + 10000
      while (state.backInProgress && id === attemptId && state.deathChestTeleportAttemptId !== id && Date.now() < waitTeleportUntil) {
        debug('waiting for teleport readiness', { attemptId: id })
        await wait(200)
      }
      if (state.deathChestTeleportAttemptId === id) {
        const extra = (state.deathChestTeleportReadyAt || 0) + 2000 - Date.now()
        if (extra > 0) await wait(extra)
      }
      // If a newer attempt superseded this one, abort silently
      if (id !== attemptId || !state.backInProgress) return
      debug('begin loot attempt', { attemptId: id, hasInfo: !!state.deathChestInfo })
      const looted = await lootDeathChestIfPossible(actions, id)
      debug('loot attempt result', { attemptId: id, looted })
      if (id !== attemptId || !state.backInProgress) return
      debug('starting collect sweep', { attemptId: id })
      await actions.run('collect', { radius: 16, max: 200, timeoutMs: 12000, until: 'timeout', includeNew: true })
    } catch {} finally {
      try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      try { bot.emit('external:end', { source: 'auto', tool: 'back_collect' }) } catch {}
      try { if (bot.state) bot.state.externalBusy = false } catch {}
      // Clear back-in-progress after routine finishes (or is skipped)
      if (attemptId === id) clearActiveBackContext('pickup routine finished')
      const queued = fallbackCollectQueued
      fallbackCollectQueued = null
      if (queued && queued.id === id) {
        debug('trigger fallback collect', queued)
        triggerFallbackCollect(queued)
      }
    }
  }

  async function onMessage (message) {
    try {
      const s = normalizeMessage(message)
      const now = Date.now()
      if (shouldTriggerBack(s)) {
        if (!state.autoBackAwaitingPrompt) {
          debug('ignored /back prompt without matching death', { message: s })
          return
        }
        if (now < (state.autoBackCooldownUntil || 0)) return
        state.autoBackCooldownUntil = now + 15000 // 15s debounce
        state.autoBackAwaitingPrompt = false
        state.backInProgress = true
        state.autoBackActiveDeathId = state.autoBackDeathId
        state.backLastPromptAt = now
        try { if (bot.state) bot.state.externalBusy = true } catch {}
        state.backLastCmdAt = now
        attemptId++
        debug('detected back prompt, issuing /back', { attemptId })
        try { bot.chat('/back') } catch {}
        // Run pickup routine but do not block the main thread
        runPickupRoutine(attemptId).catch(() => {})
        return
      }
      const info = parseDeathChestLocation(s)
      if (info) {
        state.deathChestInfo = info
        debug('parsed death chest location', info)
      }
      if (isTeleportPreparing(s)) {
        state.deathChestTeleportReadyAt = now
        state.deathChestTeleportAttemptId = attemptId
        debug('teleport preparation message', { attemptId })
      }
      if (isDeathChestDisappeared(s)) {
        const payload = { id: attemptId, at: now }
        state.deathChestInfo = null
        debug('death chest disappeared message', payload)
        if (state.backInProgress) queueFallbackCollect(payload)
        else triggerFallbackCollect(payload)
      }
      // Retry if teleport request got canceled
      if (/待处理的传送请求已被取消/i.test(s)) {
        if (!state.backInProgress || !hasActivePromptContext()) return
        // Re-issue /back shortly after (avoid immediate spam)
        if (now - (state.backLastCmdAt || 0) < 800) return
        debug('teleport request canceled, scheduling retry', { attemptId })
        setTimeout(() => {
          try {
            state.backLastCmdAt = Date.now()
            attemptId++
            state.backInProgress = true
            debug('retrying /back after cancel', { attemptId })
            bot.chat('/back')
            runPickupRoutine(attemptId).catch(() => {})
          } catch {}
        }, 800)
        return
      }
    } catch {}
  }

  // If we respawn while in back flow, try /back again after a short delay
  on('respawn', () => {
    try {
      if (state.autoBackAwaitingRespawn && !state.backInProgress) state.autoBackAwaitingRespawn = false
      if (!state.backInProgress) return
      if (!state.autoBackAwaitingRespawn) return
      if (!hasActivePromptContext()) {
        clearActiveBackContext('stale respawn context')
        return
      }
      state.autoBackAwaitingRespawn = false
      const now = Date.now()
      if (now - (state.backLastCmdAt || 0) < 800) return
      debug('respawn detected, scheduling /back retry')
      setTimeout(() => {
        try {
          state.backLastCmdAt = Date.now()
          attemptId++
          state.backInProgress = true
          debug('retrying /back after respawn', { attemptId })
          bot.chat('/back')
          runPickupRoutine(attemptId).catch(() => {})
        } catch {}
      }, 800)
    } catch {}
  })

  on('death', () => {
    try {
      attemptId++
      state.autoBackDeathId = (state.autoBackDeathId || 0) + 1
      state.autoBackAwaitingPrompt = true
      state.autoBackAwaitingRespawn = true
      state.autoBackActiveDeathId = 0
      state.backLastPromptAt = 0
      state.backInProgress = false
      debug('death detected, waiting for /back prompt', { deathId: state.autoBackDeathId })
    } catch {}
  })

  on('end', () => {
    try {
      fallbackCollectQueued = null
      clearActiveBackContext('bot disconnected')
      state.autoBackAwaitingPrompt = false
    } catch {}
  })

  on('message', onMessage)
  registerCleanup && registerCleanup(() => {
    fallbackCollectQueued = null
    try { bot.off('message', onMessage) } catch {}
  })
}

module.exports = { install }
