// Auto-back: when the server prompts "使用/back命令回到死亡地点" (or English equivalent),
// immediately send /back and attempt to collect nearby drops for a short period.

const { Vec3 } = require('vec3')

const PROMPT_VALID_MS = 180000
const DEATH_ACK_GRACE_MS = 5000
const DUP_PROMPT_SUPPRESS_MS = 250
const BACK_RETRY_INTERVAL_MS = 5000
const BACK_RETRY_SPAWN_DELAY_MS = 1400

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
  if (typeof state.autoBackCooldownDeathId !== 'number') state.autoBackCooldownDeathId = 0
  if (typeof state.backInProgress !== 'boolean') state.backInProgress = false
  if (typeof state.backLastCmdAt !== 'number') state.backLastCmdAt = 0
  if (!state.deathChestInfo || typeof state.deathChestInfo !== 'object') state.deathChestInfo = null
  if (typeof state.deathChestTeleportReadyAt !== 'number') state.deathChestTeleportReadyAt = 0
  if (typeof state.deathChestTeleportAttemptId !== 'number') state.deathChestTeleportAttemptId = 0
  if (typeof state.autoBackDeathId !== 'number') state.autoBackDeathId = 0
  if (typeof state.autoBackActiveDeathId !== 'number') state.autoBackActiveDeathId = 0
  if (typeof state.autoBackAwaitingPrompt !== 'boolean') state.autoBackAwaitingPrompt = false
  if (typeof state.autoBackAwaitingRespawn !== 'boolean') state.autoBackAwaitingRespawn = false
  if (typeof state.autoBackPendingDeathAckId !== 'number') state.autoBackPendingDeathAckId = 0
  if (typeof state.autoBackPendingDeathAckAt !== 'number') state.autoBackPendingDeathAckAt = 0
  if (typeof state.backLastPromptAt !== 'number') state.backLastPromptAt = 0
  if (typeof state.autoBackLastDeathAt !== 'number') state.autoBackLastDeathAt = 0
  if (typeof state.autoBackWantedUntil !== 'number') state.autoBackWantedUntil = 0
  if (typeof state.autoBackWantedDeathId !== 'number') state.autoBackWantedDeathId = 0
  if (typeof state.autoBackRetryAt !== 'number') state.autoBackRetryAt = 0
  if (typeof state.autoBackRetryCount !== 'number') state.autoBackRetryCount = 0
  if (typeof state.autoBackLastDisconnectAt !== 'number') state.autoBackLastDisconnectAt = 0
  let attemptId = 0
  let fallbackCollectQueued = null
  let fallbackCollectPromise = null
  let backRetryTimer = null

  function hasActivePromptContext () {
    if (!state.autoBackActiveDeathId || state.autoBackActiveDeathId !== state.autoBackDeathId) return false
    const last = state.backLastPromptAt || 0
    return last > 0 && (Date.now() - last) <= PROMPT_VALID_MS
  }

  function hasWantedContext (now = Date.now()) {
    const until = state.autoBackWantedUntil || 0
    const wantedId = state.autoBackWantedDeathId || 0
    const deathId = state.autoBackDeathId || 0
    if (!until || now > until) return false
    if (!wantedId || wantedId !== deathId) return false
    return true
  }

  function markWantedContext (now, reason) {
    state.autoBackWantedDeathId = state.autoBackDeathId || 0
    state.autoBackWantedUntil = now + PROMPT_VALID_MS
    if (reason) debug('marked wanted back context', { deathId: state.autoBackWantedDeathId, reason })
  }

  function clearWantedContext (reason) {
    state.autoBackWantedUntil = 0
    state.autoBackWantedDeathId = 0
    state.autoBackRetryAt = 0
    state.autoBackRetryCount = 0
    state.autoBackAwaitingPrompt = false
    state.autoBackAwaitingRespawn = false
    if (reason) debug('cleared wanted back context', { reason })
  }

  function clearActiveBackContext (reason) {
    state.backInProgress = false
    state.autoBackActiveDeathId = 0
    state.autoBackAwaitingRespawn = false
    state.backLastPromptAt = 0
    state.autoBackPendingDeathAckId = 0
    state.autoBackPendingDeathAckAt = 0
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
    // Common CN teleport flow (Essentials-like)
    if (/正在回到先前的位置/.test(s)) return true
    if (/传送将在\s*\d+\s*秒内开始/.test(s) && /不要移动/.test(s)) return true
    if (/teleport/i.test(s) && /(prepare|preparing)/i.test(s)) return true
    if (/teleport will commence/i.test(s)) return true
    return false
  }

  function isDeathChestDisappeared (s) {
    if (!s) return false
    return /deathchest[^\n]*has disappeared/i.test(s) || /死亡箱子[^\n]*已(?:经)?消失/.test(s)
  }

  function isDeathChestLooted (s) {
    if (!s) return false
    return /successfully looted your deathchest/i.test(s) || /已成功(?:拾取|领取).*死亡箱子/i.test(s)
  }

  function isBackDenied (s) {
    if (!s) return false
    // Best-effort patterns: different servers/plugins vary a lot.
    if (/没有[^\n]*可[^\n]*返回/.test(s)) return true
    if (/无法[^\n]*返回/.test(s) && /back/i.test(s)) return true
    if (/你[^\n]*不能[^\n]*使用[^\n]*\/back/i.test(s)) return true
    if (/you (have )?no (previous|last) (location|position)/i.test(s)) return true
    if (/you can('| no)t use .*\/back/i.test(s)) return true
    if (/unknown command/i.test(s) && /\/back/i.test(s)) return true
    return false
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
    let teleportConfirmed = false
    try {
      debug('pickup routine started', { attemptId: id })
      // Allow teleport settle (base wait)
      await wait(1500)
      const waitTeleportUntil = Date.now() + 12000
      while (state.backInProgress && id === attemptId && state.deathChestTeleportAttemptId !== id && Date.now() < waitTeleportUntil) {
        debug('waiting for teleport readiness', { attemptId: id })
        await wait(200)
      }
      // If teleport never confirmed, don't start looting/pathing/collecting from a random position.
      if (id !== attemptId || !state.backInProgress) return
      if (state.deathChestTeleportAttemptId !== id) {
        debug('teleport not confirmed; aborting pickup routine', { attemptId: id })
        return
      }
      teleportConfirmed = true
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
      // If we didn't even confirm teleport, keep trying while still in the wanted window (prompt-missed/disconnect/cancel cases).
      if (attemptId === id && !teleportConfirmed && hasWantedContext()) scheduleBackRetry('teleport not confirmed', BACK_RETRY_INTERVAL_MS)
      // If teleport was confirmed and we completed the routine without being superseded, consider this death handled.
      if (attemptId === id && teleportConfirmed && hasWantedContext()) clearWantedContext('pickup routine finished after confirmed teleport')
      const queued = fallbackCollectQueued
      fallbackCollectQueued = null
      if (queued && queued.id === id) {
        debug('trigger fallback collect', queued)
        triggerFallbackCollect(queued)
      }
    }
  }

  function synthesizeDeathContextFromPrompt (now, message) {
    state.autoBackDeathId = (state.autoBackDeathId || 0) + 1
    state.autoBackAwaitingPrompt = true
    state.autoBackAwaitingRespawn = true
    state.autoBackActiveDeathId = 0
    state.backLastPromptAt = 0
    state.autoBackPendingDeathAckId = state.autoBackDeathId
    state.autoBackPendingDeathAckAt = now
    state.autoBackLastDeathAt = now
    markWantedContext(now, 'prompt-synthesized')
    debug('prompt arrived without prior death event; synthesized context', { deathId: state.autoBackDeathId, message })
  }

  function beginBackAttempt (now, source, opts = {}) {
    const hasPrompt = opts && opts.hasPrompt === true
    const currentDeathId = state.autoBackDeathId || 0
    if (now < (state.autoBackCooldownUntil || 0) && (state.autoBackCooldownDeathId || 0) === currentDeathId) return false
    state.autoBackCooldownUntil = now + 15000 // 15s debounce
    state.autoBackCooldownDeathId = currentDeathId
    state.autoBackAwaitingPrompt = false
    state.backInProgress = true
    state.autoBackActiveDeathId = state.autoBackDeathId
    if (hasPrompt) state.backLastPromptAt = now
    try { if (bot.state) bot.state.externalBusy = true } catch {}
    state.backLastCmdAt = now
    attemptId++
    state.deathChestTeleportAttemptId = 0
    state.deathChestTeleportReadyAt = 0
    const payload = { attemptId }
    if (source) payload.source = source
    payload.hasPrompt = hasPrompt
    debug('detected back prompt, issuing /back', payload)
    try { bot.chat('/back') } catch {}
    runPickupRoutine(attemptId).catch(() => {})
    return true
  }

  function scheduleBackRetry (reason, delayMs = BACK_RETRY_INTERVAL_MS) {
    try {
      if (!hasWantedContext()) return
      if (backRetryTimer) return
      const now = Date.now()
      const dueAt = Math.max(now + Math.max(50, delayMs), (state.autoBackRetryAt || 0) + BACK_RETRY_INTERVAL_MS)
      state.autoBackRetryAt = dueAt
      state.autoBackRetryCount = (state.autoBackRetryCount || 0) + 1
      backRetryTimer = setTimeout(() => {
        backRetryTimer = null
        const tsNow = Date.now()
        if (!hasWantedContext(tsNow)) return
        if (state.backInProgress) return
        if (tsNow - (state.backLastCmdAt || 0) < 800) return
        debug('retrying /back (wanted context)', { reason, retryCount: state.autoBackRetryCount, deathId: state.autoBackDeathId })
        beginBackAttempt(tsNow, `retry:${reason || 'unknown'}`, { hasPrompt: false })
      }, Math.max(0, dueAt - now))
    } catch {}
  }

  async function onMessage (message) {
    try {
      const s = normalizeMessage(message)
      const now = Date.now()
      if (isDeathChestLooted(s)) {
        clearWantedContext('deathchest looted')
        state.deathChestInfo = null
        clearActiveBackContext('deathchest looted')
      }
      if (isBackDenied(s)) {
        debug('back denied by server', { message: s })
        clearActiveBackContext('back denied')
        if (hasWantedContext(now)) scheduleBackRetry('back denied', BACK_RETRY_INTERVAL_MS)
        return
      }
      if (shouldTriggerBack(s)) {
        let source = 'chat'
        if (!state.autoBackAwaitingPrompt) {
          if (state.backInProgress) {
            const lastCmdAt = state.backLastCmdAt || 0
            const lastPromptAt = state.backLastPromptAt || 0
            if ((now - lastCmdAt) >= 0 && (now - lastCmdAt) < DUP_PROMPT_SUPPRESS_MS) {
              debug('suppressed duplicate /back prompt (already running)', { message: s })
              return
            }
            if ((now - lastPromptAt) >= 0 && (now - lastPromptAt) < DUP_PROMPT_SUPPRESS_MS) {
              debug('suppressed duplicate /back prompt (already running)', { message: s })
              return
            }
            debug('received /back prompt while already running; starting new attempt', { message: s })
          }
          synthesizeDeathContextFromPrompt(now, s)
          source = state.backInProgress ? 'prompt-while-running' : 'prompt-first'
        }
        beginBackAttempt(now, source, { hasPrompt: true })
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
        if (!hasWantedContext(now) && !hasActivePromptContext()) return
        // Re-issue /back shortly after (avoid immediate spam)
        if (now - (state.backLastCmdAt || 0) < 800) return
        debug('teleport request canceled, scheduling retry', { attemptId, backInProgress: state.backInProgress })
        if (state.backInProgress) {
          // Let the current routine exit; next attempt will supersede.
          try { state.backInProgress = false } catch {}
        }
        scheduleBackRetry('teleport canceled', 900)
        return
      }
    } catch {}
  }

  // If we respawn while in back flow, try /back again after a short delay
  on('respawn', () => {
    try {
      const now = Date.now()
      if (!state.backInProgress) {
        // Common failure mode: died during /back teleport; prompt may not repeat after respawn.
        if (hasWantedContext(now)) scheduleBackRetry('respawn resume', BACK_RETRY_SPAWN_DELAY_MS)
        if (state.autoBackAwaitingRespawn && !hasWantedContext(now)) state.autoBackAwaitingRespawn = false
        return
      }
      if (!state.autoBackAwaitingRespawn) return
      if (!hasActivePromptContext() && !hasWantedContext(now)) {
        clearActiveBackContext('stale respawn context')
        return
      }
      state.autoBackAwaitingRespawn = false
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
      const now = Date.now()
      const pendingAckId = state.autoBackPendingDeathAckId || 0
      const ackAge = now - (state.autoBackPendingDeathAckAt || 0)
      if (pendingAckId && pendingAckId === state.autoBackDeathId && ackAge >= 0 && ackAge <= DEATH_ACK_GRACE_MS && state.backInProgress) {
        state.autoBackPendingDeathAckId = 0
        state.autoBackPendingDeathAckAt = 0
        state.autoBackAwaitingRespawn = true
        debug('death event acknowledged for prompt-first flow', { deathId: state.autoBackDeathId })
        return
      }
      state.autoBackPendingDeathAckId = 0
      state.autoBackPendingDeathAckAt = 0
      attemptId++
      state.autoBackDeathId = (state.autoBackDeathId || 0) + 1
      state.autoBackLastDeathAt = now
      markWantedContext(now, 'death event')
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
      state.autoBackLastDisconnectAt = Date.now()
      // Keep wanted context across reconnects (bounded by autoBackWantedUntil).
      if (!hasWantedContext()) {
        state.autoBackAwaitingPrompt = false
      } else {
        state.autoBackAwaitingPrompt = true
      }
    } catch {}
  })

  on('spawn', () => {
    try {
      const now = Date.now()
      // After reconnect or respawn, /back prompts may not repeat. If we are within the wanted window, retry proactively.
      if (!hasWantedContext(now)) return
      if (state.backInProgress) return
      scheduleBackRetry('spawn resume', BACK_RETRY_SPAWN_DELAY_MS)
    } catch {}
  })

  on('message', onMessage)
  registerCleanup && registerCleanup(() => {
    fallbackCollectQueued = null
    try { if (backRetryTimer) clearTimeout(backRetryTimer) } catch {}
    backRetryTimer = null
    try { bot.off('message', onMessage) } catch {}
  })
}

module.exports = { install }
