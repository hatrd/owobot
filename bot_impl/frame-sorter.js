const { Vec3 } = require('vec3')
const actionsMod = require('./actions')

function itemKey (item) {
  if (!item) return null
  const name = String(item.name || item.displayName || '')
  return name ? name.toLowerCase() : null
}

function clonePos (v) {
  if (!v) return { x: 0, y: 0, z: 0 }
  return { x: v.x, y: v.y, z: v.z }
}

function nbtEquals (a, b) {
  if (a === b) return true
  if (!a || !b) return !a && !b
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function availableInventoryCapacity (bot, item) {
  try {
    const stackSize = item.stackSize || (bot.registry?.items?.[item.type]?.stackSize) || 64
    let free = 0
    const slots = bot.inventory?.slots || []
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i]
      if (!it) {
        free += stackSize
        continue
      }
      if (it.type !== item.type) continue
      if (item.metadata != null && it.metadata !== item.metadata) continue
      if (!nbtEquals(item.nbt, it.nbt)) continue
      const sz = it.stackSize || stackSize
      free += Math.max(0, sz - (it.count || 0))
    }
    return free
  } catch { return 0 }
}

function scanFrames (bot, radius = 12) {
  const pos = bot.entity?.position
  if (!pos) {
    return {
      ok: false,
      reason: 'unready',
      frames: [],
      framedChests: [],
      unframedChests: []
    }
  }

  const Item = require('prismarine-item')(bot.version)
  const clampRadius = Math.max(2, Math.min(80, Number(radius) || 12))
  const center = pos.clone()

  const round = (n, precision = 2) => {
    if (!Number.isFinite(n)) return null
    const f = 10 ** precision
    return Math.round(n * f) / f
  }
  const posKey = (v) => `${v.x},${v.y},${v.z}`
  const clusterKeyOf = (positions) => {
    if (!Array.isArray(positions) || !positions.length) return null
    const parts = []
    for (const pos of positions) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') continue
      parts.push(posKey(pos))
    }
    if (!parts.length) return null
    parts.sort()
    return parts.join('|')
  }

  const summarizeRaw = (raw) => {
    try {
      if (!raw || typeof raw !== 'object') return String(raw)
      const parts = []
      for (const [k, v] of Object.entries(raw)) {
        if (parts.length >= 6) break
        if (Array.isArray(v)) parts.push(`${k}:array(${v.length})`)
        else parts.push(`${k}:${typeof v}`)
      }
      return parts.join('|') || 'object'
    } catch { return 'uninspectable' }
  }

  const unwrapItemMeta = (raw, depth = 0) => {
    if (!raw || typeof raw !== 'object') return null
    if (depth > 5) return raw
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const res = unwrapItemMeta(entry, depth + 1)
        if (res) return res
      }
      return null
    }
    if (raw.item) return unwrapItemMeta(raw.item, depth + 1)
    if (raw.value) return unwrapItemMeta(raw.value, depth + 1)
    if (raw.data) return unwrapItemMeta(raw.data, depth + 1)
    if (raw.contents) return unwrapItemMeta(raw.contents, depth + 1)
    return raw
  }

  const attachedBlockPos = (entity) => {
    try {
      const base = entity.position.floored()
      const dx = entity.position.x - base.x
      const dy = entity.position.y - base.y
      const dz = entity.position.z - base.z
      const edgeDist = (d) => Math.min(Math.abs(d), Math.abs(1 - d))
      const axes = [
        { axis: 'x', dist: edgeDist(dx), dir: dx >= 0.5 ? 1 : -1 },
        { axis: 'y', dist: edgeDist(dy), dir: dy >= 0.5 ? 1 : -1 },
        { axis: 'z', dist: edgeDist(dz), dir: dz >= 0.5 ? 1 : -1 }
      ]
      axes.sort((a, b) => a.dist - b.dist)
      const best = axes[0]
      if (!best || best.dist > 0.35) return base
      const out = base.clone()
      if (best.axis === 'x') {
        out.x += best.dir > 0 ? 1 : -1
      } else if (best.axis === 'y') {
        if (best.dir > 0) out.y += 1
        else out.y -= 1
      } else if (best.axis === 'z') {
        out.z += best.dir > 0 ? 1 : -1
      }
      return out
    } catch { return null }
  }

  const decodeItem = (raw) => {
    try {
      if (!raw) return null
      if (raw.present === false || raw.present === 0) return null
      if (typeof raw !== 'object') return null
      if ((raw.itemCount === 0 || raw.count === 0) && !raw.itemId && !raw.id && !raw.type && !raw.blockId) return null
      const cloned = { ...raw }
      if (typeof cloned.present !== 'undefined') delete cloned.present
      let item = null
      try { item = Item.fromNotch(cloned) } catch {}
      if (item) {
        return {
          name: item.name,
          displayName: item.displayName || item.name,
          count: item.count ?? cloned.itemCount ?? cloned.count ?? 1,
          type: item.type,
          metadata: item.metadata,
          nbt: item.nbt || null,
          stackSize: item.stackSize || 64,
          key: itemKey(item)
        }
      }
      const itemId = cloned.itemId ?? cloned.id ?? cloned.blockId ?? cloned.type
      if (itemId != null && bot.registry?.items) {
        const info = bot.registry.items[itemId]
        if (info) {
          const key = String(info.name || info.displayName || '').toLowerCase()
          return {
            name: info.name,
            displayName: info.displayName || info.name,
            count: cloned.itemCount ?? cloned.count ?? 1,
            type: itemId,
            metadata: cloned.metadata ?? 0,
            nbt: cloned.nbt ?? null,
            stackSize: info.stackSize || 64,
            key
          }
        }
      }
      if (cloned.name) {
        const key = String(cloned.name).toLowerCase()
        return {
          name: cloned.name,
          displayName: cloned.displayName || cloned.name,
          count: cloned.count ?? 1,
          type: cloned.id ?? cloned.itemId ?? null,
          metadata: cloned.metadata ?? 0,
          nbt: cloned.nbt ?? null,
          stackSize: cloned.stackSize || 64,
          key
        }
      }
    } catch {}
    return null
  }

  const facingFrom = (entityPos, blockPos) => {
    try {
      const cx = blockPos.x + 0.5
      const cy = blockPos.y + 0.5
      const cz = blockPos.z + 0.5
      const dx = entityPos.x - cx
      const dy = entityPos.y - cy
      const dz = entityPos.z - cz
      const ax = Math.abs(dx)
      const ay = Math.abs(dy)
      const az = Math.abs(dz)
      const max = Math.max(ax, ay, az)
      if (max === ax) return dx >= 0 ? 'east' : 'west'
      if (max === ay) return dy >= 0 ? 'up' : 'down'
      if (max === az) return dz >= 0 ? 'south' : 'north'
    } catch {}
    return 'unknown'
  }

  const frames = []
  const frameAttachMap = new Map()
  const framesByItem = new Map()
  for (const entity of Object.values(bot.entities || {})) {
    try {
      if (!entity || !entity.position) continue
      const nm = String(entity.name || '').toLowerCase()
      if (nm !== 'item_frame' && nm !== 'glow_item_frame') continue
      const dist = entity.position.distanceTo(center)
      if (!Number.isFinite(dist) || dist > clampRadius) continue
      const blockPos = entity.position.floored()
      const block = bot.blockAt(blockPos)
      const attach = attachedBlockPos(entity)
      const attachKey = attach ? posKey(attach) : null
      const entityData = bot.registry?.entitiesByName?.[entity.name]
      const metaKeys = entityData?.metadataKeys || []
      const idx = metaKeys.indexOf('item')
      const rawCandidates = []
      if (idx >= 0 && entity.metadata?.[idx] != null) rawCandidates.push(entity.metadata[idx])
      if (entity.metadata?.item != null) rawCandidates.push(entity.metadata.item)
      if (entity.metadata?.Item != null) rawCandidates.push(entity.metadata.Item)
      if (entity.metadata?.[8] != null) rawCandidates.push(entity.metadata[8])
      let decodedItem = null
      let rawKeys = []
      let sampleRaw = null
      for (const candidate of rawCandidates) {
        const base = unwrapItemMeta(candidate)
        const got = decodeItem(base)
        if (got) {
          decodedItem = got
          rawKeys = base ? Object.keys(base) : []
          if (!sampleRaw) sampleRaw = base || candidate
          break
        }
        if (base && !rawKeys.length) rawKeys = Object.keys(base)
        if (!sampleRaw && (base || candidate)) sampleRaw = base || candidate
      }
      if (!rawKeys.length && rawCandidates.length) {
        const first = rawCandidates[0]
        if (first && typeof first === 'object') rawKeys = Object.keys(first)
        if (!sampleRaw) sampleRaw = first
      }
      const attachedBlock = attach ? bot.blockAt(attach) : null
      const info = {
        id: entity.id,
        type: nm,
        distance: round(dist, 2),
        position: { x: round(entity.position.x, 3), y: round(entity.position.y, 3), z: round(entity.position.z, 3) },
        block: block ? { name: block.name, position: { x: blockPos.x, y: blockPos.y, z: blockPos.z } } : { name: null, position: { x: blockPos.x, y: blockPos.y, z: blockPos.z } },
        facing: facingFrom(entity.position, blockPos),
        item: decodedItem,
        itemKey: decodedItem?.key || null,
        attachedBlock: attach ? clonePos(attach) : null,
        attachedBlockName: attachedBlock?.name || null,
        rawItemKeys: rawKeys,
        rawItemSummary: summarizeRaw(sampleRaw)
      }
      frames.push(info)
      if (attachKey) frameAttachMap.set(attachKey, info)
      if (info.itemKey) {
        if (!framesByItem.has(info.itemKey)) framesByItem.set(info.itemKey, [])
        framesByItem.get(info.itemKey).push(info)
      }
    } catch {}
  }

  const chestNames = new Set(['chest', 'trapped_chest'])
  const chestPositions = (() => {
    const positions = []
    const seen = new Set()
    const base = center.floored()
    const radiusInt = Math.ceil(clampRadius)
    const maxDistSq = clampRadius * clampRadius
    for (let dx = -radiusInt; dx <= radiusInt; dx++) {
      for (let dz = -radiusInt; dz <= radiusInt; dz++) {
        const horizontalSq = dx * dx + dz * dz
        if (horizontalSq > maxDistSq + 4) continue
        for (let dy = -4; dy <= 4; dy++) {
          const x = base.x + dx
          const y = base.y + dy
          const z = base.z + dz
          const key = `${x},${y},${z}`
          if (seen.has(key)) continue
          seen.add(key)
          const distSq = (center.x - x) ** 2 + (center.y - y) ** 2 + (center.z - z) ** 2
          if (distSq > maxDistSq + 1) continue
          const block = bot.blockAt(new Vec3(x, y, z))
          if (!block) continue
          const name = String(block.name || '').toLowerCase()
          if (!chestNames.has(name)) continue
          positions.push(new Vec3(x, y, z))
        }
      }
    }
    return positions
  })()

  const framedChests = []
  const unframedChests = []
  const usedFrames = new Set()
  const visited = new Set()
  const offsets = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

  for (const bc of chestPositions) {
    const key = posKey(bc)
    if (visited.has(key)) continue
    const cluster = []
    const queue = [bc]
    visited.add(key)
    while (queue.length) {
      const cur = queue.shift()
      cluster.push(cur)
      for (const off of offsets) {
        const np = cur.plus(off)
        const nk = posKey(np)
        if (visited.has(nk)) continue
        const nb = bot.blockAt(np)
        if (!nb || !chestNames.has(String(nb.name || '').toLowerCase())) continue
        visited.add(nk)
        queue.push(np)
      }
    }
    if (!cluster.length) continue
    const clusterBlock = bot.blockAt(cluster[0])
    const clusterName = clusterBlock?.name || 'chest'
    const distanceInfo = cluster.reduce((best, pos) => {
      const dist = pos.distanceTo(center)
      if (!best || dist < best.dist) return { pos, dist }
      return best
    }, null)
    const openPos = clonePos(distanceInfo?.pos || cluster[0])
    const clusterFrames = []
    for (const pos of cluster) {
      const f = frameAttachMap.get(posKey(pos))
      if (f && f.itemKey && !usedFrames.has(f.id)) clusterFrames.push(f)
    }
    if (!clusterFrames.length) {
      const center = new Vec3(openPos.x, openPos.y, openPos.z)
      for (const frame of frames) {
        if (!frame.itemKey || usedFrames.has(frame.id)) continue
        if (frame.attachedBlock) continue
        const raw = frame.attachedBlock || { x: Math.floor(frame.position.x), y: Math.floor(frame.position.y), z: Math.floor(frame.position.z) }
        const attached = new Vec3(raw.x, raw.y, raw.z)
        const dx = Math.abs(attached.x - center.x)
        const dz = Math.abs(attached.z - center.z)
        const dy = Math.abs(attached.y - center.y)
        if (dx <= 6 && dz <= 6 && dy <= 3) {
          clusterFrames.push(frame)
        }
      }
    }
    if (!clusterFrames.length) {
      const center = new Vec3(openPos.x, openPos.y, openPos.z)
      let best = null
      let bestScore = Infinity
      for (const frame of frames) {
        if (!frame.itemKey || usedFrames.has(frame.id)) continue
        if (frame.attachedBlock) continue
        const raw = frame.attachedBlock || { x: Math.floor(frame.position.x), y: Math.floor(frame.position.y), z: Math.floor(frame.position.z) }
        const attached = new Vec3(raw.x, raw.y, raw.z)
        const dx = Math.abs(attached.x - center.x)
        const dz = Math.abs(attached.z - center.z)
        const dy = Math.abs(attached.y - center.y)
        const aligned = ((dx <= 1 && dz <= 6) || (dz <= 1 && dx <= 6))
        if (!aligned) continue
        if (dy > 3) continue
        const score = dx + dz + dy * 0.5
        if (score < bestScore) { best = frame; bestScore = score }
      }
      if (best) clusterFrames.push(best)
    }
    if (!clusterFrames.length) {
      unframedChests.push({
        name: clusterName,
        positions: cluster.map(clonePos),
        openPos,
        position: clonePos(openPos),
        distance: round(distanceInfo?.dist ?? cluster[0].distanceTo(center), 2)
      })
      continue
    }
    for (const frame of clusterFrames) {
      const attached = frame.attachedBlock ? clonePos(frame.attachedBlock) : clonePos(openPos)
      let open = clonePos(openPos)
      if (attached && !cluster.some(p => p.x === attached.x && p.y === attached.y && p.z === attached.z)) {
        open = clonePos(cluster[0])
      }
      framedChests.push({
        name: clusterName,
        positions: cluster.map(clonePos),
        openPos: open,
        attachedPos: attached,
        position: clonePos(open),
        distance: round(distanceInfo?.dist ?? cluster[0].distanceTo(center), 2),
        frame,
        itemKey: frame.itemKey
      })
      usedFrames.add(frame.id)
    }
  }

  const framedPosKeys = new Set()
  const framedClusterKeys = new Set()
  for (const chest of framedChests) {
    if (Array.isArray(chest.positions)) {
      for (const pos of chest.positions) {
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') continue
        framedPosKeys.add(posKey(pos))
      }
      const clusterKey = clusterKeyOf(chest.positions)
      if (clusterKey) framedClusterKeys.add(clusterKey)
    }
  }

  const filteredUnframed = unframedChests.filter((chest) => {
    const clusterKey = clusterKeyOf(chest.positions)
    if (clusterKey && framedClusterKeys.has(clusterKey)) return false
    const positions = Array.isArray(chest.positions) ? chest.positions : []
    if (!positions.length) return true
    for (const pos of positions) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') continue
      if (!framedPosKeys.has(posKey(pos))) return true
    }
    return false
  })

  return {
    ok: true,
    radius: clampRadius,
    frames,
    framedChests,
    unframedChests: filteredUnframed
  }
}

