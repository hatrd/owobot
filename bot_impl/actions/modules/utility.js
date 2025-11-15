const { oreLabelFromOnly } = require('../lib/ore')

module.exports = function registerUtility (ctx) {
  const { bot, register, ok, fail, wait, assertCanEquipHand, isMainHandLocked } = ctx
  const observer = ctx.observer
  const skillRunnerMod = ctx.skillRunnerMod
  const registerCleanup = ctx.registerCleanup
  const log = ctx.log
  let pathfinderPkg = null
  function ensurePathfinder () {
    const ok = ctx.ensurePathfinder()
    if (ok) pathfinderPkg = ctx.pathfinder
    return ok
  }

  // --- legacy chunk begin ---
  async function mine_ore (args = {}) {
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const radius = Math.max(4, parseInt(args.radius || '32', 10))
    const only = (() => {
      if (!args.only) return null
      if (Array.isArray(args.only)) return args.only.map(x => String(x).toLowerCase())
      return String(args.only).toLowerCase()
    })()
    const expected = args.expected ? String(args.expected) : null
    const res = runner.startSkill('mine_ore', { radius, only }, expected)
    const label = oreLabelFromOnly(only)
    return res.ok ? ok(`矿脉挖掘已启动: ${label}`, { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  // --- Feed animals (e.g., cows with wheat) ---
  async function feed_animals (args = {}) {
    const species = String(args.species || 'cow').toLowerCase()
    const itemName = String(args.item || (species === 'cow' || species === 'mooshroom' ? 'wheat' : 'wheat')).toLowerCase()
    const radius = Math.max(2, parseInt(args.radius || '12', 10))
    const rawMax = args.max
    const max = (rawMax == null || String(rawMax).toLowerCase() === 'all' || Number(rawMax) === 0)
      ? Infinity
      : Math.max(1, parseInt(rawMax, 10) || 1)
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true; m.canDig = false
    bot.pathfinder.setMovements(m)

    function now () { return Date.now() }
    function invFind (nm) { try { const s = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).find(it => String(it.name||'').toLowerCase() === s) || null } catch { return null } }
    function invCount (nm) { try { const s = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).filter(it => String(it.name||'').toLowerCase() === s).reduce((a,b)=>a+(b.count||0),0) } catch { return 0 } }
    async function ensureItemEquipped (nm) {
      try {
        const it = invFind(nm)
        if (!it) return false
        if (bot.heldItem && String(bot.heldItem.name || '').toLowerCase() === nm) return true
        assertCanEquipHand(bot, it.name)
        await bot.equip(it, 'hand')
        return true
      } catch (e) {
        if (e?.code === 'MAIN_HAND_LOCKED') return false
        return false
      }
    }
    function isTargetSpecies (e) {
      try {
        if (!e || !e.position) return false
        const et = String(e.type || '').toLowerCase()
        if (et === 'player') return false
        const raw = e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || ''
        const n = String(raw).toLowerCase()
        if (species === 'cow') return n.includes('cow') || n.includes('mooshroom') || n.includes('奶牛') || n.includes('蘑菇牛') || n.includes('牛')
        return n.includes(species)
      } catch { return false }
    }
    function nearbyTargets () {
      try {
        const me = bot.entity?.position; if (!me) return []
        const list = []
        for (const e of Object.values(bot.entities || {})) {
          try {
            if (!isTargetSpecies(e) || !e.position) continue
            const d = me.distanceTo(e.position)
            if (!Number.isFinite(d) || d > radius) continue
            list.push({ e, d })
          } catch {}
        }
        list.sort((a,b)=>a.d-b.d)
        return list.map(x => x.e)
      } catch { return [] }
    }

    const have = invCount(itemName)
    if (have <= 0) return fail(`缺少${itemName}`)

    let fed = 0
    const lockName = itemName
    let lockApplied = false
    try {
      if (bot.state && !bot.state.holdItemLock) {
        bot.state.holdItemLock = lockName
        lockApplied = true
      }
    } catch {}
    try {
      const start = now()
      while (fed < max && (now() - start) < 20000) {
        const list = nearbyTargets()
        if (!list.length) break
        for (const t of list) {
          if (fed >= max) break
          if (invCount(itemName) <= 0) break
          // approach target
          try { bot.pathfinder.setGoal(new goals.GoalFollow(t, 2.0), true) } catch {}
          const until = now() + 4000
          while (now() < until) {
            const cur = bot.entities?.[t.id]
            if (!cur || !cur.position) break
            const d = cur.position.distanceTo(bot.entity.position)
            if (d <= 3.0) break
            await wait(80)
          }
          try { bot.pathfinder.setGoal(null) } catch {}
          // equip and use on target
          const before = invCount(itemName)
          const ok = await ensureItemEquipped(itemName)
          if (!ok) break
          try { await bot.lookAt((t.position && t.position.offset(0, 1.2, 0)) || bot.entity.position, true) } catch {}
          try { await bot.useOn(t) } catch {}
          await wait(350)
          const after = invCount(itemName)
          if (after < before) fed++
          if (fed >= max) break
        }
        if (fed === 0) await wait(200) // brief pause if nothing fed this round
        // if max is Infinity, continue scanning next rounds until time or wheat runs out
      }
    } finally {
      try { bot.pathfinder.setGoal(null) } catch {}
      try {
        if (lockApplied && bot.state && String(bot.state.holdItemLock || '').toLowerCase() === lockName) bot.state.holdItemLock = null
      } catch {}
    }
    return fed > 0 ? ok(`已喂食${fed}`) : fail('附近没有可喂食目标或缺少小麦')
  }

  // --- Harvest and replant crops ---
  async function harvest (args = {}) {
    const radius = Math.max(2, parseInt(args.radius || '12', 10))
    const onlyRaw = args.only ? String(args.only).toLowerCase() : null // desired crop item/block name
    const replant = (args.replant !== false)
    const sowOnly = (args.sowOnly === true)
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true)
    m.allowSprinting = true
    // Allow default parkour/tower/scaffolding behavior
    bot.pathfinder.setMovements(m)

    function now () { return Date.now() }
    function blockName (b) { try { return String(b?.name || '').toLowerCase() } catch { return '' } }
    function props (b) { try { return (typeof b?.getProperties === 'function') ? (b.getProperties() || {}) : {} } catch { return {} } }
    function isFarmland (b) { const n = blockName(b); return n === 'farmland' }
    function isSoulSand (b) { const n = blockName(b); return n === 'soul_sand' }
    function isAir (b) { const n = blockName(b); return !b || n === 'air' }

    // map block names and items
    const CROPS = [
      { block: 'wheat', item: 'wheat_seeds', maxAge: 7, soil: 'farmland' },
      { block: 'carrots', item: 'carrot', maxAge: 7, soil: 'farmland' },
      { block: 'potatoes', item: 'potato', maxAge: 7, soil: 'farmland' },
      { block: 'beetroots', item: 'beetroot_seeds', maxAge: 3, soil: 'farmland' },
      { block: 'nether_wart', item: 'nether_wart', maxAge: 3, soil: 'soul_sand' }
    ]
    function cropByBlock (n) { n = String(n||'').toLowerCase(); return CROPS.find(c => c.block === n) || null }
    function cropByAlias (n) {
      if (!n) return null
      const s = String(n).toLowerCase()
      for (const c of CROPS) {
        if (c.block === s || c.item === s) return c
        if (s.includes('wheat') || s.includes('seed')) return CROPS[0]
        if (s.includes('carrot')) return CROPS[1]
        if (s.includes('potato') || s.includes('马铃薯') || s.includes('土豆')) return CROPS[2]
        if (s.includes('beet')) return CROPS[3]
        if (s.includes('wart') || s.includes('地狱疙瘩') || s.includes('下界疣')) return CROPS[4]
      }
      return null
    }

    const desired = onlyRaw ? cropByAlias(onlyRaw) : null

    function isMature (b) {
      const n = blockName(b)
      const c = cropByBlock(n)
      if (!c) return false
      const p = props(b)
      const age = (p && (typeof p.age === 'number')) ? p.age : null
      if (age == null) return false
      return age >= c.maxAge
    }

    function findTargets (onlyCrop = null) {
      try {
        const me = bot.entity?.position
        if (!me) return []
        const list = []
        const V = require('vec3').Vec3
        const base = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 3; dy++) {
              const p = base.offset(dx, dy, dz)
              const b = bot.blockAt(p)
              if (!b) continue
              const n = blockName(b)
              const c = cropByBlock(n)
              if (!c) continue
              if (onlyCrop && c.block !== onlyCrop.block) continue
              if (!isMature(b)) continue
              list.push({ pos: p, crop: c, mature: true })
            }
          }
        }
        list.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
        return list
      } catch { return [] }
    }

    function invFind (name) { try { const s = String(name).toLowerCase(); return (bot.inventory?.items()||[]).find(it => String(it.name||'').toLowerCase() === s) || null } catch { return null } }

    async function plantAt (pos, crop) {
      try {
        const below = pos.offset(0, -1, 0)
        const soil = bot.blockAt(below)
        if (crop.soil === 'farmland' && !isFarmland(soil)) return false
        if (crop.soil === 'soul_sand' && !isSoulSand(soil)) return false
        const seed = invFind(crop.item)
        if (!seed) return false
        // Equip seed and place on top face of soil
        try { assertCanEquipHand(bot, seed.name) } catch (e) { if (e?.code === 'MAIN_HAND_LOCKED') return false; throw e }
        await bot.equip(seed, 'hand')
        try { await bot.lookAt(soil.position.offset(0.5, 0.5, 0.5), true) } catch {}
        await bot.placeBlock(soil, require('vec3').Vec3(0, 1, 0))
        return true
      } catch { return false }
    }

    function findSowSpots (crop) {
      try {
        const me = bot.entity?.position
        if (!me) return []
        const list = []
        const V = require('vec3').Vec3
        const base = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 2; dy++) {
              const soilPos = base.offset(dx, dy, dz)
              const soil = bot.blockAt(soilPos)
              if (!soil) continue
              if (crop.soil === 'farmland' && !isFarmland(soil)) continue
              if (crop.soil === 'soul_sand' && !isSoulSand(soil)) continue
              const above = bot.blockAt(soilPos.offset(0, 1, 0))
              if (!isAir(above)) continue
              list.push(soilPos.offset(0, 1, 0)) // position where crop will be
            }
          }
        }
        list.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
        return list
      } catch { return [] }
    }

    let targets = sowOnly ? [] : findTargets(desired)
    let done = 0; let replanted = 0
    for (const t of targets) {
      try {
        const me = bot.entity?.position
        const d = me ? t.pos.distanceTo(me) : 0
        // Move near the crop
        bot.pathfinder.setGoal(new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 1.8), true)
        const until = now() + 6000
        while (now() < until) {
          const cur = bot.blockAt(t.pos)
          if (!cur || !isMature(cur)) break
          const cd = bot.entity.position.distanceTo(t.pos)
          if (cd <= 2.0) break
          await wait(80)
        }
        // Dig only mature crop (default behavior)
        const cur = bot.blockAt(t.pos)
        if (cur && isMature(cur)) {
          try { await bot.lookAt(cur.position.offset(0.5, 0.4, 0.5), true) } catch {}
          try { await bot.dig(cur) } catch {}
          done++
          // brief wait for drops to land
          await wait(300)
          // try replant
          if (replant) {
            // quick nearby pickup to acquire seeds if needed
            if (!invFind(t.crop.item)) {
              try {
                // actively collect nearby matching drops for a short window
                await collect({ radius: Math.min(12, radius), match: t.crop.item })
              } catch {}
            }
            const okp = await plantAt(t.pos, t.crop)
            if (okp) replanted++
          }
        }
      } catch {}
    }
    // If sow-only requested, or nothing to harvest, or replant count is low, do a sow-only pass
    const wantCrop = desired || (targets[0] && targets[0].crop) || null
    if (replant !== false && (sowOnly || done === 0 || replanted < done)) {
      const seedPref = wantCrop || (function pickByInventory () {
        const order = ['potato','carrot','wheat_seeds','beetroot_seeds','nether_wart']
        for (const name of order) { if (invFind(name)) return cropByAlias(name) }
        return null
      })()
      if (seedPref) {
        // Try collect matching seeds before sowing if none in inventory
        if (!invFind(seedPref.item)) {
          try { await collect({ radius: Math.min(16, radius + 4), match: seedPref.item }) } catch {}
        }
        const spots = findSowSpots(seedPref)
        for (const p of spots) {
          const okp = await plantAt(p, seedPref)
          if (okp) replanted++
          if (done > 0 && replanted >= done) break
        }
      }
    }
    try { bot.pathfinder.setGoal(null) } catch {}
    return ok(`已收割${done}，重种${replanted}`)
  }

  async function observe_detail (args = {}) {
    try {
      const r = observer.detail(bot, args || {})
      return { ok: Boolean(r && r.ok), msg: (r && r.msg) || '无', data: r && r.data }
    } catch (e) { return fail(String(e?.message || e)) }
  }

  // Observe players' info from external map API (accept external URL, parse both schemas)
  async function observe_players (args = {}) {
    const url = String(process.env.MAP_API_URL || '').trim()
    if (!url) return fail('MAP_API_URL 未配置')
    const names = Array.isArray(args.names) ? args.names.filter(Boolean).map(s => String(s)) : null
    const single = args.name ? String(args.name) : null
    const filterWorldRaw = String(args.world || args.dim || '').trim()
    const maxOut = Math.max(1, parseInt(args.max || '20', 10))
    const toDim = (w) => {
      const s = String(w || '')
      if (s === 'world_nether' || /nether/i.test(s)) return '下界'
      if (s === 'world_the_end' || /end$/i.test(s)) return '末地'
      if (s === 'world' || /overworld|^world$/i.test(s)) return '主世界'
      return s || '未知'
    }
    const worldKey = (() => {
      if (!filterWorldRaw) return null
      const v = filterWorldRaw.toLowerCase()
      if (/nether|下界/.test(v)) return 'world_nether'
      if (/the_end|end|末地/.test(v)) return 'world_the_end'
      if (/overworld|主世界|^world$/.test(v)) return 'world'
      // If an exact world id is passed, pass it through
      return filterWorldRaw
    })()
    const wantNames = (() => {
      if (names && names.length) return names
      if (single) return [single]
      return null
    })()

    function num (v) { const n = Number(v); return Number.isFinite(n) ? n : null }
    function parseThresh (pfx) {
      const eq = num(args[pfx + '_eq'] ?? args[pfx + 'Eq'])
      const lt = num(args[pfx + '_lt'] ?? args[pfx + 'Lt'])
      const lte = num(args[pfx + '_lte'] ?? args[pfx + 'Lte'])
      const gt = num(args[pfx + '_gt'] ?? args[pfx + 'Gt'])
      const gte = num(args[pfx + '_gte'] ?? args[pfx + 'Gte'])
      const min = num(args[pfx + 'Min'])
      const max = num(args[pfx + 'Max'])
      return { eq, lt: lt ?? (max != null ? max - Number.EPSILON : null), lte: lte ?? max, gt: gt ?? (min != null ? min + Number.EPSILON : null), gte: gte ?? min }
    }
    const armorT = parseThresh('armor')
    const healthT = parseThresh('health')
    const hasThresh = (t) => (t && (t.eq != null || t.lt != null || t.lte != null || t.gt != null || t.gte != null))
    function passNum (val, t) {
      if (t.eq != null && val !== t.eq) return false
      if (t.lte != null && !(val <= t.lte)) return false
      if (t.lt != null && !(val < t.lt)) return false
      if (t.gte != null && !(val >= t.gte)) return false
      if (t.gt != null && !(val > t.gt)) return false
      return true
    }

    function parseWorldFromUrl (u) {
      try {
        const m = String(u || '').match(/\/maps\/([^/]+)\/live\/players\.json/i)
        if (m && m[1]) return m[1]
      } catch {}
      return 'world'
    }

    function normalizePlayers (data, u) {
      const worldFromUrl = parseWorldFromUrl(u)
      const list = Array.isArray(data?.players) ? data.players : []
      return list.map(p => {
        const pos = p?.position
        const hasPosObject = pos && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number'
        const hasFlatXYZ = typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number'
        const x = hasFlatXYZ ? Number(p.x) : (hasPosObject ? Number(pos.x) : 0)
        const y = hasFlatXYZ ? Number(p.y) : (hasPosObject ? Number(pos.y) : 0)
        const z = hasFlatXYZ ? Number(p.z) : (hasPosObject ? Number(pos.z) : 0)
        const world = String(p?.world || worldFromUrl || 'world')
        const health = (p?.health == null ? null : Number(p.health))
        const armor = (p?.armor == null ? null : Number(p.armor))
        return { name: String(p?.name || ''), world, x, y, z, health, armor }
      })
    }

    function baseRoot (u) {
      try {
        const o = new URL(u)
        const path = o.pathname || '/'
        const prefix = path.replace(/\/maps\/.+\/live\/players\.json$/i, '').replace(/\/$/, '')
        return `${o.protocol}//${o.host}${prefix}` || null
      } catch { return null }
    }
    function parseMapId (u) {
      try { const m = String(u).match(/\/maps\/([^/]+)\/live\/players\.json/i); return m && m[1] ? m[1] : null } catch { return null }
    }
    function isBlueMapShape (data) {
      try { const p = Array.isArray(data?.players) ? data.players[0] : null; return !!(p && (p.position || (p.foreign != null))) } catch { return false }
    }

    async function blueMapCollectAll (root, currentMapId, seedData) {
      // Cache map list briefly in state
      const cache = (bot.state && (bot.state.blueMap = bot.state.blueMap || {})) || {}
      let maps = Array.isArray(cache.maps) ? cache.maps : null
      let liveRoot = cache.liveRoot || null
      const now = Date.now()
      if (!maps || !liveRoot || !cache.mapsFetchedAt || (now - cache.mapsFetchedAt) > 30_000) {
        // Prefer BlueMap root settings.json for map list and roots
        try {
          const ac = new AbortController(); const to = setTimeout(() => { try { ac.abort('timeout') } catch {} }, 4000)
          const resp = await fetch(`${root}/settings.json`, { method: 'GET', signal: ac.signal })
          clearTimeout(to)
          if (resp.ok) {
            const dj = await resp.json().catch(() => null)
            const arr = Array.isArray(dj?.maps) ? dj.maps : (Array.isArray(dj) ? dj : [])
            maps = arr.map(m => (m && (m.id || m.key || m.mapId || m)) ? (m.id || m.key || m.mapId || m) : null).filter(Boolean)
            liveRoot = String(dj?.liveDataRoot || 'maps')
          }
        } catch {}
        if (!maps || !maps.length) maps = [currentMapId].filter(Boolean)
        if (!liveRoot) liveRoot = 'maps'
        try { cache.maps = maps; cache.liveRoot = liveRoot; cache.mapsFetchedAt = now; if (bot.state) bot.state.blueMap = cache } catch {}
      }

      const all = []
      // Include already-fetched current map data
      try {
        const list = Array.isArray(seedData?.players) ? seedData.players : []
        for (const p of list) {
          try {
            if (p && p.foreign === false) {
              const pos = p.position || {}
              all.push({ name: String(p.name||''), world: currentMapId || 'world', x: Number(pos.x||0), y: Number(pos.y||0), z: Number(pos.z||0), health: null, armor: null })
            }
          } catch {}
        }
      } catch {}

      // Fetch other maps in parallel to find players with foreign:false there
      const others = maps.filter(id => id && id !== currentMapId)
      await Promise.all(others.map(async (id) => {
        try {
          const ac = new AbortController(); const to = setTimeout(() => { try { ac.abort('timeout') } catch {} }, 4000)
          const r = await fetch(`${root}/${liveRoot}/${id}/live/players.json`, { method: 'GET', signal: ac.signal })
          clearTimeout(to)
          if (!r.ok) return
          const dj = await r.json().catch(() => null)
          const list = Array.isArray(dj?.players) ? dj.players : []
          for (const p of list) {
            try {
              if (p && p.foreign === false) {
                const pos = p.position || {}
                all.push({ name: String(p.name||''), world: id, x: Number(pos.x||0), y: Number(pos.y||0), z: Number(pos.z||0), health: null, armor: null })
              }
            } catch {}
          }
        } catch {}
      }))
      return all
    }

    const ac = new AbortController()
    const timeout = setTimeout(() => { try { ac.abort('timeout') } catch {} }, 5000)
    try {
      const res = await fetch(url, { method: 'GET', signal: ac.signal })
      if (!res.ok) return fail(`HTTP ${res.status}`)
      const data = await res.json()
      let rows = []
      const bluemapMode = isBlueMapShape(data)
      if (bluemapMode) {
        const root = baseRoot(url)
        const cur = parseMapId(url)
        const all = await blueMapCollectAll(root, cur, data)
        rows = all
      } else {
        rows = normalizePlayers(data, url)
      }

      // If BlueMap and user is asking about health/armor (thresholds), we can't answer
      if ((hasThresh(armorT) || hasThresh(healthT)) && bluemapMode) {
        return ok('不知道（BlueMap未提供生命/盔甲）', { data: [] })
      }

      if (worldKey) rows = rows.filter(p => String(p?.world || '') === worldKey)
      if (wantNames) {
        const set = new Set(wantNames.map(n => String(n).toLowerCase()))
        rows = rows.filter(p => set.has(String(p?.name || '').toLowerCase()))
      }
      // Numeric filters
      rows = rows.filter(p => {
        const a = (p?.armor == null ? null : Number(p.armor))
        const h = (p?.health == null ? null : Number(p.health))
        if (hasThresh(armorT) && a == null) return false
        if (hasThresh(healthT) && h == null) return false
        return passNum(a ?? 0, armorT) && passNum(h ?? 0, healthT)
      })

      if (!rows.length) {
        if (wantNames && wantNames.length) return fail('未找到指定玩家')
        const dimCN = worldKey ? toDim(worldKey) : '全部'
        return ok(`${dimCN}: 无`, { data: [] })
      }

      const mapped = rows.map(p => ({
        name: p.name,
        world: p.world,
        dim: toDim(p.world),
        x: Number(p.x || 0), y: Number(p.y || 0), z: Number(p.z || 0),
        health: (p.health == null ? null : Number(p.health)),
        armor: (p.armor == null ? null : Number(p.armor))
      }))

      // Build concise message
      const dimCN = worldKey ? toDim(worldKey) : null
      const parts = mapped.slice(0, maxOut).map(r => {
        if (r.health == null || r.armor == null) return `${r.name}@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)}`
        return `${r.name}@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)} 生命${Math.round(r.health)}/20 盔甲${Math.round(r.armor)}`
      })
      const msg = dimCN ? `${dimCN}: ${parts.join('; ')}` : parts.join('; ')
      return ok(msg, { data: mapped.slice(0, maxOut) })
    } catch (e) {
      return fail(String(e?.message || e))
    } finally {
      clearTimeout(timeout)
    }
  }


  // --- High-level skills bridge ---
  function ensureRunner () {
    try { return skillRunnerMod.ensure(bot, { on, registerCleanup, log }) } catch { return null }
  }

  async function skill_start (args = {}) {
    const { skill, expected = null } = args
    if (!skill) return fail('缺少技能名')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    try {
      // lazy register default skills once (no placeholders)
      if (runner.listSkills().length === 0) {
        runner.registerSkill('go', require('../../skills/go'))
        runner.registerSkill('gather', require('../../skills/gather'))
        runner.registerSkill('craft', require('../../skills/craft'))
      }
    } catch {}
    const res = runner.startSkill(String(skill), args.args || {}, expected || null)
    return res.ok ? ok(`任务已启动 ${res.taskId}`, { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  async function skill_status (args = {}) {
    const { taskId } = args
    if (!taskId) return fail('缺少taskId')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const r = runner.status(String(taskId))
    return r.ok ? ok('状态', r) : fail(r.msg || '查询失败')
  }

  async function skill_cancel (args = {}) {
    const { taskId } = args
    if (!taskId) return fail('缺少taskId')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const r = runner.cancel(String(taskId))
    return r.ok ? ok('已取消', r) : fail(r.msg || '取消失败')
  }

  async function sort_chests (args = {}) {
    const frameState = bot.state?.frameSort
    if (!frameState || typeof frameState.runSort !== 'function') return fail('分类模块未就绪')
    const radiusRaw = args?.radius ?? args?.range ?? args?.r ?? undefined
    let res
    try {
      res = await frameState.runSort(radiusRaw)
    } catch (e) {
      return fail(`分类失败: ${e?.message || e}`)
    }
    if (!res || res.ok === false) {
      const reason = res?.reason
      const reasonMsg = (() => {
        switch (reason) {
          case 'running': return '分类已在进行中'
          case 'busy': return '当前忙于其他任务'
          case 'unready': return '还没准备好'
          case 'no_framed': return '附近没有展示框指引的箱子'
          default: return '分类失败'
        }
      })()
      return fail(reasonMsg)
    }
    const totalSources = Number.isFinite(res.sourcesTotal) ? res.sourcesTotal : null
    if (!res.moved || res.reason === 'nothing_to_sort') {
      return ok('所有箱子已经整理好啦', { moved: false, radius: res.radius, sourcesTotal: totalSources })
    }
    const movedCount = Number.isFinite(res.sourcesMoved) ? res.sourcesMoved : null
    const suffix = movedCount && movedCount > 0 ? `，处理了${movedCount}个源箱` : ''
    return ok(`整理箱子完成${suffix}`, { moved: true, sourcesMoved: res.sourcesMoved ?? null, sourcesTotal: totalSources, radius: res.radius })
  }

  function normalizeName (name) {
    const n = String(name || '').toLowerCase().trim()
    const aliases = new Map([
      ['铁粒', 'iron_nugget'],
      ['火把', 'torch'],
      ['水桶', 'water_bucket'],
      ['钻石剑', 'diamond_sword'],
      ['钻石斧', 'diamond_axe'],
      ['钻石镐', 'diamond_pickaxe'],
      ['圆石', 'cobblestone'],
      ['石头', 'stone'],
      ['木棍', 'stick'],
      ['沙子', 'sand'],
      ['原木', 'log'],
      ['原木块', 'log'],
      ['木头', 'log'],
      ['木头块', 'log'],
      ['木材', 'log'],
      ['logs', 'log'],
      // woods (CN -> EN)
      ['橡木原木', 'oak_log'],
      ['云杉原木', 'spruce_log'],
      ['白桦原木', 'birch_log'],
      ['丛林原木', 'jungle_log'],
      ['金合欢原木', 'acacia_log'],
      ['相思木原木', 'acacia_log'],
      ['深色橡木原木', 'dark_oak_log'],
      ['红树原木', 'mangrove_log'],
      ['樱花原木', 'cherry_log'],
      // saplings
      ['橡树苗', 'oak_sapling'],
      ['云杉树苗', 'spruce_sapling'],
      ['白桦树苗', 'birch_sapling'],
      ['丛林树苗', 'jungle_sapling'],
      ['金合欢树苗', 'acacia_sapling'],
      ['相思木树苗', 'acacia_sapling'],
      ['深色橡树苗', 'dark_oak_sapling'],
      ['樱花树苗', 'cherry_sapling']
    ])
    return aliases.get(n) || n
  }

  const GROUP_NAME_MATCHERS = new Map([
    ['log', (value) => {
      const n = String(value || '').toLowerCase()
      if (!n) return false
      if (n.endsWith('_log')) return true
      if (n.endsWith('_stem')) return true
      return false
    }]
  ])

  function collectInventoryStacks (opts = {}) {
    const includeArmor = opts.includeArmor === true
    const includeOffhand = opts.includeOffhand !== false
    const includeHeld = opts.includeHeld !== false
    const includeMain = opts.includeMain !== false
    const includeHotbar = opts.includeHotbar !== false
    const slots = bot.inventory?.slots || []
    const out = []
    let heldSlotIndex = null
    if (!includeHeld) {
      try {
        const quick = (typeof bot.quickBarSlot === 'number') ? bot.quickBarSlot : null
        if (quick != null) heldSlotIndex = 36 + quick
      } catch {}
    }
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i]
      if (!it) continue
      if (!includeArmor && (i === 5 || i === 6 || i === 7 || i === 8)) continue
      if (!includeOffhand && i === 45) continue
      if (heldSlotIndex != null && i === heldSlotIndex) continue
      if (!includeMain && i >= 9 && i <= 35) continue
      if (!includeHotbar && i >= 36 && i <= 44) continue
      out.push(it)
    }
    return out
  }

  function itemsMatchingName (name, opts = {}) {
    const normalized = normalizeName(name)
    const source = Array.isArray(opts.source) ? opts.source : collectInventoryStacks({
      includeArmor: opts.includeArmor === true,
      includeOffhand: opts.includeOffhand !== false,
      includeHeld: opts.includeHeld !== false,
      includeMain: opts.includeMain !== false,
      includeHotbar: opts.includeHotbar !== false
    })
    const allowPartial = opts.allowPartial !== false
    const matchers = []
    const loweredNormalized = String(normalized || '').toLowerCase()
    if (loweredNormalized) matchers.push((value) => value === loweredNormalized)
    const groupMatcher = GROUP_NAME_MATCHERS.get(loweredNormalized)
    if (groupMatcher) matchers.push(groupMatcher)
    const results = []
    const seen = new Set()
    function addResult (item) {
      if (!item) return
      if (seen.has(item)) return
      seen.add(item)
      results.push(item)
    }
    for (const it of source) {
      const itemName = String(it?.name || '').toLowerCase()
      if (!itemName) continue
      if (matchers.some(fn => fn(itemName))) addResult(it)
    }
    if (results.length || !allowPartial) return results
    if (loweredNormalized && loweredNormalized.length >= 3) {
      for (const it of source) {
        const itemName = String(it?.name || '').toLowerCase()
        if (!itemName) continue
        if (itemName.includes(loweredNormalized)) addResult(it)
      }
    }
    return results
  }

  function resolveItemByName (name) {
    const matches = itemsMatchingName(name, { includeArmor: true, includeOffhand: true, includeHeld: true })
    if (!matches.length) return null
    matches.sort((a, b) => (b.count || 0) - (a.count || 0))
    return matches[0] || null
  }

  function countItemByName (name) {
    try {
      return itemsMatchingName(name, { includeArmor: true, includeOffhand: true, includeHeld: true })
        .reduce((sum, it) => sum + (it?.count || 0), 0)
    } catch { return 0 }
  }

  function findAllByName (name) {
    return itemsMatchingName(name, { includeArmor: true, includeOffhand: true, includeHeld: true })
  }

  function bestMaterialRank (n) {
    const order = ['netherite','diamond','iron','stone','golden','wooden']
    const i = order.indexOf(String(n || '').toLowerCase())
    return i >= 0 ? i : order.length
  }

  function itemMaterial (nm) {
    const n = String(nm || '').toLowerCase()
    if (n === 'turtle_helmet') return 'turtle'
    const p = n.split('_')
    return p.length ? p[0] : null
  }

  function isPickaxeName (nm) { return String(nm || '').toLowerCase().endsWith('_pickaxe') }

  function findBestPickaxe () {
    const inv = bot.inventory?.items() || []
    const extra = []
    if (bot.heldItem) extra.push(bot.heldItem)
    const off = bot.inventory?.slots?.[45]
    if (off) extra.push(off)
    const all = inv.concat(extra)
    const picks = all.filter(it => isPickaxeName(it?.name))
    if (!picks.length) return null
    picks.sort((a, b) => bestMaterialRank(itemMaterial(a.name)) - bestMaterialRank(itemMaterial(b.name)))
    return picks[0] || null
  }

  async function ensureBestPickaxe () {
    try {
      const it = findBestPickaxe()
      if (it) {
        assertCanEquipHand(bot, it.name)
        await bot.equip(it, 'hand')
        return true
      }
    } catch (e) {
      if (e?.code === 'MAIN_HAND_LOCKED') return false
    }
    return false
  }

  async function equip (args = {}) {
    const { name, dest = 'hand' } = args
    if (!name) return fail('缺少物品名')
    const item = resolveItemByName(name)
    if (!item) return fail('背包没有该物品')
    const map = {
      hand: 'hand', 'main': 'hand', 'mainhand': 'hand',
      offhand: 'off-hand', 'off_hand': 'off-hand', 'off-hand': 'off-hand',
      head: 'head', helmet: 'head',
      chest: 'torso', body: 'torso', torso: 'torso',
      legs: 'legs', pants: 'legs',
      feet: 'feet', boots: 'feet'
    }
    const destination = map[String(dest).toLowerCase()] || 'hand'
    try {
      if (destination === 'hand') assertCanEquipHand(bot, item.name)
      await bot.equip(item, destination)
    } catch (e) {
      if (e?.code === 'MAIN_HAND_LOCKED') return fail('主手被锁定，无法切换物品')
      throw e
    }
    return ok(`已装备 ${item.name} -> ${destination}`)
  }

  async function ensureItemEquipped (name) {
    const item = resolveItemByName(name)
    if (!item) throw new Error('背包没有该物品')
    assertCanEquipHand(bot, item.name)
    await bot.equip(item, 'hand')
    return true
  }

  async function toss (args = {}) {
    // Unified interface: support single or multiple via items[]; each item spec may be by name or slot, with optional count
    // Accepted forms:
    //  - { name, count? }
    //  - { items: [{ name|slot, count? }, ...] }
    //  - { names: [string,...] }
    const arr = (() => {
      if (Array.isArray(args.items) && args.items.length) return args.items
      if (Array.isArray(args.names) && args.names.length) return args.names.map(n => ({ name: n }))
      if (args.name) return [{ name: args.name, count: args.count }]
      if (args.slot) return [{ slot: args.slot, count: args.count }]
      return null
    })()
    // Special: drop all inventory items when all=true (consistent interface, still one tool)
    if ((!arr || !arr.length) && (args.all === true || String(args.all).toLowerCase() === 'true')) {
      const equipSlots = [45, 5, 6, 7, 8]
      const slots = bot.inventory?.slots || []
      for (const idx of equipSlots) {
        const it = slots[idx]
        if (it) {
          const count = it.count != null ? it.count : 1
          await dropItemObject(it, count)
        }
      }
      const inv = bot.inventory?.items() || []
      if (bot.heldItem) inv.push(bot.heldItem)
      const off = bot.inventory?.slots?.[45]
      if (off) inv.push(off)
      const uniq = new Map()
      for (const it of inv) { if (it && it.name) uniq.set(it.name, true) }
      const exclude = new Set((Array.isArray(args.exclude) ? args.exclude : []).map(n => String(n).toLowerCase()))
      const items = Array.from(uniq.keys()).filter(n => !exclude.has(String(n).toLowerCase()))
      if (items.length === 0) return ok('背包为空')
      for (const nm of items) {
        const stacks = findAllByName(nm)
        for (const it of stacks) { const c = it.count || 0; if (c > 0) await bot.toss(it.type, null, c) }
      }
      return ok('已丢出全部物品')
    }
    if (!arr || !arr.length) return fail('缺少物品参数')

    function itemFromSlot (slot) {
      const key = String(slot).toLowerCase()
      if (key === 'hand' || key === 'main' || key === 'mainhand') return bot.heldItem || null
      if (key === 'offhand' || key === 'off-hand' || key === 'off_hand') return bot.inventory?.slots?.[45] || null
      const equipAlias = {
        head: 5, helmet: 5,
        chest: 6, torso: 6, body: 6,
        legs: 7, pants: 7,
        feet: 8, boots: 8
      }
      if (equipAlias[key] != null) {
        return bot.inventory?.slots?.[equipAlias[key]] || null
      }
      const idx = parseInt(String(slot), 10)
      if (Number.isFinite(idx) && bot.inventory?.slots) return bot.inventory.slots[idx] || null
      return null
    }

    const summary = []

    function isEquipSlot (slot) { return slot === 5 || slot === 6 || slot === 7 || slot === 8 || slot === 45 }
    async function dropItemObject (it, count) {
      try {
        const hasSlot = typeof it.slot === 'number'
        if (hasSlot && isEquipSlot(it.slot)) {
          // For equipped/offhand slots, prefer dropping the entire stack directly
          await bot.tossStack(it)
          return it.count || 1
        }
        const n = Math.max(0, Number(count != null ? count : (it.count || 0)))
        if (n <= 0) return 0
        await bot.toss(it.type, null, n)
        return n
      } catch { return 0 }
    }
    // helper: unequip armor if the requested name matches equipped piece
    async function unequipIfEquipped (nm) {
      try {
        const n = normalizeName(nm)
        const slots = bot.inventory?.slots || []
        const at = { head: slots[5]?.name || null, torso: slots[6]?.name || null, legs: slots[7]?.name || null, feet: slots[8]?.name || null }
        const map = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' }
        for (const [dest, suffix] of Object.entries(map)) {
          const cur = String(at[dest] || '').toLowerCase()
          if (cur && cur === n) { try { await bot.unequip(dest) } catch {} ; return true }
        }
      } catch {}
      return false
    }

    for (const spec of arr) {
      const cnt = (spec && spec.count != null) ? Math.max(0, Number(spec.count)) : null
      if (spec.slot) {
        const it = itemFromSlot(spec.slot)
        if (!it) { summary.push(`${spec.slot}:x0`); continue }
        const n = cnt != null ? Math.min(cnt, it.count || 0) : (it.count || 0)
        const dropped = await dropItemObject(it, n)
        const label = it.name ? normalizeName(it.name) : String(spec.slot)
        summary.push(`${label}x${dropped}`)
        continue
      }
      const nm = spec?.name
      if (!nm) { summary.push('unknown:x0'); continue }
      // If targeting equipped armor, unequip first to bring it into inventory
      await unequipIfEquipped(nm)
      const items = findAllByName(nm)
      if (!items || items.length === 0) { summary.push(`${normalizeName(nm)}x0`); continue }
      if (cnt != null) {
        // Distribute the requested count across all matching stacks
        let remaining = cnt
        let totalDropped = 0
        for (const it of items) {
          if (remaining <= 0) break
          const n = Math.min(remaining, it.count || 0)
          if (n > 0) {
            const d = await dropItemObject(it, n)
            totalDropped += d
            remaining -= d
          }
        }
        summary.push(`${normalizeName(nm)}x${totalDropped}`)
      } else {
        let total = 0
        for (const it of items) {
          const c = it.count || 0
          if (c > 0) { const d = await dropItemObject(it, c); total += d }
        }
        summary.push(`${normalizeName(nm)}x${total}`)
      }
    }
    return ok(`已丢出: ${summary.join(', ')}`)
  }

  // --- legacy chunk end ---

  register('mine_ore', mine_ore)
  register('feed_animals', feed_animals)
  register('harvest', harvest)
  register('observe_detail', observe_detail)
  register('observe_players', observe_players)
  register('skill_start', skill_start)
  register('skill_status', skill_status)
  register('skill_cancel', skill_cancel)
  register('sort_chests', sort_chests)
  register('equip', equip)
  register('toss', toss)
}