function extendState (state) {
  if (!state.frameSort) state.frameSort = { running: false, lastScan: null }
  return state.frameSort
}

function install (bot, { on, state, log }) {
  const logger = log || { info: console.log, warn: console.warn, error: console.error, debug: () => {} }
  const frameState = extendState(state || {})

  const ensureNear = async (pos, actions, range = 1.6) => {
    const target = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    const tolerance = range + 0.7
    try {
      const here = bot.entity?.position
      if (here && here.distanceTo(target) <= tolerance) return true
    } catch {}
    const res = await actions.run('goto', { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5, range: Math.max(range, 0.8) })
    if (!res || !res.ok) {
      try {
        const here = bot.entity?.position
        if (here && here.distanceTo(target) <= tolerance) return true
      } catch {}
      return false
    }
    const start = Date.now()
    const timeoutMs = 12000
    while (Date.now() - start < timeoutMs) {
      try {
        const here = bot.entity?.position
        if (here && here.distanceTo(target) <= tolerance) return true
      } catch {}
      try { await bot.waitForTicks(5) } catch { await new Promise(r => setTimeout(r, 100)) }
    }
    try {
      const here = bot.entity?.position
      return here && here.distanceTo(target) <= tolerance
    } catch { return false }
  }

  const countInInventory = (item) => {
    return (bot.inventory?.items() || []).reduce((sum, it) => {
      if (!it) return sum
      if (it.type !== item.type) return sum
      if (item.metadata != null && it.metadata !== item.metadata) return sum
      if (item.nbt && !it.nbt) return sum
      if (!item.nbt && it.nbt) return sum
      if (item.nbt && it.nbt && JSON.stringify(it.nbt) !== JSON.stringify(item.nbt)) return sum
      return sum + (it.count || 0)
    }, 0)
  }

  const openContainerAt = async (pos) => {
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (!block) throw new Error(`找不到箱子 ${pos.x},${pos.y},${pos.z}`)
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
    return await bot.openContainer(block)
  }

  async function processSourceChest (source, destMap, actions) {
    const keySet = new Set(destMap.keys())
    let movedAny = false
    const pos = clonePos(source.openPos || source.position || source)
    const sourcePositions = Array.isArray(source.positions) && source.positions.length ? source.positions.map(clonePos) : [clonePos(pos)]
    while (true) {
      if (!await ensureNear(pos, actions)) {
        logger.warn('[frame-sort] 前往源箱子失败', pos)
        return movedAny
      }
      let container
      try {
        container = await openContainerAt(pos)
      } catch (err) {
        logger.warn('[frame-sort] 打开源箱子失败', err?.message || err)
        return movedAny
      }
      let targetItem = null
      let targetKey = null
      try {
        const items = container.containerItems()
        for (const it of items) {
          const key = itemKey(it)
          if (!key || !keySet.has(key)) continue
          targetItem = it
          targetKey = key
          break
        }
      } catch (err) {
        logger.warn('[frame-sort] 读取源箱子物品失败', err?.message || err)
      }

      if (!targetItem || !targetKey) {
        try { container.close() } catch {}
        return movedAny
      }

      const wanted = destMap.get(targetKey) || []
      if (!wanted.length) {
        try { container.close() } catch {}
        return movedAny
      }

      let takeCount = targetItem.count || 1
      const carryCap = availableInventoryCapacity(bot, targetItem)
      if (carryCap <= 0) {
        try { container.close() } catch {}
        logger.warn('[frame-sort] 背包已满，无法搬运更多', targetItem.name)
        return movedAny
      }
      takeCount = Math.min(takeCount, carryCap)
      try {
        await container.withdraw(targetItem.type, targetItem.metadata, takeCount, targetItem.nbt)
      } catch (err) {
        try { container.close() } catch {}
        logger.warn('[frame-sort] 取出物品失败', err?.message || err)
        return movedAny
      }
      try { container.close() } catch {}

      let remaining = takeCount
      for (const dest of wanted) {
        if (remaining <= 0) break
        const destPos = clonePos(dest.openPos || dest.position || (Array.isArray(dest.positions) ? dest.positions[0] : null))
        if (!destPos) continue
        const sameCluster = Array.isArray(dest.positions) && dest.positions.some(p =>
          sourcePositions.some(sp => sp.x === p.x && sp.y === p.y && sp.z === p.z)
        )
        if (sameCluster) continue
        if (!await ensureNear(destPos, actions)) {
          logger.warn('[frame-sort] 前往目标箱子失败', destPos)
          continue
        }
        let destContainer
        try {
          destContainer = await openContainerAt(destPos)
        } catch (err) {
          logger.warn('[frame-sort] 打开目标箱子失败', err?.message || err)
          continue
        }
        const before = countInInventory(targetItem)
        try {
          await destContainer.deposit(targetItem.type, targetItem.metadata, remaining, targetItem.nbt)
        } catch (err) {
          logger.debug && logger.debug('[frame-sort] 目标箱子已满?', err?.message || err)
        }
        try { destContainer.close() } catch {}
        const after = countInInventory(targetItem)
        const moved = before - after
        remaining -= moved
      }

      if (remaining > 0) {
        // 尝试放回原箱子
        if (!await ensureNear(pos, actions)) {
          logger.warn('[frame-sort] 返回源箱子失败，背包残留', remaining)
          return movedAny
        }
        let back
        try { back = await openContainerAt(pos) } catch (err) {
          logger.warn('[frame-sort] 放回源箱子失败，背包残留', err?.message || err)
          return movedAny
        }
        const before = countInInventory(targetItem)
        try {
          await back.deposit(targetItem.type, targetItem.metadata, remaining, targetItem.nbt)
          const after = countInInventory(targetItem)
          const returned = before - after
          remaining -= returned
        } catch (err) {
          logger.warn('[frame-sort] 放回源箱子失败', err?.message || err)
        }
        try { back.close() } catch {}
        if (remaining > 0) {
          logger.warn('[frame-sort] 背包剩余未能整理', remaining, targetItem.name)
          return movedAny
        }
      }

      movedAny = true
    }
  }

  async function runSort (radius = 50) {
    if (frameState.running) {
      logger.warn('[frame-sort] 已在运行中')
      return
    }
    if (state && state.externalBusy) {
      logger.warn('[frame-sort] 当前有外部任务，稍后再试')
      return
    }
    frameState.running = true
    const actions = actionsMod.install(bot, { log: logger })
    const rad = Math.max(2, Math.min(80, Number(radius) || 50))
    const scan = scanFrames(bot, rad)
    frameState.lastScan = scan
    if (!scan.ok) {
      logger.warn('[frame-sort] 扫描失败: bot未就绪')
      frameState.running = false
      return
    }
    const destMap = new Map()
    for (const chest of scan.framedChests) {
      if (!chest || !chest.itemKey) continue
      if (!chest.frame?.item) continue
      const list = destMap.get(chest.itemKey) || []
      list.push(chest)
      destMap.set(chest.itemKey, list)
    }
    if (!destMap.size) {
      logger.warn('[frame-sort] 区域内没有展示框指引的箱子')
      frameState.running = false
      return
    }
    if (!scan.unframedChests.length) {
      logger.info('[frame-sort] 没有需要整理的箱子')
      frameState.running = false
      return
    }

    let active = false
    try {
      if (state) {
        try { bot.emit('external:begin', { source: 'cli', tool: 'frame_sort' }) } catch {}
        state.externalBusy = true
      }
      for (const source of scan.unframedChests) {
        const moved = await processSourceChest(source, destMap, actions)
        if (moved) active = true
      }
    } finally {
      if (state) {
        state.externalBusy = false
        try { bot.emit('external:end', { source: 'cli', tool: 'frame_sort' }) } catch {}
      }
      frameState.running = false
    }
    if (!active) logger.info('[frame-sort] 没有可转移的物品')
    else logger.info('[frame-sort] 整理完成')
  }

  function handleCli (args = []) {
    const sub = String(args[0] || 'scan').toLowerCase()
    const val = args[1]
    if (sub === 'scan' || sub === 'list') {
      const rad = val != null ? val : undefined
      const scan = scanFrames(bot, rad)
      frameState.lastScan = scan
      if (!scan.ok) {
        console.log('[FRAMES] bot 未就绪')
        return
      }
      console.log(`[FRAMES] 半径${scan.radius}：展示框${scan.frames.length}，贴框箱子${scan.framedChests.length}，无框箱子${scan.unframedChests.length}`)
      scan.framedChests.forEach((c) => {
        const it = c.frame?.item
        const p = c.attachedPos || c.openPos || c.position || { x: 0, y: 0, z: 0 }
        console.log(`  [FRAME] ${p.x},${p.y},${p.z} -> ${it?.displayName || it?.name || '未知'} (key=${c.itemKey})`)
      })
      if (!scan.framedChests.length) console.log('  (没有展示框箱子)')
      if (scan.unframedChests.length) {
        console.log('  未贴展示框箱子:')
        scan.unframedChests.forEach((c, idx) => {
          const pos = c.position || c.openPos || (Array.isArray(c.positions) ? c.positions[0] : { x: 0, y: 0, z: 0 })
          console.log(`    [SRC#${idx}] ${pos.x},${pos.y},${pos.z} (positions=${(c.positions || []).length}) dist=${c.distance}`)
        })
      }
      if (!scan.framedChests.length && scan.frames.length) {
        scan.frames.slice(0, 5).forEach((f, idx) => {
        const item = f.item
        const attached = f.attachedBlock ? `${f.attachedBlock.x},${f.attachedBlock.y},${f.attachedBlock.z}` : 'null'
        const attachName = f.attachedBlockName || 'unknown'
        const rawKeys = Array.isArray(f.rawItemKeys) && f.rawItemKeys.length ? f.rawItemKeys.join(',') : 'none'
        const rawSummary = f.rawItemSummary || 'n/a'
        const key = f.itemKey || item?.key || 'undefined'
        console.log(`  [DBG] frame#${idx} pos=(${f.position.x},${f.position.y},${f.position.z}) facing=${f.facing} block=${f.block?.name} attach=${attached} attachBlock=${attachName} item=${item?.displayName || item?.name || '无'} key=${key} rawKeys=${rawKeys} rawSummary=${rawSummary}`)
      })
      }
      return
    }
    if (sub === 'sort') {
      const rad = val != null ? val : undefined
      runSort(rad).catch((err) => {
        logger.error('[frame-sort] 执行异常', err)
        frameState.running = false
      })
      return
    }
    if (sub === 'help') {
      console.log('[FRAMES] 用法: .frames scan [radius] | .frames sort [radius]')
      return
    }
    console.log('[FRAMES] 未知子命令，使用 .frames help 查看用法')
  }

  on('cli', ({ cmd, args }) => {
    const c = String(cmd || '').toLowerCase()
    if (c === 'frames' || c === 'frame' || c === 'frame_sort') {
      handleCli(Array.isArray(args) ? args : [])
    }
  })
}

module.exports = { install, scanFrames }
